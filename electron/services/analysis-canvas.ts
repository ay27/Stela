import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  ANALYSIS_CANVAS_EXTENSION,
  analysisCanvasSchema,
  parseAnalysisCanvas,
  stringifyAnalysisCanvas,
  type AnalysisCanvas,
} from "@shared/analysis-canvas";
import { AppError } from "@shared/errors";
import type { AnalysisCanvasFile, AnalysisCanvasRefreshResult, QueryResult, RunRecord } from "@shared/types";

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

export interface CanvasRefreshDeps {
  execute(connectionName: string, sql: string): Promise<QueryResult>;
  record(record: RunRecord, result: QueryResult | null): Promise<void>;
}

export async function refreshAnalysisCanvasSource(
  vaultPath: string,
  filePath: string,
  expectedEtag: string,
  sourceId: string,
  deps: CanvasRefreshDeps,
): Promise<AnalysisCanvasRefreshResult> {
  const loaded = await readAnalysisCanvas(vaultPath, filePath);
  if (loaded.etag !== expectedEtag) throw new AppError("canvas_conflict", "The Canvas changed on disk. Reload it before refreshing.");
  const canvas = parseAnalysisCanvas(loaded.content);
  const source = canvas.sources.find((item) => item.id === sourceId);
  if (!source) throw new AppError("canvas_source_not_found", `Unknown Canvas source: ${sourceId}`);
  const sqlIssue = analysisCanvasSqlIssue(source.sql);
  if (sqlIssue) throw new AppError("canvas_sql_blocked", sqlIssue);
  const runId = `canvas_${randomUUID()}`;
  const startedAt = Date.now();
  try {
    const result = await deps.execute(source.connectionName, source.sql);
    const record: RunRecord = { runId, blockId: `canvas:${canvas.id}:${source.id}`, sql: source.sql, status: "ok", message: null, startedAt, elapsedMs: result.elapsedMs, rowCount: result.kind === "query" ? result.rows.length : 0, connectionName: source.connectionName, notePath: loaded.path };
    await deps.record(record, result);
    const next = await updateAnalysisCanvas(vaultPath, loaded.path, loaded.etag, (value) => ({ ...value, sources: value.sources.map((item) => item.id === sourceId ? { ...item, lastRunId: runId, lastRunAt: startedAt, lastError: null } : item) }));
    return { ...next, sourceId, ok: true, runId, message: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const record: RunRecord = { runId, blockId: `canvas:${canvas.id}:${source.id}`, sql: source.sql, status: "err", message, startedAt, elapsedMs: Date.now() - startedAt, rowCount: 0, connectionName: source.connectionName, notePath: loaded.path };
    await deps.record(record, null).catch(() => {});
    const next = await updateAnalysisCanvas(vaultPath, loaded.path, loaded.etag, (value) => ({ ...value, sources: value.sources.map((item) => item.id === sourceId ? { ...item, lastError: { message, attemptedAt: Date.now() } } : item) }));
    return { ...next, sourceId, ok: false, runId, message };
  }
}
