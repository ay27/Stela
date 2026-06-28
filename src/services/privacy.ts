/**
 * Renderer 侧凭据存储状态查询。
 *
 * 直接走 `window.stela.privacy.getStatus()`，把结果用 zustand 缓存起来，
 * 多处 UI（Settings → Security、Connections 顶部 banner）共用同一份状态。
 *
 * 状态在主进程一次启动内不会变化（platform / safeStorage 都是稳定能力），
 * 所以只需第一次 use 时拉一次。
 */

import { useEffect } from "react";
import { create } from "zustand";

import type { CredentialStorageStatus } from "@shared/types";

interface PrivacyState {
  status: CredentialStorageStatus | null;
  /** "idle" 时尚未 fetch；"loading" 表示 in-flight；"ready" 表示拿到结果。 */
  phase: "idle" | "loading" | "ready" | "error";
  error: string | null;
  load: () => Promise<void>;
}

const usePrivacy = create<PrivacyState>((set, get) => ({
  status: null,
  phase: "idle",
  error: null,
  async load() {
    if (get().phase === "loading" || get().phase === "ready") return;
    set({ phase: "loading", error: null });
    try {
      const s = await window.stela.privacy.getStatus();
      set({ status: s, phase: "ready" });
    } catch (err) {
      console.error("[stela] privacy.getStatus failed", err);
      set({
        phase: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
}));

export interface PrivacyView {
  status: CredentialStorageStatus | null;
  loading: boolean;
  error: string | null;
}

/** Settings / Connections UI 共用：自动触发 load，订阅缓存。 */
export function usePrivacyStatus(): PrivacyView {
  const status = usePrivacy((s) => s.status);
  const phase = usePrivacy((s) => s.phase);
  const error = usePrivacy((s) => s.error);
  const load = usePrivacy((s) => s.load);

  useEffect(() => {
    void load();
  }, [load]);

  return {
    status,
    loading: phase === "idle" || phase === "loading",
    error,
  };
}

/**
 * 把 platform 翻译成「OS keychain」的本地化名称。Linux 下 safeStorage 走
 * libsecret（GNOME Keyring / KWallet），文案里直接说「系统 keyring」更通用。
 */
export function describeBackend(
  status: CredentialStorageStatus | null,
): string {
  if (!status) return "未知";
  if (!status.available) return "明文（OS keychain 不可用）";
  switch (status.platform) {
    case "darwin":
      return "macOS Keychain";
    case "win32":
      return "Windows DPAPI";
    case "linux":
      return "系统 keyring (libsecret)";
    default:
      return `safeStorage (${status.platform})`;
  }
}
