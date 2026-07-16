/**
 * AutoGit：自动 checkpoint 提交 + 可选自动 pull（替代旧 COS auto-sync）。
 *
 * 设计：
 *   - 编辑保存 / runsql 完成 / 文件树操作 → 防抖后自动 `git commit`（含 JSONL），
 *     若 settings.git.autoPush 开启则顺带 push。
 *   - App 退出时 main 再做一次 commit-only flush（见 sync-orchestrator.flushAutoCommitOnQuit），
 *     避免 2 分钟防抖窗口内退出丢掉 checkpoint；退出路径不 push，以免卡在凭据提示。
 *   - 自动 pull 由定时器驱动（settings.git.autoPull + interval），不抢占用户
 *     正在编辑的脏 buffer——冲突时交给状态栏冲突流程处理。
 *   - 单 inflight：debounce 到达时若上次还在跑，则不并发。
 *
 * 与 [`useGitStore`](../state/git.ts) 的关系：本模块只负责"何时自动触发"，实际
 * 操作仍走 git store 的 syncPush / syncPull，状态统一在 git store 里反映。
 */

import { create } from "zustand";

import { useSettings } from "@/state/settings";
import { useGitStore } from "@/state/git";
import { useWorkspace } from "@/state/workspace";

/** 防抖窗口：编辑停手后多久自动 commit。 */
const DEBOUNCE_MS = 120_000;
const SUCCESS_DISPLAY_MS = 2_500;

/** auto-pull 去抖：focus / interval 共享，避免频繁拉取。手动 pull 不走这里。 */
const AUTO_PULL_COOLDOWN_MS = 30_000;

export type AutoGitPhase =
  | "idle"
  | "pending"
  | "committing"
  | "success"
  | "error";

interface AutoGitState {
  phase: AutoGitPhase;
  lastSuccessAt: number | null;
  lastError: string | null;
  schedule: (reason: string) => void;
  flush: () => Promise<void>;
  reset: () => void;
}

let scheduleTimer: ReturnType<typeof setTimeout> | null = null;
let successTimer: ReturnType<typeof setTimeout> | null = null;
let pullTimer: ReturnType<typeof setInterval> | null = null;
let inflight: Promise<void> | null = null;
let lastAutoPullAt = 0;
let focusHandler: (() => void) | null = null;

function clearScheduleTimer(): void {
  if (scheduleTimer !== null) {
    clearTimeout(scheduleTimer);
    scheduleTimer = null;
  }
}

function clearSuccessTimer(): void {
  if (successTimer !== null) {
    clearTimeout(successTimer);
    successTimer = null;
  }
}

/** 自动提交功能是否开启（不含 dirty / 落盘闸门）。 */
function isAutoCommitEnabled(): boolean {
  const git = useSettings.getState().settings.git;
  if (!git.enabled || !git.autoCommit) return false;
  if (!useGitStore.getState().status.isRepo) return false;
  return true;
}

/**
 * 是否可安全 commit：没有任何 dirty tab。
 *
 * 编辑器自动保存是 800ms 防抖；`writeFile` 成功时 tab 往往仍标记 dirty
 * （`onPersist` 的 `.then` 才清掉），因此 dirty 检查只放在 flush 阶段，
 * 不能挡 schedule——否则自动提交永远不会被调度。
 */
function isSafeToCommit(): boolean {
  return !useWorkspace.getState().tabs.some((t) => t.dirty);
}

function armFlushTimer(flush: () => Promise<void>): void {
  scheduleTimer = setTimeout(() => {
    scheduleTimer = null;
    void flush();
  }, DEBOUNCE_MS);
}

export const useAutoGit = create<AutoGitState>((set, get) => ({
  phase: "idle",
  lastSuccessAt: null,
  lastError: null,

  schedule(_reason) {
    if (!isAutoCommitEnabled()) return;
    clearScheduleTimer();
    clearSuccessTimer();
    set({ phase: "pending" });
    armFlushTimer(() => get().flush());
  },

  async flush() {
    clearScheduleTimer();
    if (!isAutoCommitEnabled()) {
      set({ phase: "idle" });
      return;
    }
    if (!isSafeToCommit()) {
      set({ phase: "pending" });
      armFlushTimer(() => get().flush());
      return;
    }
    if (inflight) return inflight;
    inflight = (async () => {
      set({ phase: "committing" });
      try {
        const autoPush = useSettings.getState().settings.git.autoPush;
        const r = await useGitStore.getState().syncPush(undefined, { push: autoPush });
        if (!r) {
          set({ phase: "error", lastError: "auto commit failed" });
          return;
        }
        if (autoPush && !r.pushed && r.pullRequired) {
          set({
            phase: "error",
            lastError: "push rejected: pull required",
            lastSuccessAt: get().lastSuccessAt,
          });
          return;
        }
        set({ phase: "success", lastSuccessAt: Date.now(), lastError: null });
        clearSuccessTimer();
        successTimer = setTimeout(() => {
          successTimer = null;
          if (get().phase === "success") set({ phase: "idle" });
        }, SUCCESS_DISPLAY_MS);
      } catch (err) {
        set({
          phase: "error",
          lastError: err instanceof Error ? err.message : String(err),
        });
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  },

  reset() {
    clearScheduleTimer();
    clearSuccessTimer();
    inflight = null;
    set({ phase: "idle", lastSuccessAt: null, lastError: null });
  },
}));

export function scheduleAutoGit(reason: string): void {
  useAutoGit.getState().schedule(reason);
}

export function resetAutoGit(): void {
  useAutoGit.getState().reset();
  stopAutoPull();
}

/**
 * 触发一次 auto-pull（受 cooldown 去抖）。interval / window focus 共用。
 * 有冲突 / 非 repo / 无 remote / 未启用时静默跳过。
 */
function maybeAutoPull(): void {
  const git = useSettings.getState().settings.git;
  if (!git.enabled || !git.autoPull) return;
  const status = useGitStore.getState().status;
  if (!status.isRepo || !status.hasRemote) return;
  if (status.conflictCount > 0) return; // 有冲突时不自动 pull
  const now = Date.now();
  if (now - lastAutoPullAt < AUTO_PULL_COOLDOWN_MS) return;
  lastAutoPullAt = now;
  void useGitStore.getState().syncPull();
}

/**
 * 启动自动 pull（幂等：重复调用会重置）。在 vault 打开 / settings 变更后调。
 * 仅当 settings.git.enabled && autoPull && 当前 vault 是带 remote 的 git repo 时生效。
 *
 * 触发来源（借鉴 tolaria useAutoSync）：
 *   - 定时 interval（settings.autoPullIntervalMs）
 *   - 窗口重新获得焦点（切回应用即看到最新内容）
 *   两者共享 30s cooldown，避免频繁拉取。
 */
export function startAutoPull(): void {
  stopAutoPull();
  const git = useSettings.getState().settings.git;
  if (!git.enabled || !git.autoPull) return;
  pullTimer = setInterval(maybeAutoPull, git.autoPullIntervalMs);
  if (typeof window !== "undefined") {
    focusHandler = () => maybeAutoPull();
    window.addEventListener("focus", focusHandler);
  }
}

export function stopAutoPull(): void {
  if (pullTimer !== null) {
    clearInterval(pullTimer);
    pullTimer = null;
  }
  if (focusHandler !== null && typeof window !== "undefined") {
    window.removeEventListener("focus", focusHandler);
    focusHandler = null;
  }
}
