/**
 * 跨进程共享 DTO。
 *
 * Renderer 通过 preload typed API 间接消费这些类型；main 端 IPC handler 也直接消费。
 * 所有结构都是 plain JSON-serializable，避免传递 class 实例 / Symbol / Function。
 */

// ---------- File system ----------

export interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
}

// ---------- Storage (SQLite) ----------

export interface ColumnDef {
  name: string;
  /** 原始数据库列类型字符串（VARCHAR、DATETIME、BLOB 等） */
  typeName: string;
}

export interface RunRecord {
  runId: string;
  blockId: string;
  sql: string;
  status: "ok" | "err" | "running";
  message: string | null;
  /** Unix epoch ms */
  startedAt: number;
  elapsedMs: number;
  rowCount: number;
  connectionName: string;
  /**
   * 触发该 run 的 vault 文件绝对路径（v0.2 #5 新增）。
   * 历史 run 在加列前没有 path，会是 null —— Run History 视图允许 null，
   * 此时点击行只显示 SQL 详情、不跳文件。
   */
  notePath: string | null;
}

export interface RowsPage {
  offset: number;
  limit: number;
  rows: unknown[][];
  total: number;
}

// ---------- Connectors ----------

export interface ConnectorKindMeta {
  kind: string;
  displayName: string;
  configSchema: unknown;
  defaultConfig: unknown;
  /** 是否子进程实现 */
  subprocess: boolean;
}

/**
 * 插件来源：
 *   - `builtin`：编译进 main 进程（v0.5 起核心已无内置 connector，保留枚举值兼容）
 *   - `subprocess`：stdio JSON-RPC 子进程插件
 *   - `module`：进程内 JS 模块插件（`{vault}/.stela/plugins/<id>/`，完整权限运行）
 */
export type PluginSource = "builtin" | "subprocess" | "module";

/** Plugins 设置面板用：列出每个已注册 connector 的元数据 + 子进程健康。 */
export interface PluginInfo {
  kind: string;
  displayName: string;
  source: PluginSource;
  /** 子进程插件的可执行路径（builtin 为 undefined） */
  exePath?: string;
  /** 子进程命令行参数（builtin 为 undefined） */
  args?: string[];
  /** module 插件安装目录（`{vault}/.stela/plugins/<id>/`；其它来源为 undefined） */
  dir?: string;
  /** 仅子进程：当前是否存活（false 表示曾启动失败 / 已退出） */
  alive?: boolean;
  /** module 插件加载失败原因（成功加载为 undefined） */
  loadError?: string;
  /** 子进程 stderr 最近若干行（仅 subprocess；其它来源一律为空数组） */
  recentLogs: string[];
}

/** 安装新子进程插件的入参。env 可选；exePath 在 main 端不做白名单校验，由用户负责。 */
export interface PluginInstallInput {
  exePath: string;
  args?: string[];
  env?: Record<string, string>;
}

/** 安装 module 插件的入参：指向一个含 plugin.json + entry 的目录。 */
export interface ModulePluginInstallInput {
  /** 插件包目录绝对路径（含 plugin.json 与已构建的 entry）。 */
  srcDir: string;
}

/** 应用自带的可一键安装的 module 插件（catalog 条目）。 */
export interface BundledPluginInfo {
  id: string;
  kind: string;
  displayName: string;
  /** 当前 vault 是否已安装该 kind。 */
  installed: boolean;
}

export type QueryResult =
  | {
      kind: "query";
      columns: ColumnDef[];
      rows: unknown[][];
      elapsedMs: number;
    }
  | {
      kind: "mutation";
      affectedRows: number;
      elapsedMs: number;
    };

export interface TestResult {
  ok: boolean;
  message?: string;
  latencyMs?: number;
}

/** main → renderer 错误归一化：保留原始 code，不暴露内部堆栈 */
export interface IpcErrorPayload {
  code: string;
  message: string;
  retryable?: boolean;
}

// ---------- Search ----------

export interface SearchHit {
  path: string;
  /** 1-based */
  line: number;
  /** 1-based */
  column: number;
  snippet: string;
}

export interface SearchOptions {
  caseSensitive?: boolean;
  maxHits?: number;
}

// ---------- Settings & connections (store) ----------

export type ThemeMode = "light" | "dark" | "system";
export type LocaleMode = "system" | "zh" | "en";

export interface AppearanceSettings {
  theme: ThemeMode;
}

export interface ExecutionSettings {
  onError: "continue" | "stop";
}

export interface PersistenceSettings {
  cleanupMonths: number;
}

export type EditorWidth = "narrow" | "wide";

export interface UISettings {
  defaultPageSize: number;
  editorWidth: EditorWidth;
}

/**
 * 知识库（RAG / 语义检索）开关。落 vault 级 settings，与 `sync.enabled` 同等地位。
 *
 * 关闭时：
 *   - main 进程的 indexer / embedder / vault-watcher 钩子都不启动
 *   - retriever.search 直接返回空，UI 通过 status.enabled=false 显示禁用 banner
 *   - provider API key 不进入 settings；由 main 端 safeStorage 包裹后按设备保存
 *   - result samples 只按上限截取，完整结果集不会进入 prompt
 *
 * 默认 `false`：v0.4 初版 RAG 在 macOS arm64 上跑大 vault 时观察到 onnxruntime
 * BFCArena 偶发 native abort，先让用户主动开启，避免影响其他基础功能。
 */
export type AiProviderMode = "disabled" | "openai-compatible" | "cloud";

export interface AiSettings {
  providerMode: AiProviderMode;
  /** OpenAI-compatible endpoint. Empty means use the provider default. */
  baseUrl: string;
  /** Model name passed to the provider. */
  model: string;
  /** Whether this vault has a device-local API key saved via safeStorage. */
  hasApiKey: boolean;
  /** Allow sampled result rows to be sent to the provider. Full result sets are never sent. */
  sendResultSamples: boolean;
  /** Per-request row sample cap. */
  maxSampleRows: number;
  /** Enable ghost-text SQL completion in RunSQL blocks. */
  inlineCompletionEnabled: boolean;
  /** FIM completions endpoint root. DeepSeek requires the /beta base URL. */
  fimBaseUrl: string;
  /** Model name passed to the FIM completions endpoint. */
  fimModel: string;
}

/**
 * 最近打开的文件条目。持久化在 `{vault}/.stela/recent-files.local.json`（机器本地，
 * 不进 Git）；仍通过 AppSettings.vault.recentFiles 暴露给 renderer。
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
 * AppSettings = `{vault}/.stela/settings.json` 的内容契约。
 *
 * v0.1 重构前 `vault.path` / `vault.recentPaths` / 跨 vault 偏好曾混在这里。
 * 现在跨 vault / 跨设置作用域：
 *   - "上次打开的 vault" + "最近 vault 列表"：由 [UserCache](#user-cache) 持久化在 userData
 *   - recentFiles：per-vault 但机器本地（recent-files.local.json，不进 Git）
 *   - 其它字段（appearance / execution / persistence / ui / git / ai）：per-vault，可 Git 同步
 */
export interface AppSettings {
  vault: VaultSettings;
  appearance: AppearanceSettings;
  execution: ExecutionSettings;
  persistence: PersistenceSettings;
  ui: UISettings;
  /** Git 版本控制配置（替代 v0.2 的 COS 对象存储同步）。 */
  git: GitSettings;
  /** Search-first AI provider configuration. Secrets are stored separately per device. */
  ai: AiSettings;
}

/**
 * Git 版本控制设置（vault 级，落 `{vault}/.stela/settings.json` 的 `git` group）。
 *
 * 不含任何凭据：远端认证完全委托系统 git（SSH agent / GCM / Keychain）。
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

export type PartialAppSettings = {
  [K in keyof AppSettings]?: Partial<AppSettings[K]>;
};

export interface ConnectionEntry {
  kind: string;
  config: unknown;
  /** 同步表结构到 Markdown 的目标目录 */
  schemaDir?: string;
}

export type ConnectionMap = Record<string, ConnectionEntry>;

// ---------- User cache (cross-vault, machine-level) ----------

/**
 * 跨 vault 的用户级缓存。落盘在 `{userData}/stela-cache.json`。
 *
 * 这是 vault 化重构后**唯一**还放在 userData 的应用状态，存储边界刻意收窄到：
 *   - 启动恢复：lastVault
 *   - Welcome 页"最近 vault 列表"：recentVaults
 *
 * 任何与 vault 内容耦合的偏好（connections / plugins）都不应进这里。
 */
export interface UserCache {
  recentVaults: string[];
  lastVault: string | null;
  /** UI language preference. `system` resolves via navigator.language. */
  locale: LocaleMode;
  /** Last automatic update check timestamp. Manual checks do not rely on this throttle. */
  updateLastCheckedAt: number | null;
}

export type PartialUserCache = Partial<UserCache>;

// ---------- Privacy / credential storage ----------

/**
 * 凭据存储后端状态。renderer 调 `window.stela.privacy.getStatus()` 获得，
 * 用于 Settings → Security 与 Connections 页 banner 的动态文案。
 */
export interface CredentialStorageStatus {
  /** safeStorage.isEncryptionAvailable()，true 表示密码会被 OS keychain 加密。 */
  available: boolean;
  /** 实际使用的后端；available=false 时退化为 "plain"（带 `__plain:` 前缀写盘）。 */
  backend: "safeStorage" | "plain";
  /** 主进程平台：用于区分 macOS Keychain / Windows DPAPI / Linux libsecret 文案。 */
  platform: NodeJS.Platform;
}

// ---------- Search-first AI ----------

export type AiActionKind =
  | "rewrite-sql"
  | "ask-sql"
  | "generate-sql"
  | "explain-sql"
  | "optimize-sql"
  | "debug-query"
  | "explain-result"
  | "summarize-diff"
  | "find-anomalies"
  | "write-analysis"
  | "rewrite-selection"
  | "add-limitations"
  | "explain-table"
  | "suggest-joins"
  | "generate-data-dictionary"
  | "find-related-queries";

export type AiContextSource = "runsql" | "result" | "editor" | "schema";

export interface AiSchemaColumnContext {
  name: string;
  typeName: string;
}

export interface AiSchemaTargetContext {
  connectionName?: string | null;
  database?: string | null;
  table?: string | null;
  columns?: AiSchemaColumnContext[];
  ddlSnippet?: string | null;
  source?: "explicit-sql" | "schema-dir" | "connector" | "manual";
  matchReason?: string | null;
  score?: number;
}

export type AiPromptLocale = "zh" | "en";

export interface AiConnectorContext {
  kind: string;
  displayName: string;
  dialect: string;
}

export interface AiResultContext {
  runId?: string | null;
  blockId?: string | null;
  rowCount?: number | null;
  columns?: AiSchemaColumnContext[];
  rows?: unknown[][];
  diffSummary?: {
    addedRows: number;
    removedRows: number;
    changedRows: number;
    schemaChanged: boolean;
  } | null;
}

export interface AiRequestContext {
  source: AiContextSource;
  notePath?: string | null;
  noteTitle?: string | null;
  noteMarkdown?: string | null;
  headingPath?: string[];
  connectionName?: string | null;
  connector?: AiConnectorContext | null;
  sql?: string | null;
  selectedText?: string | null;
  errorMessage?: string | null;
  result?: AiResultContext | null;
  schema?: AiSchemaTargetContext | null;
  schemas?: AiSchemaTargetContext[];
  /** 用户在 AI 输入框里通过 @ 显式引用的表名（`db.table` 或 `table`）。 */
  mentionedTables?: string[];
  userInstruction?: string | null;
}

export interface AiCompleteRequest {
  action: AiActionKind;
  locale?: AiPromptLocale;
  context: AiRequestContext;
}

export interface AiCompleteResponse {
  action: AiActionKind;
  text: string;
  sql: string | null;
  warnings: string[];
  contextSummary: string[];
}

export interface AiFimCompleteRequest {
  prompt: string;
  suffix: string;
  connectionName?: string | null;
}

export interface AiFimCompleteResponse {
  text: string;
}

export interface AiProviderStatus {
  enabled: boolean;
  providerMode: AiProviderMode;
  model: string;
  baseUrl: string;
  hasApiKey: boolean;
  credentialBackend: "safeStorage" | "plain";
}

// ---------- Wiki / Vault index（v0.3 双链 M2/M3） ----------

/**
 * 自动补全 / Quick-open 候选。`target` 是 wiki link 直接可用的 path-strict
 * 字符串（vault 根相对，去扩展名）；heading 候选还会带 `#anchor`。
 */
export interface IndexCandidate {
  /** "file" 表示笔记本身；"heading" 表示笔记某级标题；"blockId" 留给后续 RunSQL 整合 */
  kind: "file" | "heading" | "blockId";
  /** wiki link 写入 [[...]] 时填的字符串 */
  target: string;
  /** 用户可见标签 */
  label: string;
  /** 副信息（路径、heading 级别等） */
  detail: string;
  /** 排序分；renderer 端不必关心实际数值，按降序排列即可 */
  score: number;
}

/** Backlinks 面板单条记录。snippet 已含两侧省略号。 */
export interface IndexBacklinkEntry {
  sourcePath: string;
  sourceTitle: string;
  /** 1-based */
  line: number;
  /** 1-based */
  column: number;
  snippet: string;
}

/** 当前文件的索引摘要。EditorView 顶部 metadata 行 / Hover 浮层后续可用。 */
export interface IndexEntrySummary {
  path: string;
  /** vault 根相对 POSIX 路径 */
  relPath: string;
  title: string;
  headings: { id: string; text: string; level: number }[];
  outgoingCount: number;
}

// ---------- Auto update（macOS first） ----------

export type UpdaterState =
  | "idle"
  | "disabled"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error";

export interface UpdaterProgress {
  percent: number;
  bytesPerSecond: number;
  transferred?: number;
  total?: number;
}

export interface UpdaterStatus {
  state: UpdaterState;
  currentVersion: string;
  version: string | null;
  releaseDate: string | null;
  releaseNotes: string | null;
  progress: UpdaterProgress | null;
  lastCheckedAt: number | null;
  error: string | null;
}

// ---------- Git 版本控制（移植自 tolaria，替代 COS 同步） ----------

/** 单条提交记录（文件历史 / commit 列表）。 */
export interface GitCommit {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  /** Unix epoch ms */
  date: number;
}

/** 工作区单个变更文件。 */
export interface GitModifiedFile {
  /** vault 根相对 POSIX 路径 */
  path: string;
  /** porcelain 双字符状态归一化后的简写：M / A / D / R / ? / U(conflict) */
  status:
    | "modified"
    | "added"
    | "deleted"
    | "renamed"
    | "untracked"
    | "conflict";
  /** 可选行级统计（includeStats 时填充） */
  additions?: number;
  deletions?: number;
}

/** 远端连接状态。状态栏与 Settings 用。 */
export interface GitRemoteStatus {
  hasRemote: boolean;
  branch: string | null;
  /** 本地领先远端的提交数 */
  ahead: number;
  /** 本地落后远端的提交数 */
  behind: number;
  remoteUrl: string | null;
}

/** pull 结果。冲突时 conflicted=true，UI 打开冲突解决流程。 */
export interface GitPullResult {
  ok: boolean;
  /** 是否真的拉到了新提交（影响是否要刷新 vault index / 重读 tab） */
  updated: boolean;
  conflicted: boolean;
  /** 冲突时的合并模式（merge / rebase），none 表示未进入冲突态 */
  conflictMode: GitConflictMode;
  message: string;
}

/** push 结果。pullRequired=true 表示远端有新提交，需要先 pull。 */
export interface GitPushResult {
  ok: boolean;
  pullRequired: boolean;
  message: string;
}

/** add remote 结果。 */
export interface GitAddRemoteResult {
  ok: boolean;
  /** 远端是否已有历史（非空仓库）；UI 据此提示是否需要先 pull */
  remoteHasHistory: boolean;
  message: string;
}

export interface GitAuthorIdentity {
  name: string;
  email: string;
}

export type GitConflictMode = "none" | "merge" | "rebase";

export type GitConflictStrategy = "ours" | "theirs";

/** Pulse（vault 级活动流）单条提交，含改动文件清单。 */
export interface GitPulseCommit {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  /** Unix epoch ms */
  date: number;
  files: GitPulseFile[];
}

export interface GitPulseFile {
  /** vault 根相对 POSIX 路径 */
  path: string;
  status: "modified" | "added" | "deleted" | "renamed";
}

/** vault 当前 Git 概览，供状态栏一次性拉取。 */
export interface GitVaultStatus {
  isRepo: boolean;
  branch: string | null;
  hasRemote: boolean;
  ahead: number;
  behind: number;
  /** 工作区变更文件数（含 untracked，不含 conflict 单列） */
  changedCount: number;
  /** 处于冲突状态的文件数 */
  conflictCount: number;
  conflictMode: GitConflictMode;
}

// ---------- 执行历史 Journal（按设备分片 JSONL，Git 同步） ----------

/** 机器级设备标识。`{userData}/device-profile.json`，不进 vault / git。 */
export interface DeviceProfile {
  /** 稳定 UUID，用于检测两机误用同一 slug。 */
  deviceId: string;
  /** 文件名片段：`history_{slug}.jsonl`。用户可改。 */
  slug: string;
}

/** 一个 JSONL 历史文件的导入进度（list-sources 返回）。 */
export interface JournalSource {
  /** vault 根相对 POSIX 路径，如 `.stela/history/history_macbook.jsonl` */
  relPath: string;
  /** 仅文件名（不含目录），如 `history_macbook.jsonl` 或段文件 `history_macbook.000001.jsonl` */
  fileName: string;
  /** 文件名解析出的 slug（段文件会还原成基础 slug，便于按设备聚合） */
  slug: string;
  /** 是否本机正在写入的活动文件（非段文件） */
  isCurrentDevice: boolean;
  /** 文件字节数 */
  sizeBytes: number;
  /** 已消费到的字节 offset（cursor） */
  importedBytes: number;
}

/** 一次增量导入的汇总。 */
export interface JournalImportSummary {
  /** 扫描到的 JSONL 文件数 */
  files: number;
  /** 本次新解析的行数 */
  linesRead: number;
  /** 实际写入 SQLite 的 run 数（INSERT OR IGNORE 去重后） */
  imported: number;
  /** 解析失败被跳过的行数 */
  skipped: number;
  elapsedMs: number;
}

/**
 * 一次按日期清理的汇总。
 *
 * 删除策略：
 *   - 对每个 JSONL（活动文件 + 段文件）逐行解析，丢弃 `record.startedAt < cutoff`
 *     的行；保留行原子重写回原文件。
 *   - 全空（一行都不剩）的段文件直接删除；活动文件清空但保留（写侧仍会向它 append）。
 *   - 同步从 SQLite 删掉对应 run（runs 表 startedAt < cutoff 的级联清除），与文件
 *     重写在同一调用中完成，避免缓存里残留指向已删 JSONL 行的 run。
 *   - 重写后所有 journal 游标被重置为 0：下次 incremental import 会从 0 开始重扫，
 *     INSERT OR IGNORE 自然去重，不会重复写入。
 */
export interface JournalCleanupSummary {
  /** 截止时间（Unix epoch ms）。早于该时间的 run 视为「旧」。 */
  cutoff: number;
  /** 处理过的 JSONL 文件数（含活动文件 + 段文件） */
  files: number;
  /** 被重写的文件数（即至少删掉一行的文件） */
  filesRewritten: number;
  /** 完全清空后被删除的段文件数（活动文件即使空也不删） */
  filesDeleted: number;
  /** 删除的 JSONL 行总数 */
  linesDeleted: number;
  /** 从 SQLite 中删除的 run 行数 */
  runsDeleted: number;
  elapsedMs: number;
}

// ---------- Git 统一同步编排结果 ----------

/** "同步推送"：commit 全部变更（含 JSONL）→ 可选 push。 */
export interface GitSyncPushResult {
  committed: boolean;
  commitHash: string | null;
  pushed: boolean;
  /** push 被拒（远端领先）→ 需先 pull */
  pullRequired: boolean;
  message: string;
}

/** "同步拉取"：git pull → journal 增量导入 → 触发 vault 刷新。 */
export interface GitSyncPullResult {
  pulled: boolean;
  updated: boolean;
  conflicted: boolean;
  conflictMode: GitConflictMode;
  /** 本次从 JSONL 增量导入的 run 数 */
  imported: number;
  message: string;
}
