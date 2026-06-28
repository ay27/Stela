/**
 * 知识库面板状态（Zustand）。
 *
 * 缓存最近一次查询参数 + 结果 + status；面板 UI 订阅。
 * status 由 main 进程 indexer 提供，需 poll（vault-watcher 推送的事件目前
 * 没有专门的 KNOWLEDGE_CHANGED 广播；用户面板打开时按需 poll 即可，
 * 避免常驻订阅给 idle vault 带来 cost）。
 */

import { create } from "zustand";

import type {
  KnowledgeSearchHit,
  KnowledgeSearchMode,
  KnowledgeStatus,
} from "@shared/types";

const DEFAULT_STATUS: KnowledgeStatus = {
  enabled: false,
  ready: false,
  dbPath: null,
  modelId: null,
  embeddingDim: 0,
  embeddingsAvailable: false,
  totalChunks: 0,
  totalSources: 0,
  indexing: false,
  pendingSources: 0,
  lastError: null,
};

interface KnowledgeState {
  query: string;
  mode: KnowledgeSearchMode;
  hits: KnowledgeSearchHit[];
  loading: boolean;
  error: string | null;
  status: KnowledgeStatus;

  setQuery: (q: string) => void;
  setMode: (m: KnowledgeSearchMode) => void;
  reset: () => void;
  search: (
    q: string,
    options?: { mode?: KnowledgeSearchMode; topK?: number },
  ) => Promise<void>;
  refreshStatus: () => Promise<void>;
  rebuild: () => Promise<void>;
  purge: () => Promise<void>;
}

export const useKnowledge = create<KnowledgeState>((set, get) => ({
  query: "",
  mode: "hybrid",
  hits: [],
  loading: false,
  error: null,
  status: DEFAULT_STATUS,

  setQuery: (q) => set({ query: q }),
  setMode: (m) => set({ mode: m }),
  reset: () =>
    set({
      query: "",
      hits: [],
      loading: false,
      error: null,
    }),

  async search(q, options) {
    const trimmed = q.trim();
    set({ query: q });
    if (!trimmed) {
      set({ hits: [], loading: false, error: null });
      return;
    }
    set({ loading: true, error: null });
    try {
      const hits = await window.stela.knowledge.search(trimmed, {
        mode: options?.mode ?? get().mode,
        topK: options?.topK,
      });
      set({ hits, loading: false });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  async refreshStatus() {
    try {
      const raw = await window.stela.knowledge.getStatus();
      // 兜底 main / renderer 异步重启导致缺新字段（如 enabled）的边界情况；
      // 用 DEFAULT_STATUS 把缺失字段补成 false / 0 / null，避免 UI 读 undefined 崩。
      set({ status: { ...DEFAULT_STATUS, ...raw } });
    } catch (err) {
      console.error("[stela] knowledge.getStatus failed", err);
    }
  },

  async rebuild() {
    try {
      await window.stela.knowledge.rebuild();
    } finally {
      void get().refreshStatus();
    }
  },

  async purge() {
    try {
      await window.stela.knowledge.purge();
    } finally {
      void get().refreshStatus();
    }
  },
}));
