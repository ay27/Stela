/**
 * 用户级缓存（跨 vault，机器级）持久化。
 *
 * 文件：`{userData}/stela-cache.json`
 * 内容：`lastVault`（启动恢复用）+ `recentVaults`（Welcome 列表用）
 * + `locale`（跨 vault 的 UI 语言偏好）。
 *
 * 写策略：原子写（.tmp + rename）。
 * 边界：所有真正的「偏好」一律走 vault 级 settings；这里只承载启动 / 切 vault
 *       的最小化跨 vault 状态。
 */

import { app } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";

import { AppError } from "@shared/errors";
import type { LocaleMode, PartialUserCache, UserCache } from "@shared/types";

import { atomicWriteFile } from "./atomic-write";
import { getLogger } from "./logger";
import {
  readLegacyLastVault,
  readLegacyRecentVaultPaths,
} from "./migrate-userdata-to-vault";

const FILE_NAME = "stela-cache.json";
const log = getLogger("user-cache");

/** 最近 vault 列表上限。超过会从尾部丢弃。 */
const RECENT_VAULTS_LIMIT = 8;

const DEFAULT: UserCache = {
  recentVaults: [],
  lastVault: null,
  locale: "system",
  updateLastCheckedAt: null,
};

function filePath(): string {
  return path.join(app.getPath("userData"), FILE_NAME);
}

function sanitizeRecentVaults(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    if (typeof item !== "string" || item.length === 0) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= RECENT_VAULTS_LIMIT) break;
  }
  return out;
}

interface RawCache {
  recentVaults?: unknown;
  lastVault?: unknown;
  locale?: unknown;
  updateLastCheckedAt?: unknown;
}

function sanitizeLocale(input: unknown): LocaleMode {
  return input === "zh" || input === "en" || input === "system"
    ? input
    : DEFAULT.locale;
}

async function readRaw(): Promise<RawCache> {
  try {
    const buf = await fs.readFile(filePath(), "utf-8");
    return JSON.parse(buf) as RawCache;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return {};
    throw new AppError(
      "user_cache_read_failed",
      `read user cache failed: ${e.message}`,
    );
  }
}

async function writeRaw(raw: UserCache): Promise<void> {
  await atomicWriteFile(filePath(), JSON.stringify(raw, null, 2));
}

export async function loadUserCache(): Promise<UserCache> {
  const raw = await readRaw();
  return {
    recentVaults: sanitizeRecentVaults(raw.recentVaults),
    lastVault:
      typeof raw.lastVault === "string" && raw.lastVault.length > 0
        ? raw.lastVault
        : DEFAULT.lastVault,
    locale: sanitizeLocale(raw.locale),
    updateLastCheckedAt:
      typeof raw.updateLastCheckedAt === "number" &&
      Number.isFinite(raw.updateLastCheckedAt) &&
      raw.updateLastCheckedAt >= 0
        ? raw.updateLastCheckedAt
        : DEFAULT.updateLastCheckedAt,
  };
}

export async function patchUserCache(
  partial: PartialUserCache,
): Promise<UserCache> {
  const current = await loadUserCache();
  const next: UserCache = {
    recentVaults:
      partial.recentVaults !== undefined
        ? sanitizeRecentVaults(partial.recentVaults)
        : current.recentVaults,
    lastVault:
      partial.lastVault !== undefined ? partial.lastVault : current.lastVault,
    locale:
      partial.locale !== undefined
        ? sanitizeLocale(partial.locale)
        : current.locale,
    updateLastCheckedAt:
      partial.updateLastCheckedAt !== undefined
        ? partial.updateLastCheckedAt
        : current.updateLastCheckedAt,
  };
  await writeRaw(next);
  return next;
}

async function fileExists(fp: string): Promise<boolean> {
  try {
    const s = await fs.stat(fp);
    return s.isFile();
  } catch {
    return false;
  }
}

/**
 * 一次性迁移：如果 user-cache 文件还不存在，从老 `{userData}/stela-settings.json`
 * 把 `vault.path` / `vault.recentPaths` 抽出来作为 `lastVault` / `recentVaults` seed。
 *
 * 调用时机：main 进程启动后、注册 handler 之前调一次。即使老文件也不存在，会
 * 写一份空 cache 文件占位（避免后续 ENOENT 走 default 时反复触发 seed 逻辑）。
 */
export async function bootstrapFromLegacyIfFresh(): Promise<void> {
  if (await fileExists(filePath())) return;
  let recentVaults: string[] = [];
  let lastVault: string | null = null;
  try {
    [recentVaults, lastVault] = await Promise.all([
      readLegacyRecentVaultPaths(),
      readLegacyLastVault(),
    ]);
  } catch (err) {
    log.error("read legacy user settings failed", {
      err: (err as Error).message,
    });
  }
  const sanitized = sanitizeRecentVaults(recentVaults);
  // lastVault 也合并进 recentVaults（如果不在），保证 Welcome 列表完整
  const merged: string[] = lastVault
    ? [lastVault, ...sanitized.filter((p) => p !== lastVault)].slice(0, sanitized.length || 1)
    : sanitized;
  const seed: UserCache = {
    recentVaults: sanitizeRecentVaults(merged),
    lastVault,
    locale: DEFAULT.locale,
    updateLastCheckedAt: DEFAULT.updateLastCheckedAt,
  };
  try {
    await writeRaw(seed);
    log.info("bootstrapped user-cache from legacy", {
      recentVaults: seed.recentVaults.length,
      hasLastVault: !!seed.lastVault,
    });
  } catch (err) {
    log.error("bootstrap user-cache write failed", {
      err: (err as Error).message,
    });
  }
}
