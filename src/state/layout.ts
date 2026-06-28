/**
 * 全局布局状态 store。
 *
 * 用途：让快捷键层（`src/lib/hotkeys.ts`）能跨组件树操作 Sidebar：
 *   - 折叠 / 展开 Sidebar（Mod+B）
 *   - 把 Sidebar 切到 "search" 模式并请求 input 聚焦（Mod+Shift+F）
 *   - 记住用户拖拽出的 sidebar 宽度（localStorage 持久化，不经 Rust 设置仓，避免
 *     每次拖拽都跨进程写文件）
 *
 * `searchFocusToken` 采用 "递增 counter" 模式：每次递增时触发 SearchPanel 的
 * `useEffect([focusToken])`，就算已经在 search 模式也会重新 focus。
 */

import { create } from "zustand";

export type SidebarMode = "files" | "search" | "semantic" | "schema" | "runs";

/** 侧栏宽度限制（px）。min 受限于 FileTree 文件名最短可读宽度，max 防止吞掉主区。 */
export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 480;
export const SIDEBAR_DEFAULT_WIDTH = 260;

const STORAGE_KEY_WIDTH = "stela.layout.sidebarWidth";

function clampWidth(w: number): number {
  if (!Number.isFinite(w)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(w)));
}

function loadInitialWidth(): number {
  if (typeof window === "undefined") return SIDEBAR_DEFAULT_WIDTH;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY_WIDTH);
    if (raw == null) return SIDEBAR_DEFAULT_WIDTH;
    const n = Number(raw);
    if (!Number.isFinite(n)) return SIDEBAR_DEFAULT_WIDTH;
    return clampWidth(n);
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

function persistWidth(w: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY_WIDTH, String(w));
  } catch {
    // 隐私模式 / 超额 → 忽略，运行时状态还在 store 里，不影响使用
  }
}

interface LayoutState {
  sidebarCollapsed: boolean;
  sidebarMode: SidebarMode;
  /** 每次递增都会触发 SearchPanel 重新聚焦输入框 */
  searchFocusToken: number;
  /** 保留给未编译进 UI 入口的 SemanticSearchPanel 源码类型检查。 */
  semanticFocusToken: number;
  /** 侧栏像素宽度。通过拖拽手柄调整，localStorage 持久化。 */
  sidebarWidth: number;

  toggleSidebar: () => void;
  setSidebarMode: (mode: SidebarMode) => void;
  /** 把 sidebar 切到 search 并请求 input 聚焦——如果 sidebar 已折叠，先展开。 */
  focusSearch: () => void;
  /** 保留给语义检索源码；公开构建没有 UI/快捷键入口调用它。 */
  focusSemantic: () => void;
  /** 把 sidebar 切到 files 模式并展开（如果折叠了的话）。供"定位当前文件"用。 */
  focusFiles: () => void;
  /** 更新侧栏宽度（自动 clamp 到 [MIN, MAX]）。 */
  setSidebarWidth: (width: number) => void;
}

export const useLayout = create<LayoutState>((set, get) => ({
  sidebarCollapsed: false,
  sidebarMode: "files",
  searchFocusToken: 0,
  semanticFocusToken: 0,
  sidebarWidth: loadInitialWidth(),

  toggleSidebar: () => set({ sidebarCollapsed: !get().sidebarCollapsed }),
  setSidebarMode: (mode) => set({ sidebarMode: mode }),
  focusSearch: () => {
    set((s) => ({
      sidebarCollapsed: false,
      sidebarMode: "search",
      searchFocusToken: s.searchFocusToken + 1,
    }));
  },
  focusSemantic: () => {
    set((s) => ({
      sidebarCollapsed: false,
      sidebarMode: "semantic",
      semanticFocusToken: s.semanticFocusToken + 1,
    }));
  },
  focusFiles: () => {
    set({ sidebarCollapsed: false, sidebarMode: "files" });
  },
  setSidebarWidth: (width) => {
    const next = clampWidth(width);
    if (next === get().sidebarWidth) return;
    set({ sidebarWidth: next });
    persistWidth(next);
  },
}));
