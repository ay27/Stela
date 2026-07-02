/**
 * Renderer 端 settings 持久化薄封装。
 *
 * 重要：v0.1 vault 化重构后，所有 settings IPC 都要求 main 端有 currentVault。
 * 没有 currentVault 时（启动 / closeVault）调 `loadAppSettings` 会拿到
 * `no_vault` 错误；本层把它转成 DEFAULT_APP_SETTINGS 兜底，让 UI 仍能渲染。
 *
 * "上次 vault" 与 "最近 vault 列表" 走 [user-cache](./user-cache.ts)，
 * 与本文件不再相关。
 */

import {
  DEFAULT_APP_SETTINGS,
  type AppSettings,
  type PartialAppSettings,
} from "@/contracts/settings";
import { getIpcErrorCode } from "@/lib/ipc-error";

/** main 端没 currentVault 时返回的标准错误 code（与 vault-context 对齐）。 */
const NO_VAULT_CODE = "no_vault";

function isNoVault(err: unknown): boolean {
  return getIpcErrorCode(err) === NO_VAULT_CODE;
}

/**
 * 把 main 端返回的 settings 与 `DEFAULT_APP_SETTINGS` 做一次 group 级补齐。
 *
 * 主要目的：处理 dev 阶段 main / preload / renderer 不同步重启的边界——
 *   - 用户 HMR 拿到新 renderer（新 AppSettings 字段，如 `ai`），
 *   - 但 main 进程还没重启 → IPC 返回的 settings 缺新 group
 * 不兜底就直接 `settings.ai.providerMode` undefined 崩 UI。
 *
 * 注意：按 group 做浅合并，避免新增字段（例如 settings.ai 里的开关）在旧 settings
 * 文件或 dev 阶段 main / renderer 不同步时变成 undefined。main 端返回的字段仍覆盖默认值。
 */
export function normalizeSettings(s: AppSettings | undefined | null): AppSettings {
  if (!s || typeof s !== "object") return DEFAULT_APP_SETTINGS;
  return {
    vault: { ...DEFAULT_APP_SETTINGS.vault, ...(s.vault ?? {}) },
    appearance: { ...DEFAULT_APP_SETTINGS.appearance, ...(s.appearance ?? {}) },
    execution: { ...DEFAULT_APP_SETTINGS.execution, ...(s.execution ?? {}) },
    persistence: { ...DEFAULT_APP_SETTINGS.persistence, ...(s.persistence ?? {}) },
    ui: { ...DEFAULT_APP_SETTINGS.ui, ...(s.ui ?? {}) },
    git: { ...DEFAULT_APP_SETTINGS.git, ...(s.git ?? {}) },
    ai: { ...DEFAULT_APP_SETTINGS.ai, ...(s.ai ?? {}) },
  };
}

export async function loadAppSettings(): Promise<AppSettings> {
  try {
    return normalizeSettings(await window.stela.settings.load());
  } catch (err) {
    if (isNoVault(err)) return DEFAULT_APP_SETTINGS;
    console.error("[stela] settings.load failed; falling back to defaults", err);
    return DEFAULT_APP_SETTINGS;
  }
}

/**
 * 写入 settings 并返回 main 端 sanitize / 投影后的真值。
 *
 * Renderer 应当用返回值替换本地 state，而不是只信任本地 mergeSettings 的结果——
 * 因为 main 端会做投影（如 secret wrap → `hasSecretAccessKey: true`）/ 截断 / sanitize。
 *
 * 没打开 vault 时返回 null：这是正常状态（启动 / closeVault），调用方应当
 * 保持本地乐观值不动。
 */
export async function patchAppSettings(
  partial: PartialAppSettings,
): Promise<AppSettings | null> {
  try {
    return normalizeSettings(await window.stela.settings.patch(partial));
  } catch (err) {
    if (isNoVault(err)) return null;
    throw err;
  }
}
