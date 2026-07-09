/**
 * 应用层设置（与 [electron/services/settings-store.ts](../../electron/services/settings-store.ts) 对齐）。
 *
 * v0.1 vault 化重构后：
 *   - settings.json 落在 `{vault}/.stela/settings.json`，per-vault、可 Git 同步
 *   - recentFiles 落在 `{vault}/.stela/recent-files.local.json`，机器本地
 *   - 跨 vault 的"上次 vault" / "最近 vault 列表" 走 [user-cache](../../electron/services/user-cache-store.ts)
 */

export type ThemeMode = "light" | "dark" | "system";

export interface AppearanceSettings {
  theme: ThemeMode;
}

export interface ExecutionSettings {
  /** Run All 失败时的策略，M4 仅 UI 暴露，引擎落地在 M5 */
  onError: "continue" | "stop";
  /** 单次查询最大返回行数，核心层对所有只读查询自动追加 LIMIT。0 = 不限制。 */
  maxRows: number;
}

export interface PersistenceSettings {
  /** 保留多少个月的 run history，0 = never */
  cleanupMonths: number;
}

/**
 * Markdown 编辑器正文排版宽度。
 *   - "narrow": 传统阅读宽度（~920px 居中，两侧留白），长文阅读/写作更舒服
 *   - "wide":   占满可用宽度（仅保留左右 padding），适合超宽屏 / 需要横向利用空间
 */
export type EditorWidth = "narrow" | "wide";

export interface UISettings {
  /** BlockResult 默认每页行数 */
  defaultPageSize: number;
  /** 编辑器正文宽度模式 */
  editorWidth: EditorWidth;
}

/**
 * 最近打开的文件条目（持久化到 vault settings，跨会话保留）。
 *
 * v0.1 重构前曾带 `vaultPath` 字段供过滤；现在 settings 文件本身就在 vault 内，
 * 字段不再需要。
 */
export interface RecentFileEntry {
  path: string;
  /** Unix epoch ms */
  openedAt: number;
}

export interface VaultSettings {
  /** 最近打开过的文件列表（按时间倒序、去重、上限 24 条），仅当前 vault 内 */
  recentFiles: RecentFileEntry[];
}

/**
 * Git 版本控制配置（vault 级）。落 `{vault}/.stela/settings.json` 的 `git` group。
 * 替代 v0.2 的 COS 对象存储同步。不含任何凭据：远端认证完全委托系统 git。
 */
export interface GitSettings {
  /** 启用 Git 功能（状态栏 / 命令面板 / 自动同步）。 */
  enabled: boolean;
  /** AutoGit：空闲 / 失焦时自动 checkpoint 提交。 */
  autoCommit: boolean;
  /** 自动 commit 后顺带 push。 */
  autoPush: boolean;
  /** 自动 pull（定时 + 窗口聚焦时）。 */
  autoPull: boolean;
  /** 自动 pull 间隔（毫秒）。 */
  autoPullIntervalMs: number;
}

export type AiProviderMode = "disabled" | "openai-compatible" | "cloud";

export interface AiSettings {
  providerMode: AiProviderMode;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  sendResultSamples: boolean;
  maxSampleRows: number;
  agentMaxIterations: number;
  agentWallClockMs: number;
  agentAllowMutations: boolean;
}

export interface AppSettings {
  vault: VaultSettings;
  appearance: AppearanceSettings;
  execution: ExecutionSettings;
  persistence: PersistenceSettings;
  ui: UISettings;
  git: GitSettings;
  ai: AiSettings;
}

/**
 * `patch` / `patchAppSettings` 的入参类型：顶层 group 可选，每个 group 内部的
 * 字段也都可选，这样调用方可以只写 `{ ui: { editorWidth: "wide" } }` 而无需
 * 把整个 group 的字段补全。
 *
 * TypeScript 的内置 `Partial<AppSettings>` 只让顶层 key 变 optional，group 里
 * 的字段仍然要求齐全——UISettings 从单字段扩展到多字段后这就是坑。
 *
 */
export type PartialAppSettings = {
  [K in keyof AppSettings]?: Partial<AppSettings[K]>;
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
  vault: { recentFiles: [] },
  appearance: { theme: "system" },
  execution: { onError: "continue", maxRows: 1000 },
  persistence: { cleanupMonths: 12 },
  ui: { defaultPageSize: 200, editorWidth: "narrow" },
  git: {
    enabled: true,
    autoCommit: false,
    autoPush: false,
    autoPull: false,
    autoPullIntervalMs: 300_000,
  },
  ai: {
    providerMode: "disabled",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    hasApiKey: false,
    sendResultSamples: true,
    maxSampleRows: 20,
    agentMaxIterations: 200,
    agentWallClockMs: 300_000,
    agentAllowMutations: false,
  },
};

export const CLEANUP_MONTH_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: "Never" },
  { value: 1, label: "1 month" },
  { value: 6, label: "6 months" },
  { value: 12, label: "12 months" },
  { value: 24, label: "24 months" },
];
