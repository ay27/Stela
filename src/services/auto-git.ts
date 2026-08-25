/**
 * Event-driven Git sync scheduler.
 *
 * App writes and external watcher events share a 3s quiet-period. Focus,
 * reconnect, and the 60s fallback scan run immediately. The main process owns
 * the serialized transaction; this module only coalesces renderer triggers and
 * protects dirty editor buffers.
 */

import { create } from "zustand";

import type { GitSyncTrigger } from "@shared/types";

import { useSettings } from "@/state/settings";
import { useGitStore } from "@/state/git";
import { useWorkspace } from "@/state/workspace";

const QUIET_PERIOD_MS = 3_000;
const FALLBACK_SCAN_MS = 60_000;
const SUCCESS_DISPLAY_MS = 2_500;

export type AutoGitPhase =
  | "idle"
  | "pending"
  | "syncing"
  | "success"
  | "offline"
  | "conflict"
  | "blocked"
  | "error";

interface AutoGitState {
  phase: AutoGitPhase;
  lastSuccessAt: number | null;
  lastError: string | null;
  schedule: (reason: string) => void;
  flush: (trigger?: GitSyncTrigger) => Promise<void>;
  reset: () => void;
}

let scheduleTimer: ReturnType<typeof setTimeout> | null = null;
let successTimer: ReturnType<typeof setTimeout> | null = null;
let fallbackTimer: ReturnType<typeof setInterval> | null = null;
let inflight: Promise<void> | null = null;
let rerunRequested = false;
let pendingTrigger: GitSyncTrigger = "auto";
let focusHandler: (() => void) | null = null;
let onlineHandler: (() => void) | null = null;

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

function currentCapabilities(): {
  enabled: boolean;
  commit: boolean;
  integrate: boolean;
  push: boolean;
} {
  const git = useSettings.getState().settings.git;
  const enabled = git.enabled
    && (git.autoCommit || git.autoPull || git.autoPush);
  return {
    enabled,
    commit: git.autoCommit,
    integrate: git.autoPull || git.autoPush,
    push: git.autoPush,
  };
}

function hasDirtyTabs(): boolean {
  return useWorkspace.getState().tabs.some((tab) => tab.dirty);
}

function triggerForReason(reason: string): GitSyncTrigger {
  return reason.startsWith("external") ? "external" : "auto";
}

function armQuietPeriod(flush: (trigger?: GitSyncTrigger) => Promise<void>): void {
  clearScheduleTimer();
  scheduleTimer = setTimeout(() => {
    scheduleTimer = null;
    const trigger = pendingTrigger;
    pendingTrigger = "auto";
    void flush(trigger);
  }, QUIET_PERIOD_MS);
}

export const useAutoGit = create<AutoGitState>((set, get) => ({
  phase: "idle",
  lastSuccessAt: null,
  lastError: null,

  schedule(reason) {
    if (!currentCapabilities().enabled) return;
    pendingTrigger = triggerForReason(reason);
    clearSuccessTimer();
    if (inflight) {
      rerunRequested = true;
      return;
    }
    set({ phase: "pending", lastError: null });
    armQuietPeriod(get().flush);
  },

  async flush(trigger = "auto") {
    clearScheduleTimer();
    const capabilities = currentCapabilities();
    if (!capabilities.enabled) {
      set({ phase: "idle" });
      return;
    }
    if (hasDirtyTabs()) {
      set({ phase: "pending", lastError: "waiting for editor changes to save" });
      pendingTrigger = trigger;
      armQuietPeriod(get().flush);
      return;
    }
    if (inflight) {
      rerunRequested = true;
      return inflight;
    }

    inflight = (async () => {
      set({ phase: "syncing", lastError: null });
      try {
        const result = await useGitStore.getState().syncNow({
          trigger,
          commit: capabilities.commit,
          integrate: capabilities.integrate,
          push: capabilities.push,
        });
        if (!result) {
          set({ phase: "error", lastError: "automatic Git sync failed" });
          return;
        }
        if (result.conflicted || result.blockedReason === "conflict") {
          set({ phase: "conflict", lastError: result.message });
          return;
        }
        if (result.blockedReason === "offline") {
          set({ phase: "offline", lastError: result.message });
          return;
        }
        if (result.blockedReason) {
          set({ phase: "blocked", lastError: result.message });
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
        if (rerunRequested) {
          rerunRequested = false;
          void get().flush("auto");
        }
      }
    })();
    return inflight;
  },

  reset() {
    clearScheduleTimer();
    clearSuccessTimer();
    rerunRequested = false;
    pendingTrigger = "auto";
    set({ phase: "idle", lastSuccessAt: null, lastError: null });
  },
}));

export function scheduleAutoGit(reason: string): void {
  useAutoGit.getState().schedule(reason);
}

export function syncAutoGitNow(trigger: GitSyncTrigger): void {
  void useAutoGit.getState().flush(trigger);
}

export function resetAutoGit(): void {
  useAutoGit.getState().reset();
  stopAutoPull();
}

/**
 * Compatibility name retained for callers. It now starts the unified sync
 * monitors, not a second pull-only loop.
 */
export function startAutoPull(): void {
  stopAutoPull();
  fallbackTimer = setInterval(() => syncAutoGitNow("interval"), FALLBACK_SCAN_MS);
  if (typeof window !== "undefined") {
    focusHandler = () => syncAutoGitNow("focus");
    onlineHandler = () => syncAutoGitNow("focus");
    window.addEventListener("focus", focusHandler);
    window.addEventListener("online", onlineHandler);
  }
}

export function stopAutoPull(): void {
  if (fallbackTimer !== null) {
    clearInterval(fallbackTimer);
    fallbackTimer = null;
  }
  if (focusHandler !== null && typeof window !== "undefined") {
    window.removeEventListener("focus", focusHandler);
    focusHandler = null;
  }
  if (onlineHandler !== null && typeof window !== "undefined") {
    window.removeEventListener("online", onlineHandler);
    onlineHandler = null;
  }
}
