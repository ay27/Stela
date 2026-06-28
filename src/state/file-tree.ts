/**
 * 文件树状态 store —— 把展开/加载状态从 `FileTree` 组件局部 state 提到全局。
 *
 * 背景：`Sidebar` 在 `sidebarMode === "files" | "search"` 间切换时是用三元表达式
 * 条件渲染的（见 `src/layout/Sidebar.tsx`），每次切换 `FileTree` 都会被卸载，
 * 其内部 useState 全部丢失 —— 用户原来展开的一串路径全部被收起，体验很差。
 *
 * 搬到全局 store 后：
 *   - `expanded`（展开的目录路径集合）在 store 里，跨切换不丢
 *   - `children` / `loading` / `errors` 也在 store 里，避免切回来时重新触发 fs 读
 *     造成的闪烁
 *   - `expanded` 按 vaultPath 作 scope 持久化到 localStorage，下次开 app 还在
 *   - 切仓库时用 `resetForVault(newVaultPath)` 清空运行时状态（children / loading
 *     / errors），展开集合则从新 vault 的 localStorage 读回。
 *
 * 持久化只覆盖 `expanded`；children/loading/errors 是运行时缓存，重启后重拉。
 * 设计思路同 `src/state/layout.ts` —— 直接用 localStorage，不引 zustand persist
 * 中间件。
 */

import { create } from "zustand";
import type { FileNode } from "@/services/fs";

/**
 * 跨进程传过来的"待新建草稿"。AppShell 的 Cmd+N hotkey 拿不到 FileTree 组件
 * 实例，只能往 store 里塞一个一次性 signal，FileTree 订阅后 consume。
 */
export type PendingDraft =
  | { kind: "newNote"; parentPath: string }
  | { kind: "newDir"; parentPath: string };

/** 用对象而非 Set/Map，zustand 浅比较友好，也好直接 JSON 序列化。 */
interface FileTreeState {
  /** 当前 store 所属的 vault 路径。null 表示未绑定。 */
  vaultPath: string | null;
  /** 已展开目录的绝对路径 → true */
  expanded: Record<string, true>;
  /** 目录绝对路径 → 子节点列表；null 表示尚未加载过 */
  children: Record<string, FileNode[]>;
  /** 目录绝对路径 → 正在 listDir 中 */
  loading: Record<string, true>;
  /** 目录绝对路径 → 错误信息 */
  errors: Record<string, string>;
  /**
   * 用户最近在文件树里点过的节点（文件或目录）。Cmd+N 用它决定"在哪个目录里
   * 新建笔记"（文件取其父目录、目录取自身、null 退到活跃 tab / vault 根）。
   * 不持久化：跨会话保留意义不大，且会和 reveal-active 行为冲突。
   */
  selectedPath: string | null;
  /** 文件树顶部"快速过滤"输入框的当前值；空字符串表示不过滤。 */
  filter: string;
  /**
   * 一次性消费的"请求 inline 新建"信号。AppShell 的 Cmd+N 写入，FileTree
   * 渲染时读取并立即 consume，避免重复触发。
   */
  pendingDraft: PendingDraft | null;

  /** 切换到某个 vault：重置运行时缓存，从 localStorage 加载该 vault 的 expanded */
  bindVault: (vaultPath: string) => void;
  /** 解绑：关闭 vault 时调用，清空全部状态 */
  unbindVault: () => void;

  setExpanded: (dirPath: string, expanded: boolean) => void;
  setChildren: (dirPath: string, nodes: FileNode[]) => void;
  setLoading: (dirPath: string, loading: boolean) => void;
  setError: (dirPath: string, msg: string | null) => void;
  setSelected: (path: string | null) => void;
  setFilter: (filter: string) => void;
  /** 折叠所有目录，但保留当前 vault 绑定；同步清掉 localStorage 持久化项。 */
  collapseAll: () => void;
  /** 入队一个 inline 新建草稿请求；FileTree 拿到后会 consume。 */
  requestDraft: (draft: PendingDraft) => void;
  /** 把 pendingDraft 取走并清空。返回值即取出的 draft。 */
  consumeDraft: () => PendingDraft | null;
}

const STORAGE_KEY_PREFIX = "stela.file-tree.expanded:";

function storageKey(vaultPath: string): string {
  return `${STORAGE_KEY_PREFIX}${vaultPath}`;
}

function loadExpanded(vaultPath: string): Record<string, true> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(storageKey(vaultPath));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return {};
    const out: Record<string, true> = {};
    for (const item of parsed) {
      if (typeof item === "string" && item.length > 0) out[item] = true;
    }
    return out;
  } catch {
    return {};
  }
}

function persistExpanded(vaultPath: string, expanded: Record<string, true>): void {
  if (typeof window === "undefined") return;
  try {
    const arr = Object.keys(expanded);
    window.localStorage.setItem(storageKey(vaultPath), JSON.stringify(arr));
  } catch {
    // 隐私模式 / 超额 → 忽略，运行时状态还在 store 里，不影响使用
  }
}

export const useFileTree = create<FileTreeState>((set, get) => ({
  vaultPath: null,
  expanded: {},
  children: {},
  loading: {},
  errors: {},
  selectedPath: null,
  filter: "",
  pendingDraft: null,

  bindVault: (vaultPath) => {
    if (get().vaultPath === vaultPath) return;
    set({
      vaultPath,
      expanded: loadExpanded(vaultPath),
      children: {},
      loading: {},
      errors: {},
      selectedPath: null,
      filter: "",
      pendingDraft: null,
    });
  },

  unbindVault: () => {
    set({
      vaultPath: null,
      expanded: {},
      children: {},
      loading: {},
      errors: {},
      selectedPath: null,
      filter: "",
      pendingDraft: null,
    });
  },

  setExpanded: (dirPath, expanded) => {
    const s = get();
    const cur = s.expanded[dirPath] === true;
    if (cur === expanded) return;
    const next: Record<string, true> = { ...s.expanded };
    if (expanded) next[dirPath] = true;
    else delete next[dirPath];
    set({ expanded: next });
    if (s.vaultPath) persistExpanded(s.vaultPath, next);
  },

  setChildren: (dirPath, nodes) => {
    const s = get();
    set({
      children: { ...s.children, [dirPath]: nodes },
      // 成功加载时顺手清掉同路径的 error
      errors: dirPath in s.errors ? omit(s.errors, dirPath) : s.errors,
    });
  },

  setLoading: (dirPath, loading) => {
    const s = get();
    const cur = s.loading[dirPath] === true;
    if (cur === loading) return;
    if (loading) {
      set({ loading: { ...s.loading, [dirPath]: true } });
    } else {
      set({ loading: omit(s.loading, dirPath) });
    }
  },

  setError: (dirPath, msg) => {
    const s = get();
    if (msg == null) {
      if (!(dirPath in s.errors)) return;
      set({ errors: omit(s.errors, dirPath) });
    } else {
      set({ errors: { ...s.errors, [dirPath]: msg } });
    }
  },

  setSelected: (path) => {
    if (get().selectedPath === path) return;
    set({ selectedPath: path });
  },

  setFilter: (filter) => {
    if (get().filter === filter) return;
    set({ filter });
  },

  collapseAll: () => {
    const s = get();
    if (Object.keys(s.expanded).length === 0) return;
    set({ expanded: {} });
    if (s.vaultPath) persistExpanded(s.vaultPath, {});
  },

  requestDraft: (draft) => {
    set({ pendingDraft: draft });
  },

  consumeDraft: () => {
    const s = get();
    const draft = s.pendingDraft;
    if (draft) set({ pendingDraft: null });
    return draft;
  },
}));

function omit<T>(obj: Record<string, T>, key: string): Record<string, T> {
  if (!(key in obj)) return obj;
  const next: Record<string, T> = { ...obj };
  delete next[key];
  return next;
}
