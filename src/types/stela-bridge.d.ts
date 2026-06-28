/**
 * Renderer 全局 window.stela 类型声明。
 *
 * 通过 preload 脚本注入；TypeScript 通过 declaration merging 把它接到 Window 上。
 *
 * 不直接 export 类型；如果业务代码需要类型，import 自 `@shared/types`。
 */

import type {
  AppSettings,
  BundledPluginInfo,
  ColumnDef,
  ConnectionEntry,
  ConnectionMap,
  ConnectorKindMeta,
  CredentialStorageStatus,
  FileNode,
  IndexBacklinkEntry,
  IndexCandidate,
  IndexEntrySummary,
  KnowledgeSearchHit,
  KnowledgeSearchMode,
  KnowledgeStatus,
  McpConfigSnippet,
  McpStatus,
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
} from "@shared/types";
import type { VaultExternalChangePayload } from "@shared/ipc-events";

interface StelaBridge {
  vault: {
    listDir: (path: string) => Promise<FileNode[]>;
    readFile: (path: string) => Promise<string>;
    /** 读任意二进制文件返回 base64；用于图片附件等。25MB 上限。 */
    readBinary: (path: string) => Promise<string>;
    writeFile: (path: string, contents: string) => Promise<void>;
    pathExists: (path: string) => Promise<boolean>;
    createDir: (vaultPath: string, path: string) => Promise<void>;
    createFile: (
      vaultPath: string,
      path: string,
      contents: string,
    ) => Promise<void>;
    renamePath: (vaultPath: string, from: string, to: string) => Promise<void>;
    deletePath: (vaultPath: string, path: string) => Promise<void>;
    importFile: (
      vaultPath: string,
      sourcePath: string,
      destDir: string,
    ) => Promise<string>;
    /**
     * 把剪贴板 / 拖拽里的二进制 blob 写到 note 同级的 `<note-stem>.assets/` 目录。
     * 返回 `{ absPath, relPath }`，其中 `relPath` 是相对 note 的 POSIX 路径。
     */
    saveAttachment: (
      vaultPath: string,
      notePath: string,
      fileName: string,
      base64: string,
    ) => Promise<{ absPath: string; relPath: string }>;
    storageDbSize: (vaultPath: string) => Promise<number>;
    /**
     * 切换 main 端「当前 vault」。会触发 shutdown 老 plugin → seed
     * `{vault}/.stela/`（仅首次）→ reload 新 plugin manifest。renderer
     * 切完应当 refetch settings/connections/plugins。
     */
    setCurrent: (vaultPath: string | null) => Promise<void>;
    getCurrent: () => Promise<string | null>;
    /** 订阅外部文件变更广播；返回 unsubscribe 函数（v0.2 #7） */
    onExternalChange: (
      callback: (payload: VaultExternalChangePayload) => void,
    ) => () => void;
  };
  dialog: {
    pickVault: () => Promise<string | null>;
    pickDirectory: (opts?: {
      title?: string;
      defaultPath?: string;
    }) => Promise<string | null>;
    pickFile: (opts?: {
      title?: string;
      defaultPath?: string;
      filters?: { name: string; extensions: string[] }[];
    }) => Promise<string | null>;
  };
  settings: {
    load: () => Promise<AppSettings>;
    patch: (patch: PartialAppSettings) => Promise<AppSettings>;
  };
  connections: {
    load: () => Promise<ConnectionMap>;
    upsert: (name: string, entry: ConnectionEntry) => Promise<ConnectionMap>;
    remove: (name: string) => Promise<ConnectionMap>;
  };
  userCache: {
    load: () => Promise<UserCache>;
    patch: (patch: PartialUserCache) => Promise<UserCache>;
  };
  storage: {
    open: (vaultPath: string) => Promise<void>;
    saveRun: (record: RunRecord) => Promise<void>;
    saveSchema: (runId: string, columns: ColumnDef[]) => Promise<void>;
    saveRows: (
      runId: string,
      rows: unknown[][],
      rowOffset?: number,
    ) => Promise<void>;
    queryPage: (
      runId: string,
      offset: number,
      limit: number,
    ) => Promise<RowsPage>;
    getSchema: (runId: string) => Promise<ColumnDef[]>;
    listRuns: () => Promise<RunRecord[]>;
    listRunsByBlockId: (
      blockId: string,
      options?: {
        limit?: number;
        offset?: number;
        status?: "ok" | "err" | "all";
      },
    ) => Promise<RunRecord[]>;
    cleanup: (keepDays: number) => Promise<number>;
  };
  connector: {
    listKinds: () => Promise<ConnectorKindMeta[]>;
    test: (kind: string, config: unknown) => Promise<TestResult>;
    execute: (
      kind: string,
      config: unknown,
      sql: string,
    ) => Promise<QueryResult>;
    listDatabases: (kind: string, config: unknown) => Promise<string[]>;
    listTables: (
      kind: string,
      config: unknown,
      db?: string | null,
    ) => Promise<string[]>;
    listPlugins: () => Promise<PluginInfo[]>;
    installPlugin: (input: PluginInstallInput) => Promise<PluginInfo>;
    uninstallPlugin: (kind: string) => Promise<void>;
    getPluginLogs: (kind: string) => Promise<string[]>;
    startPlugin: (kind: string) => Promise<PluginInfo>;
    stopPlugin: (kind: string) => Promise<PluginInfo>;
    restartPlugin: (kind: string) => Promise<PluginInfo>;
    installModulePlugin: (
      input: ModulePluginInstallInput,
    ) => Promise<PluginInfo>;
    listBundledPlugins: () => Promise<BundledPluginInfo[]>;
    installBundledPlugin: (id: string) => Promise<PluginInfo>;
  };
  search: {
    vault: (
      vaultPath: string,
      keyword: string,
      options?: SearchOptions,
    ) => Promise<SearchHit[]>;
    listFiles: (vaultPath: string, extensions: string[]) => Promise<string[]>;
  };
  privacy: {
    getStatus: () => Promise<CredentialStorageStatus>;
  };
  git: {
    isRepo: () => Promise<boolean>;
    initRepo: () => Promise<void>;
    cloneRepo: (remoteUrl: string, localPath: string) => Promise<string>;
    vaultStatus: () => Promise<GitVaultStatus>;
    commit: (message: string) => Promise<string>;
    push: () => Promise<GitPushResult>;
    pull: () => Promise<GitPullResult>;
    remoteStatus: () => Promise<GitRemoteStatus>;
    addRemote: (remoteUrl: string) => Promise<GitAddRemoteResult>;
    modifiedFiles: (includeStats?: boolean) => Promise<GitModifiedFile[]>;
    fileDiff: (relPath: string) => Promise<string>;
    fileDiffAtCommit: (relPath: string, commitHash: string) => Promise<string>;
    fileHistory: (relPath: string, limit?: number) => Promise<GitCommit[]>;
    vaultPulse: (limit?: number, skip?: number) => Promise<GitPulseCommit[]>;
    lastCommit: () => Promise<GitPulseCommit | null>;
    conflictFiles: () => Promise<string[]>;
    conflictMode: () => Promise<GitConflictMode>;
    resolveConflict: (
      file: string,
      strategy: GitConflictStrategy,
    ) => Promise<void>;
    commitConflictResolution: () => Promise<string>;
    discardFile: (relPath: string) => Promise<void>;
    authorIdentity: () => Promise<GitAuthorIdentity>;
    setAuthorIdentity: (name: string, email: string) => Promise<void>;
    syncPush: (message?: string) => Promise<GitSyncPushResult>;
    syncPull: () => Promise<GitSyncPullResult>;
  };
  journal: {
    getDeviceProfile: () => Promise<DeviceProfile>;
    setDeviceSlug: (slug: string) => Promise<DeviceProfile>;
    appendRun: (runId: string) => Promise<void>;
    importIncremental: () => Promise<JournalImportSummary>;
    importRun: (runId: string) => Promise<boolean>;
    rebuildCache: () => Promise<JournalImportSummary>;
    listSources: () => Promise<JournalSource[]>;
    exportExisting: () => Promise<number>;
    cleanupOlderThan: (keepDays: number) => Promise<JournalCleanupSummary>;
  };
  shell: {
    openExternal: (url: string) => Promise<void>;
    showItemInFolder: (path: string) => Promise<void>;
    openPath: (path: string) => Promise<void>;
    writeClipboardText: (text: string) => void;
    getPathForFile: (file: File) => string;
  };
  export: {
    /**
     * 弹出原生 Save 对话框，让用户选择保存路径，然后原子性写入 `content`。
     * 返回 `{ canceled: true, path: null }` 表示用户取消；否则返回实际写入路径。
     */
    saveMarkdown: (
      suggestedName: string,
      content: string,
      opts?: { title?: string },
    ) => Promise<{ canceled: boolean; path: string | null }>;
  };
  /** OS 平台标识，渲染器据此切换菜单文案 / 快捷键提示。 */
  platform: "darwin" | "win32" | "linux";
  app: {
    rendererReady: () => Promise<void>;
  };
  updater: {
    getStatus: () => Promise<UpdaterStatus>;
    checkForUpdates: () => Promise<UpdaterStatus>;
    downloadUpdate: () => Promise<UpdaterStatus>;
    quitAndInstall: () => Promise<UpdaterStatus>;
  };
  index: {
    listCandidates: (
      query: string,
      limit?: number,
    ) => Promise<IndexCandidate[]>;
    getBacklinks: (target: string) => Promise<IndexBacklinkEntry[]>;
    getEntry: (path: string) => Promise<IndexEntrySummary | null>;
    /** 订阅 main 推送的 INDEX_CHANGED；返回 unsubscribe（v0.3 双链 M2） */
    onChanged: (callback: () => void) => () => void;
  };
  knowledge: {
    /**
     * 语义检索。`opts.mode` 缺省 `hybrid`；embedder 不可用时自动降级 `keyword`。
     */
    search: (
      query: string,
      opts?: { topK?: number; mode?: KnowledgeSearchMode },
    ) => Promise<KnowledgeSearchHit[]>;
    getStatus: () => Promise<KnowledgeStatus>;
    rebuild: () => Promise<void>;
    purge: () => Promise<void>;
  };
  mcp: {
    getStatus: () => Promise<McpStatus>;
    start: () => Promise<void>;
    stop: () => Promise<void>;
    getLogs: (limit?: number) => Promise<string[]>;
    clearLogs: () => Promise<void>;
    getConfigSnippet: () => Promise<McpConfigSnippet>;
  };
}

declare global {
  interface Window {
    stela: StelaBridge;
  }
}

export {};
