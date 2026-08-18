import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  ANALYSIS_CANVAS_EXTENSION,
  analysisCanvasSchema,
  analysisCanvasFlowLayoutPatchSchema,
  parseAnalysisCanvas,
  stringifyAnalysisCanvas,
  type AnalysisCanvas,
  type AnalysisCanvasFlowLayoutPatch,
} from "@shared/analysis-canvas";
import { AppError } from "@shared/errors";
import type { AnalysisCanvasFile } from "@shared/types";

import { atomicWriteFile } from "./atomic-write";
import { extractSqlSymbols } from "./ai/sql-symbols";
import { classifySql } from "./ai/sql-guard";
import { ensureWithinVault, pathExists } from "./vault-fs";

function etag(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function safeStem(title: string): string {
  return title.trim().replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").slice(0, 120) || "Analysis";
}

/**
 * Canvas sources are durable refresh definitions, not a place to preserve one
 * run's rows as SELECT literals. Requiring a table-backed SELECT keeps Refresh
 * meaningful and prevents a successful one-off constant query from becoming a
 * misleading data source.
 */
export function analysisCanvasSqlIssue(sql: string): string | null {
  const guard = classifySql(sql, false);
  if (guard.classification !== "read-only") {
    return guard.blockedReason ?? "Canvas SQL must be read-only.";
  }
  if (guard.keyword !== "SELECT" && guard.keyword !== "WITH") {
    return "Canvas SQL must be a table-backed SELECT query.";
  }
  const symbols = extractSqlSymbols(sql);
  const ctes = new Set(symbols.ctes.map((name) => name.toLowerCase()));
  const physicalTables = symbols.tables.filter((name) => !ctes.has(name.toLowerCase()));
  if (physicalTables.length === 0) {
    return "Canvas SQL must read a real table. Do not copy fetched values into SELECT literals, VALUES, or constant UNION rows.";
  }
  return null;
}

async function canvasTarget(vaultPath: string, candidate: string): Promise<string> {
  const target = await ensureWithinVault(vaultPath, candidate);
  if (!target.endsWith(ANALYSIS_CANVAS_EXTENSION)) throw new AppError("invalid_canvas_path", `Canvas files must end with ${ANALYSIS_CANVAS_EXTENSION}.`);
  return target;
}

export async function readAnalysisCanvas(vaultPath: string, filePath: string): Promise<AnalysisCanvasFile> {
  const target = await canvasTarget(vaultPath, filePath);
  const content = await fs.readFile(target, "utf8").catch((error: NodeJS.ErrnoException) => {
    throw new AppError(error.code === "ENOENT" ? "not_found" : "canvas_read_failed", error.message);
  });
  try {
    parseAnalysisCanvas(content);
  } catch (error) {
    throw new AppError("invalid_canvas", error instanceof Error ? error.message : String(error));
  }
  return { path: target, content, etag: etag(content) };
}

export async function createAnalysisCanvas(vaultPath: string, directory: string, title: string, sessionId?: string | null): Promise<AnalysisCanvasFile> {
  const dir = await ensureWithinVault(vaultPath, directory);
  const stem = safeStem(title);
  let target = path.join(dir, `${stem}${ANALYSIS_CANVAS_EXTENSION}`);
  for (let suffix = 1; await pathExists(target); suffix++) target = path.join(dir, `${stem} (${suffix})${ANALYSIS_CANVAS_EXTENSION}`);
  target = await canvasTarget(vaultPath, target);
  const now = Date.now();
  const canvas = analysisCanvasSchema.parse({
    kind: "stela-analysis-canvas", version: 1, id: `canvas_${randomUUID().replace(/-/g, "")}`,
    title, status: "working", createdAt: now, updatedAt: now, createdBySessionId: sessionId ?? null,
    sources: [], sections: [],
  });
  const content = stringifyAnalysisCanvas(canvas);
  await atomicWriteFile(target, content);
  return { path: target, content, etag: etag(content) };
}

export async function updateAnalysisCanvas(
  vaultPath: string,
  filePath: string,
  expectedEtag: string,
  mutate: (canvas: AnalysisCanvas) => AnalysisCanvas,
): Promise<AnalysisCanvasFile> {
  const current = await readAnalysisCanvas(vaultPath, filePath);
  if (current.etag !== expectedEtag) throw new AppError("canvas_conflict", "The Canvas changed on disk. Reload it before updating.");
  const next = analysisCanvasSchema.parse({ ...mutate(parseAnalysisCanvas(current.content)), updatedAt: Date.now() });
  const content = stringifyAnalysisCanvas(next);
  await atomicWriteFile(current.path, content);
  return { path: current.path, content, etag: etag(content) };
}

export async function updateAnalysisCanvasFlowLayout(
  vaultPath: string,
  filePath: string,
  expectedEtag: string,
  cardId: string,
  rawPatch: AnalysisCanvasFlowLayoutPatch,
): Promise<AnalysisCanvasFile> {
  const patch = analysisCanvasFlowLayoutPatchSchema.parse(rawPatch);
  const duplicateIds = new Set<string>();
  const seen = new Set<string>();
  for (const item of patch.positions) {
    if (seen.has(item.nodeId)) duplicateIds.add(item.nodeId);
    seen.add(item.nodeId);
  }
  if (duplicateIds.size > 0) throw new AppError("invalid_canvas_layout", `Duplicate flow node positions: ${[...duplicateIds].join(", ")}`);
  return updateAnalysisCanvas(vaultPath, filePath, expectedEtag, (canvas) => {
    let found = false;
    const sections = canvas.sections.map((section) => ({
      ...section,
      cards: section.cards.map((card) => {
        if (card.id !== cardId) return card;
        found = true;
        if (card.type !== "flow") throw new AppError("canvas_card_not_flow", `Canvas card ${cardId} is not a Flow card.`);
        const nodeIds = new Set(card.nodes.map((node) => node.id));
        const positions = new Map(patch.positions.map((item) => [item.nodeId, item.position]));
        for (const nodeId of positions.keys()) {
          if (!nodeIds.has(nodeId)) throw new AppError("canvas_flow_node_not_found", `Unknown Flow node: ${nodeId}`);
        }
        return {
          ...card,
          direction: patch.direction ?? card.direction,
          nodes: card.nodes.map((node) => positions.has(node.id) ? { ...node, position: positions.get(node.id)! } : node),
        };
      }),
    }));
    if (!found) throw new AppError("canvas_card_not_found", `Unknown Canvas card: ${cardId}`);
    return { ...canvas, sections };
  });
}
