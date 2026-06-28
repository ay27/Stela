/**
 * Hybrid retriever：dense KNN + FTS5 BM25 + RRF fuse。
 *
 * 设计：
 *   - dense / keyword 两路并行查 topK_each = topK * 3，给 RRF 留够候选
 *   - RRF 公式：score(c) = Σ over rankings r:  1 / (k + rank_r(c))，k=60
 *     来源 Cormack 2009；topK_each * 2 候选融合后取前 topK
 *   - 任一路查不到结果时退化为另一路（embedder 不可用时 dense=空 → 走纯 BM25）
 *   - 结果整形：附加 file path / heading / snippet / source kind / blockId
 *
 * snippet 抽取：
 *   - 命中 chunk 的 content 已经是经过 stripMarkdownNoise 的纯文本
 *   - 取前 240 字符并保留 query token 周围 ±60 字符的高亮窗口
 */

import path from "node:path";

import type {
  KnowledgeSearchHit,
  KnowledgeSearchMode,
  KnowledgeSearchOptions,
} from "@shared/types";

import { AppError } from "@shared/errors";

import { getLogger } from "../logger";
import * as embedder from "./embedder";
import * as indexer from "./indexer";
import {
  ChunkRow,
  ftsSearch,
  getChunkDetails,
  knnSearch,
} from "./vector-store";

const log = getLogger("knowledge-retriever");

const DEFAULT_TOP_K = 20;
const RRF_K = 60;
const PER_ROUTE_FAN_OUT = 3;
const SNIPPET_MAX_CHARS = 240;
const SNIPPET_RADIUS = 90;

/**
 * Hybrid 检索入口。embedder/vec0 不可用时自动降级为纯 BM25。
 *
 * @throws AppError("no_vault" | "knowledge_not_ready")
 */
export async function search(
  query: string,
  options: KnowledgeSearchOptions = {},
): Promise<KnowledgeSearchHit[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const store = indexer.getStore();
  const vaultPath = indexer.getVaultPath();
  if (!store || !vaultPath) {
    throw new AppError(
      "knowledge_not_ready",
      "knowledge base not opened; ensure a vault is selected",
    );
  }
  const topK = Math.min(Math.max(1, options.topK ?? DEFAULT_TOP_K), 100);
  const fanOut = topK * PER_ROUTE_FAN_OUT;
  const requestedMode: KnowledgeSearchMode = options.mode ?? "hybrid";
  // 选定有效路径：embedder/vec 不可用时 hybrid/dense → keyword
  const effectiveMode: KnowledgeSearchMode = !store.vecLoaded || !embedder.isAvailable()
    ? "keyword"
    : requestedMode;

  let dense: Array<{ chunkId: string; distance: number }> = [];
  let keyword: Array<{ chunkId: string; bm25: number }> = [];

  if (effectiveMode === "dense" || effectiveMode === "hybrid") {
    const qvec = await embedder.embedQuery(trimmed);
    if (qvec) dense = knnSearch(store, qvec, fanOut);
  }
  if (effectiveMode === "keyword" || effectiveMode === "hybrid") {
    keyword = ftsSearch(store, trimmed, fanOut);
  }

  if (dense.length === 0 && keyword.length === 0) {
    log.info("knowledge search empty", { query: trimmed, mode: effectiveMode });
    return [];
  }

  const fused = rrfFuse(dense, keyword, topK);
  const ids = fused.map((f) => f.chunkId);
  const details = getChunkDetails(store, ids);
  const denseMap = new Map(dense.map((d) => [d.chunkId, d.distance]));
  const keywordMap = new Map(keyword.map((d) => [d.chunkId, d.bm25]));

  const out: KnowledgeSearchHit[] = [];
  for (const f of fused) {
    const row = details.get(f.chunkId);
    if (!row) continue;
    const snippet = makeSnippet(row.content, trimmed);
    out.push({
      chunkId: row.chunkId,
      sourcePath: row.sourcePath,
      relPath: toRel(row.sourcePath, vaultPath),
      title: deriveTitle(row),
      headingSlug: row.headingSlug,
      headingText: row.headingText,
      sourceKind: row.sourceKind,
      blockId: row.blockId,
      snippet,
      score: f.score,
      distance: denseMap.get(f.chunkId) ?? null,
      bm25: keywordMap.get(f.chunkId) ?? null,
    });
  }
  return out;
}

interface RrfHit {
  chunkId: string;
  score: number;
}

export function rrfFuse(
  dense: Array<{ chunkId: string; distance: number }>,
  keyword: Array<{ chunkId: string; bm25: number }>,
  topK: number,
): RrfHit[] {
  const scores = new Map<string, number>();
  for (let i = 0; i < dense.length; i += 1) {
    const id = dense[i]!.chunkId;
    scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + i + 1));
  }
  for (let i = 0; i < keyword.length; i += 1) {
    const id = keyword[i]!.chunkId;
    scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + i + 1));
  }
  return Array.from(scores.entries())
    .map(([chunkId, score]) => ({ chunkId, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

function toRel(absPath: string, vaultPath: string): string {
  return path.relative(vaultPath, absPath).replace(/\\/g, "/");
}

function deriveTitle(row: ChunkRow): string {
  // chunker 没把 title 写进每个 chunk；用 path basename 近似
  const base = path.basename(row.sourcePath);
  return base.replace(/\.(md|mdstela)$/i, "") || base;
}

function makeSnippet(content: string, query: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  if (flat.length <= SNIPPET_MAX_CHARS) return flat;
  const lower = flat.toLowerCase();
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);
  let center = -1;
  for (const tok of tokens) {
    const idx = lower.indexOf(tok);
    if (idx >= 0) {
      center = idx;
      break;
    }
  }
  if (center < 0) {
    return flat.slice(0, SNIPPET_MAX_CHARS) + "…";
  }
  const start = Math.max(0, center - SNIPPET_RADIUS);
  const end = Math.min(flat.length, center + SNIPPET_RADIUS);
  let s = "";
  if (start > 0) s += "…";
  s += flat.slice(start, end);
  if (end < flat.length) s += "…";
  return s;
}
