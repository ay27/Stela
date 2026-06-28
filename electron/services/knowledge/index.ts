/**
 * Knowledge base service 统一出口。
 *
 * 这里只汇集 indexer / retriever / status 的 public API，避免 handlers.ts 直接 import 内部
 * 模块；同时把 vault-context 的 start/stop 钩子集中。
 */

import type {
  KnowledgeStatus,
  KnowledgeSearchHit,
  KnowledgeSearchOptions,
} from "@shared/types";

import * as indexer from "./indexer";
import * as retriever from "./retriever";

export interface StartOptions {
  /**
   * 是否启用 RAG。
   * - true：正常 start，加载 embedder + 打开 vec store + 启动 watcher
   * - false：仅记录 vault path 让 status 返回 enabled=false；不开 embedder /
   *   不写 db / 不订阅 watcher。已存在的 `.stela-knowledge.sqlite` 保留。
   *
   * 默认 false（与 `AppSettings.knowledge.enabled` 默认值一致）。
   */
  enabled?: boolean;
}

export async function start(
  vaultPath: string | null,
  options: StartOptions = {},
): Promise<void> {
  await indexer.start(vaultPath, { enabled: options.enabled === true });
}

export async function stop(): Promise<void> {
  await indexer.stop();
}

export async function rebuild(): Promise<void> {
  await indexer.rebuild();
}

export async function purge(): Promise<void> {
  await indexer.purge();
}

export function status(): KnowledgeStatus {
  const s = indexer.snapshot();
  return {
    enabled: s.enabled,
    ready: s.ready,
    dbPath: s.dbPath,
    modelId: s.modelId,
    embeddingDim: s.embeddingDim,
    embeddingsAvailable: s.embeddingsAvailable,
    totalChunks: s.totalChunks,
    totalSources: s.totalSources,
    indexing: s.indexing,
    pendingSources: s.pendingSources,
    lastError: s.lastError,
  };
}

export async function search(
  query: string,
  options?: KnowledgeSearchOptions,
): Promise<KnowledgeSearchHit[]> {
  // RAG 关闭时直接短路；不进 retriever（retriever 内部 throw 不利于 UI 体感）
  if (!indexer.isEnabled()) return [];
  return retriever.search(query, options);
}

export const __testing = {
  indexer,
  retriever,
};
