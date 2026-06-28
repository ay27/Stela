/**
 * 搜索面板状态：缓存最近一次查询参数、结果、加载/错误态。
 *
 * 保持极简：调用方触发 `run(vaultPath, keyword, opts)`，组件订阅 `hits / loading / error`。
 * 关键字 / case sensitive 切换由组件维护本地 input state，调用 run 时一并传入。
 */

import { create } from "zustand";

import { searchVault, type SearchHit } from "@/services/search";

interface SearchState {
  keyword: string;
  caseSensitive: boolean;
  hits: SearchHit[];
  loading: boolean;
  error: string | null;
  /**
   * 当前结果是否已被外部 vault 变更标记为过期（v0.2 #7）。watcher 推送任意
   * 文件级事件时 +1；SearchPanel 顶端展示一个"重跑搜索"提示。
   */
  staleToken: number;
  reset: () => void;
  run: (
    vaultPath: string,
    keyword: string,
    options?: { caseSensitive?: boolean; maxHits?: number },
  ) => Promise<void>;
  /** watcher 接到外部变更时调一次，bump staleToken。 */
  markStale: () => void;
}

export const useSearch = create<SearchState>((set) => ({
  keyword: "",
  caseSensitive: false,
  hits: [],
  loading: false,
  error: null,
  staleToken: 0,
  reset: () =>
    set({ keyword: "", hits: [], error: null, loading: false, staleToken: 0 }),
  markStale: () => set((s) => ({ staleToken: s.staleToken + 1 })),
  async run(vaultPath, keyword, options) {
    const trimmed = keyword.trim();
    if (!trimmed) {
      set({
        keyword: "",
        hits: [],
        error: null,
        loading: false,
        staleToken: 0,
        caseSensitive: options?.caseSensitive ?? false,
      });
      return;
    }
    set({
      keyword,
      caseSensitive: options?.caseSensitive ?? false,
      loading: true,
      error: null,
      // run 完成会重置 stale；执行前先清，避免新结果出来还显示 stale
      staleToken: 0,
    });
    try {
      const hits = await searchVault(vaultPath, trimmed, options);
      set({ hits, loading: false });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
}));
