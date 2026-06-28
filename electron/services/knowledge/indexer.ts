/**
 * 增量索引器。
 *
 * 触发源：
 *   1. start(vaultPath) 启动期 → 全 vault 扫一遍，与 sources 表 diff
 *      `source_hash` 一致即跳过，不一致重算，孤儿删除
 *   2. vault-watcher 推送的 changed / added / removed → 单文件 / 单删除
 *
 * 一旦进入 disabled embedder 路径（onnxruntime 缺失），indexer 仍写 chunks + fts，
 * 只是不写 vec0；retriever 检测到 vec0 为空时退化为纯 BM25。
 *
 * 并发：indexer 维护一个串行队列，每批 EMBED_BATCH_LIMIT 个 chunk 走 embedPassages。
 * 这避免 ANE/Metal 并发争抢，也避免 sqlite-vec 单线程瓶颈。
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { getLogger } from "../logger";
import * as vaultWatcher from "../vault-watcher";
import {
  ChunkInput,
  chunkSource,
  extractRunsqlBlocks,
  hashSourceContent,
} from "./chunker";
import * as embedder from "./embedder";
import {
  ChunkRecord,
  SourceState,
  VectorStoreRuntime,
  countChunks,
  countSources,
  countVecRows,
  deleteSource,
  invalidateAllSourceHashes,
  invalidateRidCache,
  listSources,
  openVectorStore,
  replaceSourceChunks,
} from "./vector-store";

const log = getLogger("knowledge-indexer");

/** 与 vault-index 同步：跳过 4MB 以上的 markdown。 */
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const SUPPORTED_EXTS = new Set([".md"]);

interface IndexerRuntime {
  vaultPath: string;
  store: VectorStoreRuntime;
  unsubscribe: () => void;
  /** 排队待处理的源文件绝对路径。flush 在串行 worker 里逐一吃。 */
  queue: Set<string>;
  /** 删除事件：在 flush 时按这份集合 deleteSource。 */
  pendingDeletes: Set<string>;
  workerRunning: boolean;
  /** 首次全扫 promise（启动期 retriever / status 可以 await） */
  scanReady: Promise<void>;
  indexing: boolean;
  lastError: string | null;
}

let runtime: IndexerRuntime | null = null;
let setupInFlight: Promise<void> | null = null;
/**
 * "已 attach 但被禁用" 的 vault path。
 *
 * RAG 关闭时不打开 db / 不启动 worker，但仍记下当前 vault 让 status 报告
 * `enabled=false` + `dbPath=<候选路径>`，UI 可以显示"知识库已关闭"banner。
 * 开关切到 true 时，settings handler 会重新调 `start(vaultPath, {enabled:true})`。
 */
let disabledVaultPath: string | null = null;

export interface IndexerStatusSnapshot {
  enabled: boolean;
  ready: boolean;
  dbPath: string | null;
  modelId: string | null;
  embeddingDim: number;
  embeddingsAvailable: boolean;
  totalChunks: number;
  totalSources: number;
  indexing: boolean;
  pendingSources: number;
  lastError: string | null;
}

export function snapshot(): IndexerStatusSnapshot {
  if (!runtime) {
    return {
      enabled: false,
      ready: false,
      dbPath: disabledVaultPath
        ? path.join(disabledVaultPath, ".stela-knowledge.sqlite")
        : null,
      modelId: embedder.currentModelId(),
      embeddingDim: embedder.currentDim(),
      embeddingsAvailable: false,
      totalChunks: 0,
      totalSources: 0,
      indexing: false,
      pendingSources: 0,
      lastError: null,
    };
  }
  return {
    enabled: true,
    ready: true,
    dbPath: path.join(runtime.vaultPath, ".stela-knowledge.sqlite"),
    modelId: embedder.currentModelId(),
    embeddingDim: runtime.store.embeddingDim,
    embeddingsAvailable: embedder.isAvailable() && runtime.store.vecLoaded,
    totalChunks: countChunks(runtime.store),
    totalSources: countSources(runtime.store),
    indexing: runtime.indexing,
    pendingSources: runtime.queue.size + runtime.pendingDeletes.size,
    lastError: runtime.lastError ?? embedder.getLastError(),
  };
}

export function getStore(): VectorStoreRuntime | null {
  return runtime?.store ?? null;
}

export function getVaultPath(): string | null {
  return runtime?.vaultPath ?? disabledVaultPath;
}

/** RAG 是否处于启用状态（runtime 已就绪即视为 enabled）。 */
export function isEnabled(): boolean {
  return runtime !== null;
}

export interface IndexerStartOptions {
  /** 见 {@link knowledge.StartOptions.enabled}。默认 false。 */
  enabled?: boolean;
}

/**
 * 启动针对 vaultPath 的索引器。
 *
 * - `options.enabled = true` 才真正打开 embedder / db / watcher
 * - `options.enabled = false` 仅把 disabledVaultPath 记下，status 报 enabled=false
 *
 * 失败不致命：log + lastError，整个知识库进入 disabled 状态，UI 可见。
 */
export async function start(
  vaultPath: string | null,
  options: IndexerStartOptions = {},
): Promise<void> {
  if (setupInFlight) await setupInFlight;
  await stop();
  if (!vaultPath) {
    disabledVaultPath = null;
    return;
  }
  if (options.enabled !== true) {
    disabledVaultPath = vaultPath;
    log.info("knowledge indexer attach (disabled)", { vaultPath });
    return;
  }
  disabledVaultPath = null;
  setupInFlight = doStart(vaultPath).catch((err) => {
    log.error("knowledge indexer start failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  });
  await setupInFlight;
  setupInFlight = null;
}

async function doStart(vaultPath: string): Promise<void> {
  // 先尝试加载 embedder；失败 → embedder disabled，store 走 dim=0 路径仍能起
  await embedder.ensureLoaded();
  const dim = embedder.currentDim() || 384;
  const store = await openVectorStore({
    vaultPath,
    embeddingDim: dim,
    modelId: embedder.currentModelId(),
  });
  // vec0 回填检测：如果 embedder + vec0 当前都可用，但 vec0 行数明显落后于
  // chunks 行数，说明上一轮启动期 embedder 不可用、走了降级路径（只写 chunks +
  // fts）。此时必须把 source_hash 抹掉，强制 fullScan worker 重新跑 embed，
  // 否则 dense 路径永远空、用户感知为"中文搜索几乎全 miss"（FTS5 unicode61
  // 对 CJK 召回非常弱）。
  if (store.vecLoaded && embedder.isAvailable()) {
    const chunkN = countChunks(store);
    const vecN = countVecRows(store);
    if (chunkN > 0 && vecN < chunkN) {
      const touched = invalidateAllSourceHashes(store);
      log.warn(
        "vec0 backfill triggered: invalidating source hashes for re-embed",
        { chunkN, vecN, sourcesTouched: touched },
      );
    }
  }
  const rt: IndexerRuntime = {
    vaultPath,
    store,
    unsubscribe: () => {},
    queue: new Set(),
    pendingDeletes: new Set(),
    workerRunning: false,
    scanReady: Promise.resolve(),
    indexing: false,
    lastError: null,
  };
  rt.unsubscribe = vaultWatcher.subscribe((payload) => {
    if (!runtime || runtime.vaultPath !== payload.vaultPath) return;
    onWatchBatch(runtime, payload.events);
  });
  runtime = rt;
  rt.scanReady = fullScan(rt).catch((err) => {
    rt.lastError = err instanceof Error ? err.message : String(err);
    log.error("knowledge full scan failed", { err: rt.lastError });
  });
  // worker 由 scanReady 隐式触发（fullScan 内部 enqueue 并 kick worker）
}

export async function stop(): Promise<void> {
  if (!runtime) return;
  const rt = runtime;
  runtime = null;
  try {
    rt.unsubscribe();
  } catch {
    /* noop */
  }
  try {
    rt.store.db.close();
  } catch (err) {
    log.warn("knowledge db close failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
  invalidateRidCache();
}

function onWatchBatch(
  rt: IndexerRuntime,
  events: Array<{ type: string; path: string; isDir: boolean }>,
): void {
  for (const ev of events) {
    if (ev.isDir) continue;
    const ext = path.extname(ev.path).toLowerCase();
    if (!SUPPORTED_EXTS.has(ext)) continue;
    if (ev.type === "removed") {
      rt.pendingDeletes.add(ev.path);
      rt.queue.delete(ev.path);
    } else {
      rt.queue.add(ev.path);
      rt.pendingDeletes.delete(ev.path);
    }
  }
  kickWorker(rt);
}

/** 全 vault 扫描：写入 queue + 删除孤儿。 */
async function fullScan(rt: IndexerRuntime): Promise<void> {
  const startTs = Date.now();
  const currentPaths = new Set<string>();
  for await (const file of walkMarkdown(rt.vaultPath)) {
    currentPaths.add(file);
    rt.queue.add(file);
  }
  // 孤儿：sources 中存在但 walk 没有
  const stored = listSources(rt.store);
  for (const s of stored) {
    if (!currentPaths.has(s.sourcePath)) {
      rt.pendingDeletes.add(s.sourcePath);
    }
  }
  log.info("knowledge full scan done", {
    files: currentPaths.size,
    deletes: rt.pendingDeletes.size,
    elapsedMs: Date.now() - startTs,
  });
  kickWorker(rt);
}

async function* walkMarkdown(root: string): AsyncGenerator<string> {
  const stack: Array<{ dir: string; depth: number }> = [
    { dir: root, depth: 0 },
  ];
  while (stack.length > 0) {
    const top = stack.pop()!;
    const { dir, depth } = top;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const name = ent.name;
      if (depth > 0 && name.startsWith(".")) continue;
      if (
        name === "node_modules" ||
        name === "target" ||
        name === "dist" ||
        name === "build" ||
        name === "__pycache__"
      ) {
        continue;
      }
      const full = path.join(dir, name);
      if (ent.isDirectory()) {
        stack.push({ dir: full, depth: depth + 1 });
      } else if (ent.isFile()) {
        const ext = path.extname(name).toLowerCase();
        if (SUPPORTED_EXTS.has(ext)) yield full;
      }
    }
  }
}

function kickWorker(rt: IndexerRuntime): void {
  if (rt.workerRunning) return;
  rt.workerRunning = true;
  rt.indexing = rt.queue.size + rt.pendingDeletes.size > 0;
  void runWorker(rt).finally(() => {
    rt.workerRunning = false;
    rt.indexing = rt.queue.size + rt.pendingDeletes.size > 0;
  });
}

async function runWorker(rt: IndexerRuntime): Promise<void> {
  // 先处理删除（轻量）
  for (const p of Array.from(rt.pendingDeletes)) {
    if (runtime !== rt) return;
    try {
      deleteSource(rt.store, p);
    } catch (err) {
      log.warn("knowledge delete failed", {
        path: p,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    rt.pendingDeletes.delete(p);
  }
  invalidateRidCache();

  // 再处理需要重算的源；按 EMBED_BATCH_LIMIT 攒批 embed
  const sourceState = new Map<string, SourceState>();
  for (const s of listSources(rt.store)) sourceState.set(s.sourcePath, s);

  const knownHashSkip = new Set<string>();
  const queuedTotal = rt.queue.size;
  let processed = 0;
  let reindexed = 0;
  const workerStartedAt = Date.now();
  if (queuedTotal > 0) {
    log.info("knowledge worker start", { queued: queuedTotal });
  }
  for (const p of Array.from(rt.queue)) {
    if (runtime !== rt) return;
    rt.queue.delete(p);
    processed += 1;
    try {
      const stat = await fs.stat(p).catch(() => null);
      if (!stat || !stat.isFile()) {
        try {
          deleteSource(rt.store, p);
        } catch {
          /* noop */
        }
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) continue;
      const content = await fs.readFile(p, "utf-8");
      const hash = hashSourceContent(content);
      const prev = sourceState.get(p);
      if (prev && prev.sourceHash === hash) {
        knownHashSkip.add(p);
        continue;
      }
      const relPath = toRel(p, rt.vaultPath);
      if (!relPath) continue;
      const input: ChunkInput = {
        relPath,
        content,
        runsqlBlocks: extractRunsqlBlocks(content),
      };
      const chunks = chunkSource(input);
      let embeddings: Float32Array[] | null = null;
      if (chunks.length > 0 && rt.store.vecLoaded && embedder.isAvailable()) {
        embeddings = [];
        const texts = chunks.map((c) => c.content);
        // 分批 embed
        for (let i = 0; i < texts.length; i += embedder.EMBED_BATCH_LIMIT) {
          const slice = texts.slice(i, i + embedder.EMBED_BATCH_LIMIT);
          const got = await embedder.embedPassages(slice);
          if (!got) {
            embeddings = null;
            break;
          }
          embeddings.push(...got);
        }
      }
      const records: ChunkRecord[] = chunks.map((c) => ({
        chunkId: c.chunkId,
        sourcePath: p,
        sourceKind: c.sourceKind,
        ordinal: c.ordinal,
        blockId: c.blockId,
        headingSlug: c.headingSlug,
        headingText: c.headingText,
        content: c.content,
        tokenCount: c.tokenCount,
      }));
      replaceSourceChunks(rt.store, p, hash, records, embeddings);
      invalidateRidCache();
      reindexed += 1;
      // per-source debug 行：默认 STELA_LOG_LEVEL=info 不会打，但出 crash 时
      // 用户加 STELA_LOG_LEVEL=debug 可以重现并定位最后一条成功的 source。
      log.debug("knowledge source indexed", {
        relPath,
        chunks: chunks.length,
        embedded: embeddings?.length ?? 0,
      });
      // 进度行：每 25 个 source 打一条，定位 silent crash 时的"最后已知位置"
      if (reindexed % 25 === 0) {
        log.info("knowledge worker progress", {
          processed,
          reindexed,
          remaining: rt.queue.size,
          lastPath: relPath,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      rt.lastError = msg;
      log.error("knowledge index source failed", { path: p, err: msg });
    }
  }
  if (queuedTotal > 0) {
    log.info("knowledge worker done", {
      processed,
      reindexed,
      skipped: knownHashSkip.size,
      elapsedMs: Date.now() - workerStartedAt,
    });
  }
  if (rt.queue.size === 0 && rt.pendingDeletes.size === 0) {
    rt.lastError = null;
  }
}

function toRel(absPath: string, vaultPath: string): string | null {
  const rel = path.relative(vaultPath, absPath).replace(/\\/g, "/");
  if (!rel || rel.startsWith("..")) return null;
  return rel;
}

/**
 * 公共 API：等待首次 full scan 完成（用于启动期 retriever / status）。
 * 已无 runtime 时直接 resolve。
 */
export async function awaitScanReady(): Promise<void> {
  if (!runtime) return;
  await runtime.scanReady;
}

/**
 * 立即清空索引并重建。
 * - 关掉 runtime → 删 db 文件 → 重新 start（enabled=true）
 * - 期间任何 search 调用都会拿到 ready=false 的 status；UI 应展示 progress
 * - RAG 关闭时 noop（强制要求先在 Settings 启用，避免误触发后台索引）
 */
export async function rebuild(): Promise<void> {
  const rt = runtime;
  if (!rt) return;
  const vaultPath = rt.vaultPath;
  await stop();
  embedder.disposeEmbedder();
  const dbPath = path.join(vaultPath, ".stela-knowledge.sqlite");
  for (const suffix of ["", "-wal", "-shm"]) {
    await fs.unlink(dbPath + suffix).catch(() => undefined);
  }
  await start(vaultPath, { enabled: true });
}

/**
 * 删库不重建：清理本地空间用。
 *
 * 注意：RAG 关闭时（runtime=null 但 disabledVaultPath 有值）也允许 purge，
 * 这正是用户"我把开关关掉，再清理掉所有派生数据"的场景。
 */
export async function purge(): Promise<void> {
  const vaultPath = runtime?.vaultPath ?? disabledVaultPath;
  if (!vaultPath) return;
  const wasEnabled = runtime !== null;
  await stop();
  const dbPath = path.join(vaultPath, ".stela-knowledge.sqlite");
  for (const suffix of ["", "-wal", "-shm"]) {
    await fs.unlink(dbPath + suffix).catch(() => undefined);
  }
  // purge 不改 enabled 状态：之前在跑就还在 disabled vault attach 状态
  if (!wasEnabled) {
    disabledVaultPath = vaultPath;
  }
}
