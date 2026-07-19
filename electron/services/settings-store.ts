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
  AiProviderProfile,
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

const AI_CONTEXT_WINDOWS = new Set([64_000, 128_000, 200_000, 256_000, 1_000_000]);

const DEFAULT_PROFILE_ID = "default";

function snapContextWindow(value: unknown, fallback: AiSettings["contextWindow"]): AiSettings["contextWindow"] {
  if (typeof value === "number" && AI_CONTEXT_WINDOWS.has(Math.floor(value))) {
    return Math.floor(value) as AiSettings["contextWindow"];
  }
  return fallback;
}

function guessVendorId(baseUrl: string): string {
  const u = baseUrl.toLowerCase();
  if (u.includes("deepseek")) return "deepseek";
  if (u.includes("minimaxi.com") || u.includes("minimax.cn")) return "minimax-cn";
  if (u.includes("minimax")) return "minimax";
  if (u.includes("openai.com")) return "openai";
  if (u.includes("moonshot")) return "moonshotai";
  return "custom";
}

function sanitizeProfile(input: unknown, fallbackHasKey: boolean): AiProviderProfile | null {
  if (!input || typeof input !== "object") return null;
  const r = input as Record<string, unknown>;
  const id = typeof r.id === "string" && r.id.trim() ? r.id.trim() : "";
  if (!id) return null;
  const vendorId =
    typeof r.vendorId === "string" && r.vendorId.trim() ? r.vendorId.trim() : "custom";
  const model = typeof r.model === "string" ? r.model.trim() : "";
  const baseUrl = typeof r.baseUrl === "string" ? r.baseUrl.trim() : "";
  const name =
    typeof r.name === "string" && r.name.trim()
      ? r.name.trim()
      : vendorId === "custom"
        ? "Custom"
        : vendorId;
  return {
    id,
    name,
    vendorId,
    model: model || "gpt-4o-mini",
    baseUrl: baseUrl || (vendorId === "custom" ? "https://api.openai.com/v1" : ""),
    contextWindow: snapContextWindow(r.contextWindow, 128_000),
    hasApiKey: r.hasApiKey === true || fallbackHasKey,
  };
}

function syncActiveMirrors(ai: Omit<AiSettings, "baseUrl" | "model" | "hasApiKey" | "contextWindow"> & {
  baseUrl?: string;
  model?: string;
  hasApiKey?: boolean;
  contextWindow?: AiSettings["contextWindow"];
}): AiSettings {
  const active =
    ai.profiles.find((p) => p.id === ai.activeProfileId) ?? ai.profiles[0] ?? null;
  const activeProfileId = active?.id ?? DEFAULT_PROFILE_ID;
  const profiles =
    ai.profiles.length > 0
      ? ai.profiles
      : [
          {
            id: DEFAULT_PROFILE_ID,
            name: "Default",
            vendorId: "custom",
            model: "gpt-4o-mini",
            baseUrl: "https://api.openai.com/v1",
            contextWindow: 128_000 as AiSettings["contextWindow"],
            hasApiKey: false,
          },
        ];
  const profile = profiles.find((p) => p.id === activeProfileId) ?? profiles[0];
  return {
    ...ai,
    activeProfileId: profile.id,
    profiles,
    baseUrl: profile.baseUrl,
    model: profile.model,
    hasApiKey: profile.hasApiKey,
    contextWindow: profile.contextWindow,
  };
}

const AI_DEFAULT: AiSettings = syncActiveMirrors({
  providerMode: "disabled",
  activeProfileId: DEFAULT_PROFILE_ID,
  profiles: [
    {
      id: DEFAULT_PROFILE_ID,
      name: "Default",
      vendorId: "custom",
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 128_000,
      hasApiKey: false,
    },
  ],
  sendResultSamples: true,
  maxSampleRows: 20,
  agentMaxIterations: 200,
  agentWallClockMs: 300_000,
  agentAllowMutations: false,
});

/** 单次查询默认最多保存/展示的结果行数；`0` = 不限制。 */
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
  ai?: Record<string, unknown>;
}

function sanitizeAi(input: unknown): AiSettings {
  if (!input || typeof input !== "object") return { ...AI_DEFAULT };
  const r = input as Record<string, unknown>;
  const providerMode =
    r.providerMode === "openai-compatible" || r.providerMode === "cloud"
      ? r.providerMode
      : "disabled";
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

  const legacyHasKey = r.hasApiKey === true;
  let profiles: AiProviderProfile[] = [];
  if (Array.isArray(r.profiles)) {
    for (const item of r.profiles) {
      const profile = sanitizeProfile(item, false);
      if (profile) profiles.push(profile);
    }
  }
  if (profiles.length === 0) {
    const baseUrl =
      typeof r.baseUrl === "string" && r.baseUrl.trim()
        ? r.baseUrl.trim()
        : AI_DEFAULT.baseUrl;
    const model =
      typeof r.model === "string" && r.model.trim() ? r.model.trim() : AI_DEFAULT.model;
    const vendorId = guessVendorId(baseUrl);
    profiles = [
      {
        id: DEFAULT_PROFILE_ID,
        name: vendorId === "custom" ? "Default" : vendorId,
        vendorId,
        model,
        baseUrl: vendorId === "custom" ? baseUrl : baseUrl,
        contextWindow: snapContextWindow(r.contextWindow, AI_DEFAULT.contextWindow),
        hasApiKey: legacyHasKey,
      },
    ];
  }

  const activeProfileId =
    typeof r.activeProfileId === "string" && r.activeProfileId.trim()
      ? r.activeProfileId.trim()
      : profiles[0]?.id ?? DEFAULT_PROFILE_ID;

  return syncActiveMirrors({
    providerMode,
    activeProfileId,
    profiles,
    sendResultSamples:
      r.sendResultSamples === undefined
        ? AI_DEFAULT.sendResultSamples
        : r.sendResultSamples === true,
    maxSampleRows,
    agentMaxIterations,
    agentWallClockMs,
    agentAllowMutations: r.agentAllowMutations === true,
  });
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
