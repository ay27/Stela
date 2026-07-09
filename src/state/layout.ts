/**
 * 全局布局状态 store。
 *
 * 用途：让快捷键层（`src/lib/hotkeys.ts`）能跨组件树操作 Sidebar / Agent 栏：
 *   - 折叠 / 展开左侧 Sidebar（Mod+B）
 *   - 把 Sidebar 切到 "search" 模式并请求 input 聚焦（Mod+Shift+F）
 *   - 折叠 / 展开右侧全局 Agent 栏（Mod+Shift+A）
 *   - 记住用户拖拽出的宽度（localStorage 持久化，不经 Rust 设置仓，避免每次拖拽
 *     都跨进程写文件）
 *
 * `searchFocusToken` / `agentFocusToken` 采用 "递增 counter" 模式：每次递增都会
 * 触发对应面板重新聚焦输入框，就算面板已经打开也会重新 focus。
 */

import { create } from "zustand";

export type SidebarMode = "files" | "search" | "schema" | "runs";

/** 侧栏宽度限制（px）。min 受限于 FileTree 文件名最短可读宽度，max 防止吞掉主区。 */
export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 480;
export const SIDEBAR_DEFAULT_WIDTH = 260;

/** Agent 全局栏宽度限制（px）。比左侧略宽——聊天内容比文件名更需要横向空间。 */
export const AGENT_PANEL_MIN_WIDTH = 280;
export const AGENT_PANEL_MAX_WIDTH = 560;
export const AGENT_PANEL_DEFAULT_WIDTH = 340;

const STORAGE_KEY_WIDTH = "stela.layout.sidebarWidth";
const STORAGE_KEY_AGENT_WIDTH = "stela.layout.agentPanelWidth";

function clamp(w: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(w)) return fallback;
  return Math.min(max, Math.max(min, Math.round(w)));
}

function loadStoredWidth(key: string, min: number, max: number, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return clamp(n, min, max, fallback);
  } catch {
    return fallback;
  }
}

function persistWidth(key: string, w: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, String(w));
  } catch {
    // 隐私模式 / 超额 → 忽略，运行时状态还在 store 里，不影响使用
  }
}

interface LayoutState {
  sidebarCollapsed: boolean;
  sidebarMode: SidebarMode;
  /** 每次递增都会触发 SearchPanel 重新聚焦输入框 */
  searchFocusToken: number;
  /** 侧栏像素宽度。通过拖拽手柄调整，localStorage 持久化。 */
  sidebarWidth: number;

  /** 右侧全局 Agent 栏折叠态。默认折叠——常驻展开会占太多屏幕空间；重开入口见
   *  Mod+Shift+A / TabBar 右侧图标 / 命令面板。 */
  agentPanelCollapsed: boolean;
  /** Agent 栏像素宽度，独立于左侧 sidebarWidth 持久化。 */
  agentPanelWidth: number;
  /** 每次递增都会触发 Agent 面板重新聚焦输入框。 */
  agentFocusToken: number;

  toggleSidebar: () => void;
  setSidebarMode: (mode: SidebarMode) => void;
  /** 把 sidebar 切到 search 并请求 input 聚焦——如果 sidebar 已折叠，先展开。 */
  focusSearch: () => void;
  /** 把 sidebar 切到 files 模式并展开（如果折叠了的话）。供"定位当前文件"用。 */
  focusFiles: () => void;
  /** 更新侧栏宽度（自动 clamp 到 [MIN, MAX]）。 */
  setSidebarWidth: (width: number) => void;

  toggleAgentPanel: () => void;
  /** 展开 Agent 栏（如果已折叠）并请求输入框聚焦。 */
  focusAgentPanel: () => void;
  setAgentPanelWidth: (width: number) => void;
}

export const useLayout = create<LayoutState>((set, get) => ({
  sidebarCollapsed: false,
  sidebarMode: "files",
  searchFocusToken: 0,
  sidebarWidth: loadStoredWidth(
    STORAGE_KEY_WIDTH,
    SIDEBAR_MIN_WIDTH,
    SIDEBAR_MAX_WIDTH,
    SIDEBAR_DEFAULT_WIDTH,
  ),

  // 默认收起：常驻展开的 340px 面板对大多数不用 Agent 的用户显得太占地方，
  // 折叠成窄条更克制，需要时通过 Mod+Shift+A / TabBar 图标 / 命令面板展开。
  agentPanelCollapsed: true,
  agentPanelWidth: loadStoredWidth(
    STORAGE_KEY_AGENT_WIDTH,
    AGENT_PANEL_MIN_WIDTH,
    AGENT_PANEL_MAX_WIDTH,
    AGENT_PANEL_DEFAULT_WIDTH,
  ),
  agentFocusToken: 0,

  toggleSidebar: () => set({ sidebarCollapsed: !get().sidebarCollapsed }),
  setSidebarMode: (mode) => set({ sidebarMode: mode }),
  focusSearch: () => {
    set((s) => ({
      sidebarCollapsed: false,
      sidebarMode: "search",
      searchFocusToken: s.searchFocusToken + 1,
    }));
  },
  focusFiles: () => {
    set({ sidebarCollapsed: false, sidebarMode: "files" });
  },
  setSidebarWidth: (width) => {
    const next = clamp(width, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_DEFAULT_WIDTH);
    if (next === get().sidebarWidth) return;
    set({ sidebarWidth: next });
    persistWidth(STORAGE_KEY_WIDTH, next);
  },

  toggleAgentPanel: () => set({ agentPanelCollapsed: !get().agentPanelCollapsed }),
  focusAgentPanel: () => {
    set((s) => ({
      agentPanelCollapsed: false,
      agentFocusToken: s.agentFocusToken + 1,
    }));
  },
  setAgentPanelWidth: (width) => {
    const next = clamp(width, AGENT_PANEL_MIN_WIDTH, AGENT_PANEL_MAX_WIDTH, AGENT_PANEL_DEFAULT_WIDTH);
    if (next === get().agentPanelWidth) return;
    set({ agentPanelWidth: next });
    persistWidth(STORAGE_KEY_AGENT_WIDTH, next);
  },
}));
