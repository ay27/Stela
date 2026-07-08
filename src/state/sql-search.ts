/**
 * SearchPanel「SQL 模式」状态。
 *
 * 三层结构化筛选（操作 读/写 → 表名 → 列名），任意一层选定后即可查询；
 * 直接派生确定性 `SqlIndexFilter` 交给 `sql-index.query` 求交集。
 *
 * 注：曾经有过"自然语言 → AI 翻译成 chips"的路径，因准确率不足已下线，
 * 只保留这套结构化筛选（AI 侧的 `ai.parseSqlQuery` IPC 仍在，未来准确率
 * 提升后可以再接回来）。
 */

import { create } from "zustand";

import {
  onSqlIndexChanged,
  querySqlIndex,
  sqlIndexFacets,
  sqlIndexStatus,
  type SqlIndexFacets,
  type SqlIndexFilter,
  type SqlIndexHit,
  type SqlIndexStatus,
} from "@/services/sql-index";

export type SqlOpKind = "read" | "write";

function buildFilter(opKind: SqlOpKind, table: string, column: string): SqlIndexFilter | null {
  const t = table.trim();
  const c = column.trim();
  if (!t) return null;
  if (opKind === "read") return { readTable: t };
  if (c) return { writeColumn: { table: t, column: c } };
  return { writeTable: t };
}

interface SqlSearchState {
  opKind: SqlOpKind;
  table: string;
  column: string;
  hits: SqlIndexHit[];
  facets: SqlIndexFacets | null;
  status: SqlIndexStatus;
  loading: boolean;
  error: string | null;
  staleToken: number;
  /** 是否已经真正发起过查询（用于区分"还没搜"和"搜了没结果"两种空态文案） */
  hasSearched: boolean;

  setOpKind: (kind: SqlOpKind) => void;
  setTable: (table: string) => void;
  setColumn: (column: string) => void;
  search: () => Promise<void>;
  clear: () => void;
  runQuery: () => Promise<void>;
  loadFacets: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  markStale: () => void;
}

export const useSqlSearch = create<SqlSearchState>((set, get) => ({
  opKind: "write",
  table: "",
  column: "",
  hits: [],
  facets: null,
  status: { state: "idle", processedFiles: 0, totalFiles: 0, blockCount: 0, error: null },
  loading: false,
  error: null,
  staleToken: 0,
  hasSearched: false,

  setOpKind: (opKind) => {
    set((s) => ({ opKind, column: opKind === "read" ? "" : s.column }));
    if (get().table.trim() !== "") void get().runQuery();
  },

  setTable: (table) => set({ table }),
  setColumn: (column) => set({ column }),

  async search() {
    await get().runQuery();
  },

  clear: () =>
    set({
      opKind: "write",
      table: "",
      column: "",
      hits: [],
      error: null,
      staleToken: 0,
      hasSearched: false,
    }),

  async runQuery() {
    const { opKind, table, column } = get();
    const filter = buildFilter(opKind, table, column);
    if (!filter) {
      set({ hits: [], loading: false, staleToken: 0, hasSearched: false });
      return;
    }
    set({ loading: true, error: null, staleToken: 0, hasSearched: true });
    try {
      const hits = await querySqlIndex(filter);
      set({ hits, loading: false });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  async loadFacets() {
    try {
      const facets = await sqlIndexFacets();
      set({ facets });
    } catch {
      // facets 只用于自动补全，静默失败即可，不影响主检索路径
    }
  },

  async refreshStatus() {
    try {
      const status = await sqlIndexStatus();
      set({ status });
    } catch {
      // 忽略：状态条只是进度提示
    }
  },

  markStale: () => set((s) => ({ staleToken: s.staleToken + 1 })),
}));

let unsubscribeChanged: (() => void) | null = null;

/**
 * 订阅 main 推送的 SQL 索引状态变化：building→ready 时刷新 facets/status，
 * 索引就绪后再有增量更新则把当前结果标 stale（对齐 useSearch.markStale 的
 * 提示模式），由用户点击「重跑」。
 */
export function installSqlIndexSubscriber(): () => void {
  if (unsubscribeChanged) {
    unsubscribeChanged();
    unsubscribeChanged = null;
  }
  unsubscribeChanged = onSqlIndexChanged(() => {
    void useSqlSearch.getState().refreshStatus();
    void useSqlSearch.getState().loadFacets();
    if (useSqlSearch.getState().table.trim() !== "") {
      useSqlSearch.getState().markStale();
    }
  });
  return () => {
    if (unsubscribeChanged) {
      unsubscribeChanged();
      unsubscribeChanged = null;
    }
  };
}
