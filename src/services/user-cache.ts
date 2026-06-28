/**
 * Renderer 端 user-cache 薄封装。
 *
 * user-cache 走 main 进程 `user-cache-store.ts`，文件落在 `{userData}/stela-cache.json`。
 * 与 vault 是否打开**无关**——任何时候都可以读写。
 */

import type { PartialUserCache, UserCache } from "@shared/types";

const DEFAULT: UserCache = {
  recentVaults: [],
  lastVault: null,
  locale: "system",
  updateLastCheckedAt: null,
};

export async function loadUserCache(): Promise<UserCache> {
  try {
    return await window.stela.userCache.load();
  } catch (err) {
    console.error("[stela] userCache.load failed; falling back to defaults", err);
    return DEFAULT;
  }
}

export async function patchUserCache(
  partial: PartialUserCache,
): Promise<UserCache> {
  return window.stela.userCache.patch(partial);
}

export function getDefaultUserCache(): UserCache {
  return { ...DEFAULT };
}
