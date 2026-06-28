/**
 * 知识库向量库（`<vault>/.stela-knowledge.sqlite`）。
 *
 * 物理与权威结果集 `.stela.sqlite` 隔离：
 *   - 这里全是派生数据（chunks / vec0 / fts），可以随时整库 wipe 重建
 *   - 与权威 SQLite 解耦，避免 sync-service GC / cleanup 时误删向量
 *
 * Schema：
 *   - chunks(chunk_id PK, source_path, source_kind, ordinal, block_id, heading_slug,
 *           heading_text, content, token_count, indexed_at)
 *   - vec0_chunks(chunk_id PK, embedding FLOAT[N])  -- sqlite-vec 虚拟表
 *   - fts_chunks(chunk_id, content)                -- FTS5 虚拟表
 *   - sources(source_path PK, source_hash, last_seen)
 *   - model_meta(key PK, value)
 *
 * 加载 vec0 扩展：通过 `sqlite-vec` 包的 `getLoadablePath()` 拿到 prebuilt 路径，
 * `better-sqlite3` 的 `loadExtension` 直接 require —— 因为我们已经在
 * `better-sqlite3` 安装时通过 `electron-rebuild` 拿到了 enable_load_extension 编译选项
 * （v12.x 默认开启）。
 *
 * 维度兼容：embedder 升级会改 dim。`model_meta` 记下 model_id + dim，indexer 启动期
 * 比对：不一致就 drop `vec0_chunks` 重建（chunks 表保留，重新 embed 即可）。
 */

import path from "node:path";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";

import Database from "better-sqlite3";

import { AppError } from "@shared/errors";

import { getLogger } from "../logger";

const log = getLogger("knowledge-vec");

const KNOWLEDGE_DB_NAME = ".stela-knowledge.sqlite";

let _sqliteVec: { getLoadablePath: () => string } | null | undefined;

function getSqliteVec(): { getLoadablePath: () => string } | null {
  if (_sqliteVec !== undefined) return _sqliteVec;
  try {
    const req = createRequire(import.meta.url);
    _sqliteVec = req("sqlite-vec") as { getLoadablePath: () => string };
  } catch (err) {
    log.warn("sqlite-vec require failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    _sqliteVec = null;
  }
  return _sqliteVec;
}

export interface VectorStoreRuntime {
  db: Database.Database;
  vaultPath: string;
  embeddingDim: number;
  /** vec0 是否加载成功；false 时知识库自动降级为纯 FTS5 */
  vecLoaded: boolean;
}

export interface OpenOptions {
  vaultPath: string;
  /** 当前 embedding 维度。第一次建库或维度变化时用来 drop/rebuild vec0 表。 */
  embeddingDim: number;
  /** 当前模型 id，写入 model_meta。维度无变化但 modelId 变化时不强制清表，
   *  只标记一次 banner（embedder 侧应使用相同维度，无须重 embed）。 */
  modelId: string;
}

export function knowledgeDbPath(vaultPath: string): string {
  return path.join(vaultPath, KNOWLEDGE_DB_NAME);
}

export async function openVectorStore(
  opts: OpenOptions,
): Promise<VectorStoreRuntime> {
  await fs.mkdir(opts.vaultPath, { recursive: true }).catch(() => undefined);
  const dbPath = knowledgeDbPath(opts.vaultPath);
  let db: Database.Database;
  try {
    db = new Database(dbPath);
  } catch (err) {
    throw new AppError(
      "knowledge_db_open_failed",
      `open knowledge sqlite failed: ${(err as Error).message}`,
    );
  }
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // 尝试加载 vec0 扩展；失败时 vecLoaded=false（降级）
  let vecLoaded = false;
  const vec = getSqliteVec();
  if (vec) {
    try {
      const extPath = vec.getLoadablePath();
      db.loadExtension(extPath);
      vecLoaded = true;
      log.info("vec0 extension loaded", { extPath });
    } catch (err) {
      log.error("vec0 extension load failed (knowledge base degrades to FTS5 only)", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  createBaseTables(db);
  // 维度 / 模型 meta 比对：维度变化 → drop vec0_chunks 重建
  const meta = readModelMeta(db);
  if (vecLoaded) {
    ensureVec0Table(db, opts.embeddingDim, meta.dim);
  }
  ensureFtsTable(db);
  writeModelMeta(db, opts.modelId, opts.embeddingDim);

  return {
    db,
    vaultPath: opts.vaultPath,
    embeddingDim: opts.embeddingDim,
    vecLoaded,
  };
}

export function closeVectorStore(rt: VectorStoreRuntime | null): void {
  if (!rt) return;
  try {
    rt.db.close();
  } catch (err) {
    log.warn("knowledge db close failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

function createBaseTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      chunk_id      TEXT PRIMARY KEY,
      source_path   TEXT NOT NULL,
      source_kind   TEXT NOT NULL,
      ordinal       INTEGER NOT NULL,
      block_id      TEXT,
      heading_slug  TEXT,
      heading_text  TEXT,
      content       TEXT NOT NULL,
      token_count   INTEGER NOT NULL,
      indexed_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_source_path ON chunks(source_path);

    CREATE TABLE IF NOT EXISTS sources (
      source_path  TEXT PRIMARY KEY,
      source_hash  TEXT NOT NULL,
      last_seen    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS model_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function ensureFtsTable(db: Database.Database): void {
  // FTS5 unicode61 tokenizer：中文召回靠 dense 兜底；英文 BM25 走 FTS5。
  // remove_diacritics=2 让 "résumé" 与 "resume" 命中互通。
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks USING fts5(
      chunk_id UNINDEXED,
      content,
      tokenize='unicode61 remove_diacritics 2'
    );
  `);
}

function ensureVec0Table(
  db: Database.Database,
  desiredDim: number,
  storedDim: number | null,
): void {
  if (storedDim && storedDim !== desiredDim) {
    log.warn("embedding dim changed, dropping vec0_chunks", {
      storedDim,
      desiredDim,
    });
    db.exec(`DROP TABLE IF EXISTS vec0_chunks;`);
  }
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS vec0_chunks USING vec0(embedding FLOAT[${desiredDim}]);`,
  );
}

interface ModelMeta {
  modelId: string | null;
  dim: number | null;
}

function readModelMeta(db: Database.Database): ModelMeta {
  // table 还没建时直接返回空
  const exists = db
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name='model_meta'`,
    )
    .get();
  if (!exists) return { modelId: null, dim: null };
  const rows = db
    .prepare(`SELECT key, value FROM model_meta`)
    .all() as Array<{ key: string; value: string }>;
  let modelId: string | null = null;
  let dim: number | null = null;
  for (const r of rows) {
    if (r.key === "model_id") modelId = r.value;
    if (r.key === "embedding_dim") dim = Number.parseInt(r.value, 10) || null;
  }
  return { modelId, dim };
}

function writeModelMeta(
  db: Database.Database,
  modelId: string,
  dim: number,
): void {
  const stmt = db.prepare(
    `INSERT INTO model_meta(key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  stmt.run("model_id", modelId);
  stmt.run("embedding_dim", String(dim));
}

export interface ChunkRecord {
  chunkId: string;
  sourcePath: string;
  sourceKind: "note" | "runsql";
  ordinal: number;
  blockId: string | null;
  headingSlug: string | null;
  headingText: string | null;
  content: string;
  tokenCount: number;
}

/**
 * 把 source 的全部 chunks 原子写入。处理顺序：
 *   1. 删该 source 的旧 chunks（FK 上 vec0 没有 ON DELETE CASCADE，自己 sync）
 *   2. 插新 chunks
 *   3. 插 FTS / vec0
 *   4. 更新 sources(source_hash, last_seen)
 */
export function replaceSourceChunks(
  rt: VectorStoreRuntime,
  sourcePath: string,
  sourceHash: string,
  records: ChunkRecord[],
  embeddings: Float32Array[] | null,
): void {
  const { db } = rt;
  const now = Date.now();
  const tx = db.transaction(() => {
    // 1. 找出旧 chunk_ids，删 fts + vec
    const oldIds = db
      .prepare(`SELECT chunk_id FROM chunks WHERE source_path = ?`)
      .all(sourcePath) as Array<{ chunk_id: string }>;
    if (oldIds.length > 0) {
      const delFts = db.prepare(`DELETE FROM fts_chunks WHERE chunk_id = ?`);
      const delVec = rt.vecLoaded
        ? db.prepare(`DELETE FROM vec0_chunks WHERE rowid = ?`)
        : null;
      for (const r of oldIds) {
        delFts.run(r.chunk_id);
        if (delVec) {
          // vec0 主键是 rowid（int）；我们用 chunk_id 的整数哈希存。
          const rid = rowIdOf(r.chunk_id);
          delVec.run(rid);
        }
      }
      db.prepare(`DELETE FROM chunks WHERE source_path = ?`).run(sourcePath);
    }
    // 2. 插 chunks
    const insChunk = db.prepare(
      `INSERT INTO chunks(chunk_id, source_path, source_kind, ordinal, block_id, heading_slug, heading_text, content, token_count, indexed_at)
       VALUES (@chunkId, @sourcePath, @sourceKind, @ordinal, @blockId, @headingSlug, @headingText, @content, @tokenCount, @indexedAt)`,
    );
    const insFts = db.prepare(
      `INSERT INTO fts_chunks(chunk_id, content) VALUES (?, ?)`,
    );
    const insVec = rt.vecLoaded
      ? db.prepare(
          `INSERT INTO vec0_chunks(rowid, embedding) VALUES (?, ?)`,
        )
      : null;
    for (let i = 0; i < records.length; i += 1) {
      const r = records[i]!;
      insChunk.run({ ...r, indexedAt: now });
      insFts.run(r.chunkId, r.content);
      if (insVec && embeddings && embeddings[i]) {
        const rid = rowIdOf(r.chunkId);
        insVec.run(rid, Buffer.from(embeddings[i]!.buffer));
      }
    }
    // 3. sources upsert
    db.prepare(
      `INSERT INTO sources(source_path, source_hash, last_seen)
       VALUES (?, ?, ?)
       ON CONFLICT(source_path) DO UPDATE SET source_hash = excluded.source_hash, last_seen = excluded.last_seen`,
    ).run(sourcePath, sourceHash, now);
  });
  tx();
}

export function deleteSource(
  rt: VectorStoreRuntime,
  sourcePath: string,
): void {
  const { db } = rt;
  const tx = db.transaction(() => {
    const oldIds = db
      .prepare(`SELECT chunk_id FROM chunks WHERE source_path = ?`)
      .all(sourcePath) as Array<{ chunk_id: string }>;
    if (oldIds.length === 0) {
      db.prepare(`DELETE FROM sources WHERE source_path = ?`).run(sourcePath);
      return;
    }
    const delFts = db.prepare(`DELETE FROM fts_chunks WHERE chunk_id = ?`);
    const delVec = rt.vecLoaded
      ? db.prepare(`DELETE FROM vec0_chunks WHERE rowid = ?`)
      : null;
    for (const r of oldIds) {
      delFts.run(r.chunk_id);
      if (delVec) delVec.run(rowIdOf(r.chunk_id));
    }
    db.prepare(`DELETE FROM chunks WHERE source_path = ?`).run(sourcePath);
    db.prepare(`DELETE FROM sources WHERE source_path = ?`).run(sourcePath);
  });
  tx();
}

export interface SourceState {
  sourcePath: string;
  sourceHash: string;
  lastSeen: number;
}

export function listSources(rt: VectorStoreRuntime): SourceState[] {
  return rt.db
    .prepare(
      `SELECT source_path AS sourcePath, source_hash AS sourceHash, last_seen AS lastSeen
       FROM sources`,
    )
    .all() as SourceState[];
}

export function countChunks(rt: VectorStoreRuntime): number {
  const r = rt.db
    .prepare(`SELECT COUNT(*) AS n FROM chunks`)
    .get() as { n: number };
  return r.n;
}

export function countSources(rt: VectorStoreRuntime): number {
  const r = rt.db
    .prepare(`SELECT COUNT(*) AS n FROM sources`)
    .get() as { n: number };
  return r.n;
}

/** vec0_chunks 行数。vec0 未加载或表不存在时返回 0。 */
export function countVecRows(rt: VectorStoreRuntime): number {
  if (!rt.vecLoaded) return 0;
  try {
    const r = rt.db
      .prepare(`SELECT COUNT(*) AS n FROM vec0_chunks`)
      .get() as { n: number };
    return r.n;
  } catch {
    return 0;
  }
}

/**
 * 把所有 source_hash 置空：indexer 下一轮 fullScan 会发现 hash 不一致而
 * 重新跑 chunk + embed 流水线。
 *
 * 用途：当 embedder 之前不可用、chunks/fts 已落库但 vec0 为空时，需要触发
 * 一次"只补 embedding"的回填。当前没有"保留 chunks 只补向量"的轻量路径，
 * 暂时用 source_hash 置空触发完整重算，结果幂等。
 */
export function invalidateAllSourceHashes(rt: VectorStoreRuntime): number {
  const info = rt.db.prepare(`UPDATE sources SET source_hash = ''`).run();
  return info.changes;
}

/** 把 hex chunk_id 收敛成 64-bit signed int 当 vec0 rowid。
 *  SQLite rowid 是 signed 64-bit；我们用 hex 前 15 个字符（60 bit）裁成正整数避免溢出。
 *  碰撞概率 = 2^-60 ≈ 8e-19，对当前 vault 量级（< 10^5 chunks）可忽略。 */
export function rowIdOf(chunkId: string): bigint {
  const slice = chunkId.slice(0, 15);
  return BigInt("0x" + slice);
}

/** 查 chunk 详情（snippet / heading / path 渲染需要） */
export function getChunkDetails(
  rt: VectorStoreRuntime,
  chunkIds: string[],
): Map<string, ChunkRow> {
  if (chunkIds.length === 0) return new Map();
  const placeholders = chunkIds.map(() => "?").join(",");
  const rows = rt.db
    .prepare(
      `SELECT chunk_id AS chunkId,
              source_path AS sourcePath,
              source_kind AS sourceKind,
              ordinal,
              block_id AS blockId,
              heading_slug AS headingSlug,
              heading_text AS headingText,
              content,
              token_count AS tokenCount
       FROM chunks WHERE chunk_id IN (${placeholders})`,
    )
    .all(...chunkIds) as ChunkRow[];
  const m = new Map<string, ChunkRow>();
  for (const r of rows) m.set(r.chunkId, r);
  return m;
}

export interface ChunkRow {
  chunkId: string;
  sourcePath: string;
  sourceKind: "note" | "runsql";
  ordinal: number;
  blockId: string | null;
  headingSlug: string | null;
  headingText: string | null;
  content: string;
  tokenCount: number;
}

/** dense KNN 查询（vec0）。返回 (chunkId, distance) 列表；vec0 不可用 → 空。 */
export function knnSearch(
  rt: VectorStoreRuntime,
  embedding: Float32Array,
  topK: number,
): Array<{ chunkId: string; distance: number }> {
  if (!rt.vecLoaded) return [];
  const buf = Buffer.from(embedding.buffer);
  const rows = rt.db
    .prepare(
      `SELECT rowid AS rid, distance
       FROM vec0_chunks
       WHERE embedding MATCH ? AND k = ?
       ORDER BY distance ASC`,
    )
    .all(buf, topK) as Array<{ rid: bigint | number; distance: number }>;
  if (rows.length === 0) return [];
  // 用 rid 反查 chunk_id：vec0 我们用 rowIdOf 派生 rid，必须从 chunks 表 rowIdOf
  // 反推太贵——直接列出全部 chunk_id 与其 rid，建立 Map（chunk 量级 1e4 量级可接受）
  const ridToChunk = ridIndex(rt);
  const out: Array<{ chunkId: string; distance: number }> = [];
  for (const r of rows) {
    const cid = ridToChunk.get(BigInt(r.rid));
    if (!cid) continue;
    out.push({ chunkId: cid, distance: r.distance });
  }
  return out;
}

let cachedRidIndex: { dbPath: string; map: Map<bigint, string>; ts: number } | null =
  null;
const RID_CACHE_TTL_MS = 30_000;

function ridIndex(rt: VectorStoreRuntime): Map<bigint, string> {
  const dbPath = knowledgeDbPath(rt.vaultPath);
  if (
    cachedRidIndex &&
    cachedRidIndex.dbPath === dbPath &&
    Date.now() - cachedRidIndex.ts < RID_CACHE_TTL_MS
  ) {
    return cachedRidIndex.map;
  }
  const rows = rt.db
    .prepare(`SELECT chunk_id FROM chunks`)
    .all() as Array<{ chunk_id: string }>;
  const m = new Map<bigint, string>();
  for (const r of rows) m.set(rowIdOf(r.chunk_id), r.chunk_id);
  cachedRidIndex = { dbPath, map: m, ts: Date.now() };
  return m;
}

export function invalidateRidCache(): void {
  cachedRidIndex = null;
}

/** FTS5 BM25 查询。返回 (chunkId, bm25) 列表（bm25 越小越相关）。 */
export function ftsSearch(
  rt: VectorStoreRuntime,
  query: string,
  topK: number,
): Array<{ chunkId: string; bm25: number }> {
  const sanitized = sanitizeFtsQuery(query);
  if (!sanitized) return [];
  try {
    const rows = rt.db
      .prepare(
        `SELECT chunk_id AS chunkId, bm25(fts_chunks) AS score
         FROM fts_chunks
         WHERE fts_chunks MATCH ?
         ORDER BY score ASC
         LIMIT ?`,
      )
      .all(sanitized, topK) as Array<{ chunkId: string; score: number }>;
    return rows.map((r) => ({ chunkId: r.chunkId, bm25: r.score }));
  } catch (err) {
    log.warn("fts search failed", {
      err: err instanceof Error ? err.message : String(err),
      query: sanitized,
    });
    return [];
  }
}

/** 把用户原始 query 转成 FTS5 安全表达：去掉 MATCH 控制符，按空白拆分成 OR 查询。 */
function sanitizeFtsQuery(input: string): string {
  // FTS5 双引号包裹的 phrase 不需要逃避内部字符；这里逐 token 包裹。
  const tokens = input
    .replace(/["'`]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"`).join(" OR ");
}
