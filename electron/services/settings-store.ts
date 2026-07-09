/**
 * Vault 级应用设置持久化。
 *
 * 文件位置：`{vault}/.stela/settings.json`
 *
 * 设计：
 *   - `vault.recentFiles` 已迁到 `recent-files.local.json`（机器本地，不进 Git）。
 *   - 缺字段一律走 `DEFAULTS` 兜底；首次开 vault 没有 settings 文件时 `loadAppSettings`
 *     直接返回 defaults，不写盘——首次 patch 触发的 writeRaw 才会真正落文件。
 *   - 写策略：原子写（.tmp + rename）。
 */

import { promises as fs } from "node:fs";

import { AppError } from "@shared/errors";
import type {
  AiSettings,
  AppSettings,
  ExecutionSettings,
  GitSettings,
  PartialAppSettings,
  RecentFileEntry,
  ThemeMode,
  EditorWidth,
} from "@shared/types";

import { atomicWriteFile } from "./atomic-write";
import {
  loadRecentFiles,
  migrateFromSettingsIfNeeded,
  saveRecentFiles,
} from "./recent-files-store";
import { vaultFilePath } from "./vault-paths";

const FILE_NAME = "settings.json";

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

const AI_DEFAULT: AiSettings = {
  providerMode: "disabled",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  hasApiKey: false,
  sendResultSamples: true,
  maxSampleRows: 20,
  agentMaxIterations: 200,
  agentWallClockMs: 300_000,
  agentAllowMutations: false,
};

/** 单次查询默认最大返回行数；`0` = 不限制。见 [sql-limit.ts](./sql-limit.ts)。 */
const EXECUTION_DEFAULT: ExecutionSettings = { onError: "continue", maxRows: 1000 };

const DEFAULTS: AppSettings = {
  vault: { recentFiles: [] },
  appearance: { theme: "system" },
  execution: { ...EXECUTION_DEFAULT },
  persistence: { cleanupMonths: 12 },
  ui: { defaultPageSize: 200, editorWidth: "narrow" },
  git: { ...GIT_DEFAULT },
  ai: { ...AI_DEFAULT },
};

interface RawSettings {
  vault?: Record<string, unknown>;
  appearance?: { theme?: ThemeMode };
  execution?: { onError?: "continue" | "stop"; maxRows?: number };
  persistence?: { cleanupMonths?: number };
  ui?: { defaultPageSize?: number; editorWidth?: EditorWidth };
  git?: Partial<GitSettings>;
  ai?: Partial<AiSettings>;
}

function sanitizeAi(input: unknown): AiSettings {
  if (!input || typeof input !== "object") return { ...AI_DEFAULT };
  const r = input as Record<string, unknown>;
  const providerMode =
    r.providerMode === "openai-compatible" || r.providerMode === "cloud"
      ? r.providerMode
      : "disabled";
  const baseUrl = typeof r.baseUrl === "string" ? r.baseUrl.trim() : "";
  const model = typeof r.model === "string" ? r.model.trim() : "";
  const maxSampleRows =
    typeof r.maxSampleRows === "number" && Number.isFinite(r.maxSampleRows)
      ? Math.min(100, Math.max(0, Math.floor(r.maxSampleRows)))
      : AI_DEFAULT.maxSampleRows;
  const agentMaxIterations =
    typeof r.agentMaxIterations === "number" && Number.isFinite(r.agentMaxIterations)
      ? Math.min(10_000, Math.max(1, Math.floor(r.agentMaxIterations)))
      : AI_DEFAULT.agentMaxIterations;
  const agentWallClockMs =
    typeof r.agentWallClockMs === "number" && Number.isFinite(r.agentWallClockMs)
      ? Math.min(600_000, Math.max(5_000, Math.floor(r.agentWallClockMs)))
      : AI_DEFAULT.agentWallClockMs;
  return {
    providerMode,
    baseUrl: baseUrl || AI_DEFAULT.baseUrl,
    model: model || AI_DEFAULT.model,
    hasApiKey: r.hasApiKey === true,
    sendResultSamples:
      r.sendResultSamples === undefined
        ? AI_DEFAULT.sendResultSamples
        : r.sendResultSamples === true,
    maxSampleRows,
    agentMaxIterations,
    agentWallClockMs,
    agentAllowMutations: r.agentAllowMutations === true,
  };
}

function sanitizeExecution(input: unknown): ExecutionSettings {
  if (!input || typeof input !== "object") return { ...EXECUTION_DEFAULT };
  const r = input as Record<string, unknown>;
  const onError = r.onError === "stop" ? "stop" : "continue";
  const maxRows =
    typeof r.maxRows === "number" && Number.isFinite(r.maxRows)
      ? Math.max(0, Math.floor(r.maxRows))
      : EXECUTION_DEFAULT.maxRows;
  return { onError, maxRows };
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

function stripRecentFilesFromRaw(raw: RawSettings): RawSettings {
  if (!raw.vault || !("recentFiles" in raw.vault)) return raw;
  const { recentFiles: _removed, ...rest } = raw.vault;
  const next: RawSettings = { ...raw };
  if (Object.keys(rest).length > 0) {
    next.vault = rest;
  } else {
    delete next.vault;
  }
  return next;
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
  await atomicWriteFile(
    filePath(vaultPath),
    JSON.stringify(stripRecentFilesFromRaw(raw), null, 2),
  );
}

async function resolveRecentFiles(
  vaultPath: string,
  raw: RawSettings,
): Promise<RecentFileEntry[]> {
  const legacy = raw.vault?.recentFiles;
  if (legacy !== undefined) {
    const migrated = await migrateFromSettingsIfNeeded(vaultPath, legacy);
    if (migrated) {
      await writeRaw(vaultPath, raw);
    }
  }
  return loadRecentFiles(vaultPath);
}

/** IPC 入口：renderer 通过 `settings.load` 拿到的就是这个返回值。 */
export async function loadAppSettings(
  vaultPath: string,
): Promise<AppSettings> {
  const raw = await readRaw(vaultPath);
  const recentFiles = await resolveRecentFiles(vaultPath, raw);
  return {
    vault: { recentFiles },
    appearance: {
      theme: raw.appearance?.theme ?? DEFAULTS.appearance.theme,
    },
    execution: sanitizeExecution(raw.execution),
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
    ai: sanitizeAi(raw.ai),
  };
}

export async function patchAppSettings(
  vaultPath: string,
  partial: PartialAppSettings,
): Promise<AppSettings> {
  const raw = await readRaw(vaultPath);
  const next: RawSettings = { ...raw };
  if (partial.vault?.recentFiles !== undefined) {
    await saveRecentFiles(vaultPath, partial.vault.recentFiles);
  }
  if (partial.vault !== undefined) {
    const { recentFiles: _removed, ...vaultRest } = partial.vault;
    if (Object.keys(vaultRest).length > 0) {
      next.vault = { ...raw.vault, ...vaultRest };
    }
  }
  if (partial.appearance !== undefined) {
    next.appearance = { ...raw.appearance, ...partial.appearance };
  }
  if (partial.execution !== undefined) {
    next.execution = sanitizeExecution({ ...raw.execution, ...partial.execution });
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
  if (partial.ai !== undefined) {
    next.ai = sanitizeAi({
      ...raw.ai,
      ...partial.ai,
    });
  }
  await writeRaw(vaultPath, next);
  return loadAppSettings(vaultPath);
}

/** Defaults 暴露给 renderer 在没打开 vault 时兜底用。 */
export function getDefaultAppSettings(): AppSettings {
  return JSON.parse(JSON.stringify(DEFAULTS)) as AppSettings;
}
