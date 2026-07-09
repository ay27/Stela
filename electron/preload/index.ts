/**
 * Preload：唯一桥接 main / renderer 的脚本。
 *
 * 安全要点：
 * - **不**暴露 ipcRenderer.invoke / send / on
 * - 一项业务能力一个明确方法（vault.readFile、storage.queryPage 等）
 * - 通过 contextBridge.exposeInMainWorld 安全注入到 renderer 的 window.stela
 * - renderer TS 通过 src/types/stela-bridge.d.ts 拿到 window.stela 类型
 *
 * 错误归一化：main IPC handler 抛出的 IpcErrorPayload 会作为 invoke 的 reject value
 * 抵达 renderer。renderer 直接拿 `{ code, message, retryable? }`。
 */

import { clipboard, contextBridge, ipcRenderer, webUtils } from "electron";

import { IPC, type IpcChannel } from "@shared/ipc-channels";
import {
  IPC_EVENTS,
  type VaultExternalChangePayload,
} from "@shared/ipc-events";
import type {
  AgentEvent,
  AgentProposalResponse,
  AgentRunRequest,
  AiCompleteRequest,
  AiCompleteResponse,
  AiFimCompleteRequest,
  AiFimCompleteResponse,
  AiProviderStatus,
  AiSettings,
  AppSettings,
  ColumnDef,
  ConnectionEntry,
  ConnectionMap,
  ConnectorKindMeta,
  CredentialStorageStatus,
  FileNode,
  AiParseSqlQueryRequest,
  AiParseSqlQueryResponse,
  IndexBacklinkEntry,
  IndexCandidate,
  IndexEntrySummary,
  BundledPluginInfo,
  ModulePluginInstallInput,
  PartialAppSettings,
  PartialUserCache,
  PluginInfo,
  PluginInstallInput,
  QueryResult,
  RowsPage,
  RunRecord,
  SearchHit,
  SearchOptions,
  TestResult,
  UserCache,
  UpdaterStatus,
  DeviceProfile,
  GitAddRemoteResult,
  GitAuthorIdentity,
  GitCommit,
  GitConflictMode,
  GitConflictStrategy,
  GitModifiedFile,
  GitPullResult,
  GitPulseCommit,
  GitPushResult,
  GitRemoteStatus,
  GitSyncPullResult,
  GitSyncPushResult,
  GitVaultStatus,
  JournalCleanupSummary,
  JournalImportSummary,
  JournalSource,
  SqlIndexFacets,
  SqlIndexFilter,
  SqlIndexHit,
  SqlIndexStatus,
} from "@shared/types";

function call<T>(channel: IpcChannel, args: object = {}): Promise<T> {
  return ipcRenderer.invoke(channel, args) as Promise<T>;
}

const stela = {
  vault: {
    listDir: (path: string) => call<FileNode[]>(IPC.VAULT_LIST_DIR, { path }),
    readFile: (path: string) => call<string>(IPC.VAULT_READ_FILE, { path }),
    /**
     * 读 vault 内任意二进制文件（图片附件等），返回 base64。renderer 据此拼
     * blob URL 在 `<img>` 上展示——CSP 禁止直接 `file://`。25MB 上限。
     */
    readBinary: (path: string) => call<string>(IPC.VAULT_READ_BINARY, { path }),
    writeFile: (path: string, contents: string) =>
      call<void>(IPC.VAULT_WRITE_FILE, { path, contents }),
    pathExists: (path: string) =>
      call<boolean>(IPC.VAULT_PATH_EXISTS, { path }),
    createDir: (vaultPath: string, path: string) =>
      call<void>(IPC.VAULT_CREATE_DIR, { vaultPath, path }),
    createFile: (vaultPath: string, path: string, contents: string) =>
      call<void>(IPC.VAULT_CREATE_FILE, { vaultPath, path, contents }),
    renamePath: (vaultPath: string, from: string, to: string) =>
      call<void>(IPC.VAULT_RENAME_PATH, { vaultPath, from, to }),
    deletePath: (vaultPath: string, path: string) =>
      call<void>(IPC.VAULT_DELETE_PATH, { vaultPath, path }),
    /**
     * 把 vault 之外的文件复制进 vault。源路径不限位置（renderer 通过
     * `shell.getPathForFile` 从 DataTransfer.File 拿到），目标目录必须落在 vault
     * 内，main 端做 `ensureWithinVault` 守卫。同名自动加 `(1)` 后缀。
     */
    importFile: (vaultPath: string, sourcePath: string, destDir: string) =>
      call<string>(IPC.VAULT_IMPORT_FILE, {
        vaultPath,
        sourcePath,
        destDir,
      }),
    /**
     * 把剪贴板 / 拖拽里的二进制 blob 写到 note 同级的 `<note-stem>.assets/` 目录。
     * 用于 Markdown 编辑器粘贴 / 拖入图片。返回最终绝对路径与相对 note 的 POSIX
     * 相对路径（可直接塞进 `![](...)`)。
     */
    saveAttachment: (
      vaultPath: string,
      notePath: string,
      fileName: string,
      base64: string,
    ) =>
      call<{ absPath: string; relPath: string }>(IPC.VAULT_SAVE_ATTACHMENT, {
        vaultPath,
        notePath,
        fileName,
        base64,
      }),
    storageDbSize: (vaultPath: string) =>
      call<number>(IPC.VAULT_DB_SIZE, { vaultPath }),
    /**
     * 切换 main 端「当前 vault」。会触发：
     *   - shutdown 旧 vault 的 subprocess plugin
     *   - seed `{vault}/.stela/`（仅首次）
     *   - reload 新 vault 的 plugin manifest
     * 之后所有 settings/connections/connector handler 才会落到新 vault。
     * 切完 renderer 应当 refetch settings/connections/plugins。
     */
    setCurrent: (vaultPath: string | null) =>
      call<void>(IPC.VAULT_SET_CURRENT, { vaultPath }),
    getCurrent: () => call<string | null>(IPC.VAULT_GET_CURRENT, {}),
    /**
     * 订阅 main 进程 vault watcher 推送的外部文件变更（v0.2 #7）。
     *
     * 返回 unsubscribe 函数；调用即可取消监听。每次只接收 payload，**不**暴露
     * 通用 ipcRenderer.on，避免 renderer 旁路 typed bridge 监听任意 channel。
     */
    onExternalChange: (
      callback: (payload: VaultExternalChangePayload) => void,
    ) => {
      const handler = (
        _ev: Electron.IpcRendererEvent,
        payload: VaultExternalChangePayload,
      ) => callback(payload);
      ipcRenderer.on(IPC_EVENTS.VAULT_EXTERNAL_CHANGE, handler);
      return () => {
        ipcRenderer.removeListener(IPC_EVENTS.VAULT_EXTERNAL_CHANGE, handler);
      };
    },
  },

  dialog: {
    pickVault: () => call<string | null>(IPC.DIALOG_PICK_VAULT, {}),
    pickDirectory: (opts: { title?: string; defaultPath?: string } = {}) =>
      call<string | null>(IPC.DIALOG_PICK_DIRECTORY, {
        title: opts.title,
        defaultPath: opts.defaultPath,
      }),
    pickFile: (
      opts: {
        title?: string;
        defaultPath?: string;
        filters?: { name: string; extensions: string[] }[];
      } = {},
    ) =>
      call<string | null>(IPC.DIALOG_PICK_FILE, {
        title: opts.title,
        defaultPath: opts.defaultPath,
        filters: opts.filters,
      }),
  },

  settings: {
    load: () => call<AppSettings>(IPC.SETTINGS_LOAD, {}),
    patch: (patch: PartialAppSettings) =>
      call<AppSettings>(IPC.SETTINGS_PATCH, { patch }),
  },

  connections: {
    load: () => call<ConnectionMap>(IPC.CONNECTIONS_LOAD, {}),
    upsert: (name: string, entry: ConnectionEntry) =>
      call<ConnectionMap>(IPC.CONNECTIONS_UPSERT, { name, entry }),
    remove: (name: string) =>
      call<ConnectionMap>(IPC.CONNECTIONS_REMOVE, { name }),
  },

  userCache: {
    load: () => call<UserCache>(IPC.USER_CACHE_LOAD, {}),
    patch: (patch: PartialUserCache) =>
      call<UserCache>(IPC.USER_CACHE_PATCH, { patch }),
  },

  storage: {
    open: (vaultPath: string) => call<void>(IPC.STORAGE_OPEN, { vaultPath }),
    saveRun: (record: RunRecord) =>
      call<void>(IPC.STORAGE_SAVE_RUN, { record }),
    saveSchema: (runId: string, columns: ColumnDef[]) =>
      call<void>(IPC.STORAGE_SAVE_SCHEMA, { runId, columns }),
    saveRows: (runId: string, rows: unknown[][], rowOffset?: number) =>
      call<void>(IPC.STORAGE_SAVE_ROWS, { runId, rows, rowOffset }),
    queryPage: (runId: string, offset: number, limit: number) =>
      call<RowsPage>(IPC.STORAGE_QUERY_PAGE, { runId, offset, limit }),
    getSchema: (runId: string) =>
      call<ColumnDef[]>(IPC.STORAGE_GET_SCHEMA, { runId }),
    listRuns: () => call<RunRecord[]>(IPC.STORAGE_LIST_RUNS, {}),
    listRunsByBlockId: (
      blockId: string,
      options?: {
        limit?: number;
        offset?: number;
        status?: "ok" | "err" | "all";
      },
    ) =>
      call<RunRecord[]>(IPC.STORAGE_LIST_RUNS_BY_BLOCK, {
        blockId,
        limit: options?.limit,
        offset: options?.offset,
        status: options?.status,
      }),
    cleanup: (keepDays: number) =>
      call<number>(IPC.STORAGE_CLEANUP, { keepDays }),
  },

  connector: {
    listKinds: () => call<ConnectorKindMeta[]>(IPC.CONNECTOR_LIST_KINDS, {}),
    test: (kind: string, config: unknown) =>
      call<TestResult>(IPC.CONNECTOR_TEST, { kind, config }),
    execute: (kind: string, config: unknown, sql: string) =>
      call<QueryResult>(IPC.CONNECTOR_EXECUTE, { kind, config, sql }),
    listDatabases: (kind: string, config: unknown) =>
      call<string[]>(IPC.CONNECTOR_LIST_DATABASES, { kind, config }),
    listTables: (kind: string, config: unknown, db?: string | null) =>
      call<string[]>(IPC.CONNECTOR_LIST_TABLES, {
        kind,
        config,
        db: db ?? null,
      }),
    listPlugins: () => call<PluginInfo[]>(IPC.CONNECTOR_LIST_PLUGINS, {}),
    installPlugin: (input: PluginInstallInput) =>
      call<PluginInfo>(IPC.CONNECTOR_INSTALL_PLUGIN, { input }),
    uninstallPlugin: (kind: string) =>
      call<void>(IPC.CONNECTOR_UNINSTALL_PLUGIN, { kind }),
    getPluginLogs: (kind: string) =>
      call<string[]>(IPC.CONNECTOR_GET_PLUGIN_LOGS, { kind }),
    startPlugin: (kind: string) =>
      call<PluginInfo>(IPC.CONNECTOR_START_PLUGIN, { kind }),
    stopPlugin: (kind: string) =>
      call<PluginInfo>(IPC.CONNECTOR_STOP_PLUGIN, { kind }),
    restartPlugin: (kind: string) =>
      call<PluginInfo>(IPC.CONNECTOR_RESTART_PLUGIN, { kind }),
    installModulePlugin: (input: ModulePluginInstallInput) =>
      call<PluginInfo>(IPC.CONNECTOR_INSTALL_MODULE_PLUGIN, { input }),
    listBundledPlugins: () =>
      call<BundledPluginInfo[]>(IPC.CONNECTOR_LIST_BUNDLED_PLUGINS, {}),
    installBundledPlugin: (id: string) =>
      call<PluginInfo>(IPC.CONNECTOR_INSTALL_BUNDLED_PLUGIN, { id }),
  },

  search: {
    vault: (vaultPath: string, keyword: string, options: SearchOptions = {}) =>
      call<SearchHit[]>(IPC.SEARCH_VAULT, {
        vaultPath,
        keyword,
        caseSensitive: options.caseSensitive,
        maxHits: options.maxHits ?? null,
      }),
    listFiles: (vaultPath: string, extensions: string[]) =>
      call<string[]>(IPC.SEARCH_LIST_FILES, { vaultPath, extensions }),
  },

  privacy: {
    getStatus: () => call<CredentialStorageStatus>(IPC.PRIVACY_GET_STATUS, {}),
  },

  ai: {
    getStatus: () => call<AiProviderStatus>(IPC.AI_GET_STATUS, {}),
    configure: (
      settings: Partial<Omit<AiSettings, "hasApiKey">>,
      apiKey?: string | null,
    ) => call<AiProviderStatus>(IPC.AI_CONFIGURE, { settings, apiKey }),
    clearApiKey: () => call<AiProviderStatus>(IPC.AI_CLEAR_API_KEY, {}),
    complete: (request: AiCompleteRequest) =>
      call<AiCompleteResponse>(IPC.AI_COMPLETE, { request }),
    fimComplete: (request: AiFimCompleteRequest) =>
      call<AiFimCompleteResponse>(IPC.AI_FIM_COMPLETE, { request }),
    parseSqlQuery: (request: AiParseSqlQueryRequest) =>
      call<AiParseSqlQueryResponse>(IPC.AI_PARSE_SQL_QUERY, { request }),
  },

  agent: {
    run: (request: AgentRunRequest) => call<{ runId: string }>(IPC.AI_AGENT_RUN, { request }),
    cancel: (runId: string) =>
      call<{ cancelled: boolean }>(IPC.AI_AGENT_CANCEL, { runId }),
    respondProposal: (response: AgentProposalResponse) =>
      call<{ ok: boolean }>(IPC.AI_AGENT_RESPOND_PROPOSAL, response),
    /** 返回 unsubscribe 函数；同 `vault.onExternalChange` 的订阅模式。 */
    onEvent: (callback: (event: AgentEvent) => void) => {
      const handler = (_ev: Electron.IpcRendererEvent, event: AgentEvent) => callback(event);
      ipcRenderer.on(IPC_EVENTS.AI_AGENT_EVENT, handler);
      return () => {
        ipcRenderer.removeListener(IPC_EVENTS.AI_AGENT_EVENT, handler);
      };
    },
  },

  git: {
    isRepo: () => call<boolean>(IPC.GIT_IS_REPO, {}),
    initRepo: () => call<void>(IPC.GIT_INIT_REPO, {}),
    cloneRepo: (remoteUrl: string, localPath: string) =>
      call<string>(IPC.GIT_CLONE_REPO, { remoteUrl, localPath }),
    vaultStatus: () => call<GitVaultStatus>(IPC.GIT_VAULT_STATUS, {}),
    commit: (message: string) => call<string>(IPC.GIT_COMMIT, { message }),
    push: () => call<GitPushResult>(IPC.GIT_PUSH, {}),
    pull: () => call<GitPullResult>(IPC.GIT_PULL, {}),
    remoteStatus: () => call<GitRemoteStatus>(IPC.GIT_REMOTE_STATUS, {}),
    addRemote: (remoteUrl: string) =>
      call<GitAddRemoteResult>(IPC.GIT_ADD_REMOTE, { remoteUrl }),
    modifiedFiles: (includeStats = false) =>
      call<GitModifiedFile[]>(IPC.GIT_MODIFIED_FILES, { includeStats }),
    fileDiff: (relPath: string) => call<string>(IPC.GIT_FILE_DIFF, { relPath }),
    fileDiffAtCommit: (relPath: string, commitHash: string) =>
      call<string>(IPC.GIT_FILE_DIFF_AT_COMMIT, { relPath, commitHash }),
    fileHistory: (relPath: string, limit?: number) =>
      call<GitCommit[]>(IPC.GIT_FILE_HISTORY, { relPath, limit }),
    vaultPulse: (limit?: number, skip?: number) =>
      call<GitPulseCommit[]>(IPC.GIT_VAULT_PULSE, { limit, skip }),
    lastCommit: () => call<GitPulseCommit | null>(IPC.GIT_LAST_COMMIT, {}),
    conflictFiles: () => call<string[]>(IPC.GIT_CONFLICT_FILES, {}),
    conflictMode: () => call<GitConflictMode>(IPC.GIT_CONFLICT_MODE, {}),
    resolveConflict: (file: string, strategy: GitConflictStrategy) =>
      call<void>(IPC.GIT_RESOLVE_CONFLICT, { file, strategy }),
    commitConflictResolution: () =>
      call<string>(IPC.GIT_COMMIT_CONFLICT_RESOLUTION, {}),
    discardFile: (relPath: string) =>
      call<void>(IPC.GIT_DISCARD_FILE, { relPath }),
    authorIdentity: () => call<GitAuthorIdentity>(IPC.GIT_AUTHOR_IDENTITY, {}),
    setAuthorIdentity: (name: string, email: string) =>
      call<void>(IPC.GIT_SET_AUTHOR_IDENTITY, { name, email }),
    syncPush: (message?: string, options?: { push?: boolean }) =>
      call<GitSyncPushResult>(IPC.GIT_SYNC_PUSH, { message, ...options }),
    syncPull: () => call<GitSyncPullResult>(IPC.GIT_SYNC_PULL, {}),
  },

  journal: {
    getDeviceProfile: () =>
      call<DeviceProfile>(IPC.JOURNAL_GET_DEVICE_PROFILE, {}),
    setDeviceSlug: (slug: string) =>
      call<DeviceProfile>(IPC.JOURNAL_SET_DEVICE_SLUG, { slug }),
    appendRun: (runId: string) => call<void>(IPC.JOURNAL_APPEND_RUN, { runId }),
    importIncremental: () =>
      call<JournalImportSummary>(IPC.JOURNAL_IMPORT_INCREMENTAL, {}),
    importRun: (runId: string) =>
      call<boolean>(IPC.JOURNAL_IMPORT_RUN, { runId }),
    rebuildCache: () =>
      call<JournalImportSummary>(IPC.JOURNAL_REBUILD_CACHE, {}),
    listSources: () => call<JournalSource[]>(IPC.JOURNAL_LIST_SOURCES, {}),
    exportExisting: () => call<number>(IPC.JOURNAL_EXPORT_EXISTING, {}),
    cleanupOlderThan: (keepDays: number) =>
      call<JournalCleanupSummary>(IPC.JOURNAL_CLEANUP_OLDER_THAN, { keepDays }),
  },

  shell: {
    openExternal: (url: string) => call<void>(IPC.SHELL_OPEN_EXTERNAL, { url }),
    /** 在系统文件管理器（mac Finder / win Explorer）里高亮显示给定路径。 */
    showItemInFolder: (path: string) =>
      call<void>(IPC.SHELL_SHOW_ITEM_IN_FOLDER, { path }),
    /** 用系统默认行为打开路径（目录在文件管理器中打开，文件用关联程序打开）。 */
    openPath: (path: string) => call<void>(IPC.SHELL_OPEN_PATH, { path }),
    /** 写入系统剪贴板。使用 Electron 原生 clipboard，避免 renderer Clipboard API 权限漂移。 */
    writeClipboardText: (text: string) => clipboard.writeText(text),
    /**
     * 同步：把 DataTransfer.File 实例换成磁盘绝对路径。Electron 32+ 后只能通过
     * `webUtils.getPathForFile` 拿，`File.path` 已被废弃。renderer 拿到路径后
     * 通常会调 `vault.importFile` 复制进 vault。
     */
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
  },

  /** OS 平台标识，用于切换菜单文案（Finder / 资源管理器 / 文件管理器）。 */
  platform: process.platform as "darwin" | "win32" | "linux",

  app: {
    rendererReady: () => call<void>(IPC.APP_RENDERER_READY, {}),
  },

  updater: {
    getStatus: () => call<UpdaterStatus>(IPC.UPDATER_GET_STATUS, {}),
    checkForUpdates: () =>
      call<UpdaterStatus>(IPC.UPDATER_CHECK_FOR_UPDATES, {}),
    downloadUpdate: () => call<UpdaterStatus>(IPC.UPDATER_DOWNLOAD_UPDATE, {}),
    quitAndInstall: () => call<UpdaterStatus>(IPC.UPDATER_QUIT_AND_INSTALL, {}),
  },

  index: {
    listCandidates: (query: string, limit?: number) =>
      call<IndexCandidate[]>(IPC.INDEX_LIST_CANDIDATES, { query, limit }),
    getBacklinks: (target: string) =>
      call<IndexBacklinkEntry[]>(IPC.INDEX_GET_BACKLINKS, { target }),
    getEntry: (path: string) =>
      call<IndexEntrySummary | null>(IPC.INDEX_GET_ENTRY, { path }),
    /**
     * 订阅 main 进程 vault index 增量更新事件（v0.3 双链 M2）。无 payload，
     * renderer 收到后自行重查 candidates / backlinks。
     */
    onChanged: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(IPC_EVENTS.INDEX_CHANGED, handler);
      return () => {
        ipcRenderer.removeListener(IPC_EVENTS.INDEX_CHANGED, handler);
      };
    },
  },

  sqlIndex: {
    query: (filter: SqlIndexFilter) =>
      call<SqlIndexHit[]>(IPC.SQL_INDEX_QUERY, { filter }),
    facets: () => call<SqlIndexFacets>(IPC.SQL_INDEX_FACETS, {}),
    status: () => call<SqlIndexStatus>(IPC.SQL_INDEX_STATUS, {}),
    /**
     * 订阅 main 进程 SQL 索引状态变化（构建进度 / 就绪 / 增量更新）。无 payload，
     * renderer 收到后重查 status()/query()。
     */
    onChanged: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(IPC_EVENTS.SQL_INDEX_CHANGED, handler);
      return () => {
        ipcRenderer.removeListener(IPC_EVENTS.SQL_INDEX_CHANGED, handler);
      };
    },
  },

  export: {
    saveMarkdown: (
      suggestedName: string,
      content: string,
      opts: { title?: string } = {},
    ) =>
      call<{ canceled: boolean; path: string | null }>(
        IPC.EXPORT_SAVE_MARKDOWN,
        { suggestedName, content, title: opts.title },
      ),
  },

};

export type StelaBridge = typeof stela;

contextBridge.exposeInMainWorld("stela", stela);
