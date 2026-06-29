/**
 * Git 状态 store（renderer）。
 *
 * 持有当前 vault 的 Git 概览（branch / changed / ahead / behind / conflict），
 * 并封装 commit / sync push / sync pull / init / addRemote 等操作。状态栏
 * [`GitBadge`](../components/git-badge.tsx) 与 Settings → Git tab 共用本 store。
 *
 * 走 main 进程 [`electron/services/git/*`](../../electron/services/git/) +
 * [`sync-orchestrator.ts`](../../electron/services/sync-orchestrator.ts)。
 */

import { create } from "zustand";

import type {
  GitConflictMode,
  GitSyncPullResult,
  GitSyncPushResult,
  GitVaultStatus,
} from "@shared/types";

import { useWorkspace } from "@/state/workspace";

const EMPTY_STATUS: GitVaultStatus = {
  isRepo: false,
  branch: null,
  hasRemote: false,
  ahead: 0,
  behind: 0,
  changedCount: 0,
  conflictCount: 0,
  conflictMode: "none",
};

interface GitState {
  status: GitVaultStatus;
  phase: "idle" | "loading" | "busy" | "error";
  /** 最近一次操作的可读消息（push/pull 结果），用于 badge tooltip / toast。 */
  lastMessage: string | null;
  lastError: string | null;
  /** pull 检测到冲突时置 true；UI 据此打开冲突解决流程。 */
  conflicted: boolean;
  conflictMode: GitConflictMode;

  refresh: () => Promise<void>;
  syncPush: (message?: string, options?: { push?: boolean }) => Promise<GitSyncPushResult | null>;
  syncPull: () => Promise<GitSyncPullResult | null>;
  clearConflict: () => void;
}

function isNoVault(err: unknown): boolean {
  return (err as { code?: string }).code === "no_vault";
}

export const useGitStore = create<GitState>((set, get) => ({
  status: { ...EMPTY_STATUS },
  phase: "idle",
  lastMessage: null,
  lastError: null,
  conflicted: false,
  conflictMode: "none",

  async refresh() {
    if (get().phase === "loading") return;
    set({ phase: "loading", lastError: null });
    try {
      const status = await window.stela.git.vaultStatus();
      set({
        status,
        phase: "idle",
        conflicted: status.conflictCount > 0,
        conflictMode: status.conflictMode,
      });
    } catch (err) {
      if (isNoVault(err)) {
        set({ status: { ...EMPTY_STATUS }, phase: "idle", lastError: null });
        return;
      }
      set({
        phase: "error",
        lastError: err instanceof Error ? err.message : String(err),
      });
    }
  },

  async syncPush(message, options) {
    set({ phase: "busy", lastError: null });
    try {
      const r = await window.stela.git.syncPush(message, options);
      set({ phase: "idle", lastMessage: r.message });
      await get().refresh();
      return r;
    } catch (err) {
      set({
        phase: "error",
        lastError: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  },

  async syncPull() {
    set({ phase: "busy", lastError: null });
    try {
      const r = await window.stela.git.syncPull();
      set({
        phase: "idle",
        lastMessage: r.message,
        conflicted: r.conflicted,
        conflictMode: r.conflictMode,
      });
      // pull 拉到新内容：显式让 clean tab 重读磁盘，dirty tab 保护本地。
      // 比纯等 vault-watcher 事件更跟手、抖动更少；watcher 仍会兜底刷新文件树等。
      if (r.updated && !r.conflicted) {
        useWorkspace.getState().reloadCleanFileTabsAfterSync();
      }
      await get().refresh();
      return r;
    } catch (err) {
      set({
        phase: "error",
        lastError: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  },

  clearConflict() {
    set({ conflicted: false, conflictMode: "none" });
  },
}));

export function refreshGitStatus(): void {
  void useGitStore.getState().refresh();
}
