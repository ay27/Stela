/**
 * Vault 级应用设置持久化。
 *
 * 文件位置：`{vault}/.stela/settings.json`
 *
 * 设计：
 *   - 内容契约见 [`AppSettings`](../shared/types.ts)。`vault.path` / `vault.recentPaths`
 *     已迁移到 [user-cache-store](./user-cache-store.ts)，这里只剩 per-vault 字段。
 *   - 缺字段一律走 `DEFAULTS` 兜底；首次开 vault 没有 settings 文件时 `loadAppSettings`
 *     直接返回 defaults，不写盘——首次 patch 触发的 writeRaw 才会真正落文件。
 *   - 写策略：原子写（.tmp + rename）。
 */

import { promises as fs } from "node:fs";

import { AppError } from "@shared/errors";
import type {
  AppSettings,
  GitSettings,
  KnowledgeSettings,
  PartialAppSettings,
  RecentFileEntry,
  ThemeMode,
  EditorWidth,
} from "@shared/types";

import { atomicWriteFile } from "./atomic-write";
import { vaultFilePath } from "./vault-paths";

const FILE_NAME = "settings.json";

/** 最近文件列表的硬上限。超过的尾部会被截断。 */
const RECENT_FILES_LIMIT = 24;

/** 自动 pull 间隔下限 / 默认值（毫秒）。 */
const AUTO_PULL_MIN_MS = 30_000;
const AUTO_PULL_DEFAULT_MS = 300_000;

const GIT_DEFAULT: GitSettings = {
  enabled: true,
  autoCommit: false,
  autoPush: false,
  autoPull: false,
  autoPullIntervalMs: AUTO_PULL_DEFAULT_MS,
};

const KNOWLEDGE_DEFAULT: KnowledgeSettings = {
  enabled: false,
};

const DEFAULTS: AppSettings = {
  vault: { recentFiles: [] },
  appearance: { theme: "system" },
  execution: { onError: "continue" },
  persistence: { cleanupMonths: 12 },
  ui: { defaultPageSize: 200, editorWidth: "narrow" },
  git: { ...GIT_DEFAULT },
  knowledge: { ...KNOWLEDGE_DEFAULT },
};

interface RawSettings {
  vault?: {
    recentFiles?: RecentFileEntry[];
  };
  appearance?: { theme?: ThemeMode };
  execution?: { onError?: "continue" | "stop" };
  persistence?: { cleanupMonths?: number };
  ui?: { defaultPageSize?: number; editorWidth?: EditorWidth };
  git?: Partial<GitSettings>;
  knowledge?: Partial<KnowledgeSettings>;
}

function sanitizeKnowledge(input: unknown): KnowledgeSettings {
  if (!input || typeof input !== "object") return { ...KNOWLEDGE_DEFAULT };
  const r = input as Record<string, unknown>;
  return {
    enabled: r.enabled === true,
  };
}

function sanitizeGit(input: unknown): GitSettings {
  if (!input || typeof input !== "object") return { ...GIT_DEFAULT };
  const r = input as Record<string, unknown>;
  const interval =
    typeof r.autoPullIntervalMs === "number" &&
    Number.isFinite(r.autoPullIntervalMs)
      ? Math.max(AUTO_PULL_MIN_MS, Math.floor(r.autoPullIntervalMs))
      : GIT_DEFAULT.autoPullIntervalMs;
  return {
    enabled: r.enabled === undefined ? GIT_DEFAULT.enabled : r.enabled === true,
    autoCommit: r.autoCommit === true,
    autoPush: r.autoPush === true,
    autoPull: r.autoPull === true,
    autoPullIntervalMs: interval,
  };
}

function sanitizeRecentFiles(input: unknown): RecentFileEntry[] {
  if (!Array.isArray(input)) return [];
  const out: RecentFileEntry[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const p = r.path;
    const ts = r.openedAt;
    if (typeof p !== "string" || p.length === 0) continue;
    if (typeof ts !== "number" || !Number.isFinite(ts)) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push({ path: p, openedAt: ts });
    if (out.length >= RECENT_FILES_LIMIT) break;
  }
  return out;
}

function filePath(vaultPath: string): string {
  return vaultFilePath(vaultPath, FILE_NAME);
}

async function readRaw(vaultPath: string): Promise<RawSettings> {
  try {
    const buf = await fs.readFile(filePath(vaultPath), "utf-8");
    return JSON.parse(buf) as RawSettings;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return {};
    throw new AppError(
      "settings_read_failed",
      `read settings failed: ${e.message}`,
    );
  }
}

async function writeRaw(vaultPath: string, raw: RawSettings): Promise<void> {
  await atomicWriteFile(filePath(vaultPath), JSON.stringify(raw, null, 2));
}

/** IPC 入口：renderer 通过 `settings.load` 拿到的就是这个返回值。 */
export async function loadAppSettings(
  vaultPath: string,
): Promise<AppSettings> {
  const raw = await readRaw(vaultPath);
  return {
    vault: {
      recentFiles: sanitizeRecentFiles(raw.vault?.recentFiles),
    },
    appearance: {
      theme: raw.appearance?.theme ?? DEFAULTS.appearance.theme,
    },
    execution: {
      onError: raw.execution?.onError ?? DEFAULTS.execution.onError,
    },
    persistence: {
      cleanupMonths:
        raw.persistence?.cleanupMonths ?? DEFAULTS.persistence.cleanupMonths,
    },
    ui: {
      defaultPageSize:
        raw.ui?.defaultPageSize ?? DEFAULTS.ui.defaultPageSize,
      editorWidth: raw.ui?.editorWidth ?? DEFAULTS.ui.editorWidth,
    },
    git: sanitizeGit(raw.git),
    knowledge: sanitizeKnowledge(raw.knowledge),
  };
}

export async function patchAppSettings(
  vaultPath: string,
  partial: PartialAppSettings,
): Promise<AppSettings> {
  const raw = await readRaw(vaultPath);
  const next: RawSettings = { ...raw };
  if (partial.vault !== undefined) {
    const merged = { ...raw.vault, ...partial.vault };
    if (partial.vault.recentFiles !== undefined) {
      merged.recentFiles = sanitizeRecentFiles(partial.vault.recentFiles);
    }
    next.vault = merged;
  }
  if (partial.appearance !== undefined) {
    next.appearance = { ...raw.appearance, ...partial.appearance };
  }
  if (partial.execution !== undefined) {
    next.execution = { ...raw.execution, ...partial.execution };
  }
  if (partial.persistence !== undefined) {
    next.persistence = { ...raw.persistence, ...partial.persistence };
  }
  if (partial.ui !== undefined) {
    next.ui = { ...raw.ui, ...partial.ui };
  }
  if (partial.git !== undefined) {
    next.git = sanitizeGit({ ...raw.git, ...partial.git });
  }
  if (partial.knowledge !== undefined) {
    next.knowledge = sanitizeKnowledge({
      ...raw.knowledge,
      ...partial.knowledge,
    });
  }
  await writeRaw(vaultPath, next);
  return loadAppSettings(vaultPath);
}

/** Defaults 暴露给 renderer 在没打开 vault 时兜底用。 */
export function getDefaultAppSettings(): AppSettings {
  return JSON.parse(JSON.stringify(DEFAULTS)) as AppSettings;
}
