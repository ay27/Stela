/**
 * 一次性迁移：把 v0.1 之前 user 级（`{userData}/...`）的配置 seed 到新 vault 的
 * `.stela/`。
 *
 * 触发时机：vault-context.setCurrentVault 在 registry 加载之前调一次。仅当
 * 目标 `{vault}/.stela/` 之前不存在时才工作；已经有 .stela/ 的 vault 完全跳过。
 *
 * 行为：
 *   - settings / connections / plugins 三个文件分别独立判断 + 拷贝
 *   - **保留** userData 下原文件作回退；只在日志里记录 "seeded from legacy"
 *   - 拷贝 settings 时去掉过时的 `vault.path` / `vault.recentPaths` 字段
 *     （这些已经搬到 user-cache）
 *   - 拷贝 connections 时透传 wrapped password（safeStorage 加密格式照搬）
 *   - 失败不致命，调用方应捕获错误后继续启动
 */

import { app } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";

import { atomicWriteFile } from "./atomic-write";
import { getLogger } from "./logger";
import {
  ensureVaultConfigDir,
  vaultConfigDir,
  vaultFilePath,
} from "./vault-paths";

const log = getLogger("migrate-userdata-to-vault");

const LEGACY_SETTINGS = "stela-settings.json";
const LEGACY_CONNECTIONS = "stela-connections.json";
const LEGACY_PLUGINS = "connector_plugins.json";

const VAULT_SETTINGS = "settings.json";
const VAULT_CONNECTIONS = "connections.json";
const VAULT_PLUGINS = "connector_plugins.json";

function legacyPath(name: string): string {
  return path.join(app.getPath("userData"), name);
}

async function fileExists(fp: string): Promise<boolean> {
  try {
    const s = await fs.stat(fp);
    return s.isFile();
  } catch {
    return false;
  }
}

async function dirExists(dp: string): Promise<boolean> {
  try {
    const s = await fs.stat(dp);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function readJsonOrNull<T>(fp: string): Promise<T | null> {
  try {
    const buf = await fs.readFile(fp, "utf-8");
    return JSON.parse(buf) as T;
  } catch {
    return null;
  }
}

async function writeJson(fp: string, data: unknown): Promise<void> {
  await atomicWriteFile(fp, JSON.stringify(data, null, 2));
}

interface LegacySettingsShape {
  vault?: {
    path?: unknown;
    recentPaths?: unknown;
    recentFiles?: unknown;
  };
  appearance?: unknown;
  execution?: unknown;
  persistence?: unknown;
  ui?: unknown;
}

/**
 * 把老 settings.json 的字段拣选迁移到新 vault settings 形态。
 *
 * - vault.path / vault.recentPaths：丢弃（已搬到 user-cache）
 * - vault.recentFiles：保留为 raw（settings-store 的 sanitize 会做兼容；
 *   老条目带 vaultPath 字段，sanitize 会无视，仅取 path/openedAt）
 * - 其它字段透传
 */
function transformLegacySettings(legacy: LegacySettingsShape): unknown {
  const out: Record<string, unknown> = {};
  if (legacy.appearance) out.appearance = legacy.appearance;
  if (legacy.execution) out.execution = legacy.execution;
  if (legacy.persistence) out.persistence = legacy.persistence;
  if (legacy.ui) out.ui = legacy.ui;
  if (legacy.vault?.recentFiles) {
    out.vault = { recentFiles: legacy.vault.recentFiles };
  }
  return out;
}

/**
 * 主入口：仅在 `{vault}/.stela/` 不存在时执行 seed；存在则跳过。
 *
 * 即使 seed 期间个别文件缺失或拷贝失败，也不会抛——尽力而为。
 */
export async function maybeSeedFromLegacy(vaultPath: string): Promise<void> {
  const cfgDir = vaultConfigDir(vaultPath);
  if (await dirExists(cfgDir)) {
    return;
  }
  log.info("seeding new vault config dir from userData", { vaultPath });
  await ensureVaultConfigDir(vaultPath);

  // settings
  const legacySettingsPath = legacyPath(LEGACY_SETTINGS);
  if (await fileExists(legacySettingsPath)) {
    const legacy = await readJsonOrNull<LegacySettingsShape>(
      legacySettingsPath,
    );
    if (legacy) {
      try {
        await writeJson(
          vaultFilePath(vaultPath, VAULT_SETTINGS),
          transformLegacySettings(legacy),
        );
        log.info("seeded settings.json", { vaultPath });
      } catch (err) {
        log.error("seed settings failed", {
          vaultPath,
          err: (err as Error).message,
        });
      }
    }
  }

  // connections（password 已是 wrapped 格式，直接透传）
  const legacyConnPath = legacyPath(LEGACY_CONNECTIONS);
  if (await fileExists(legacyConnPath)) {
    const raw = await readJsonOrNull<unknown>(legacyConnPath);
    if (raw) {
      try {
        await writeJson(vaultFilePath(vaultPath, VAULT_CONNECTIONS), raw);
        log.info("seeded connections.json", { vaultPath });
      } catch (err) {
        log.error("seed connections failed", {
          vaultPath,
          err: (err as Error).message,
        });
      }
    }
  }

  // plugins manifest
  const legacyPluginsPath = legacyPath(LEGACY_PLUGINS);
  if (await fileExists(legacyPluginsPath)) {
    const raw = await readJsonOrNull<unknown>(legacyPluginsPath);
    if (raw) {
      try {
        await writeJson(vaultFilePath(vaultPath, VAULT_PLUGINS), raw);
        log.info("seeded connector_plugins.json", { vaultPath });
      } catch (err) {
        log.error("seed plugins failed", {
          vaultPath,
          err: (err as Error).message,
        });
      }
    }
  }
}

/**
 * 把老 user-level settings 里的 `vault.recentPaths` 抽出来，回填给 user-cache 的
 * `recentVaults`。仅迁移**一次**：app 启动时如果发现新 user-cache 还没初始化，调一次。
 *
 * 调用方负责拿到老 recentPaths 后调 user-cache-store.patchUserCache 写入。
 * 这里只负责"读出来"，避免与 user-cache-store 形成循环依赖。
 */
export async function readLegacyRecentVaultPaths(): Promise<string[]> {
  const fp = legacyPath(LEGACY_SETTINGS);
  const legacy = await readJsonOrNull<LegacySettingsShape>(fp);
  if (!legacy?.vault?.recentPaths) return [];
  if (!Array.isArray(legacy.vault.recentPaths)) return [];
  return legacy.vault.recentPaths.filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
}

/** 老 user-level settings 里 `vault.path`，用作启动时 lastVault 兜底。 */
export async function readLegacyLastVault(): Promise<string | null> {
  const fp = legacyPath(LEGACY_SETTINGS);
  const legacy = await readJsonOrNull<LegacySettingsShape>(fp);
  const v = legacy?.vault?.path;
  return typeof v === "string" && v.length > 0 ? v : null;
}
