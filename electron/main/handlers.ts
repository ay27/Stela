/**
 * IPC handler 注册：把 Phase 3-6 的 service 接到 channel。
 *
 * 每个 handler：
 *   - 输入由 ipc-router 提前 zod 校验过
 *   - 异常由 ipc-router 统一 toIpcError → 抛出
 *
 * 部分 channel 需要拿 BrowserWindow 来弹 dialog；通过 `getMainWindow` getter 注入。
 */

import fs from "node:fs/promises";
import path from "node:path";

import { BrowserWindow, app, dialog } from "electron";

import { IPC } from "@shared/ipc-channels";
import type {
  AppSettings,
  ColumnDef,
  ConnectionEntry,
  ConnectionMap,
  ConnectorKindMeta,
  CredentialStorageStatus,
  FileNode,
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
  GitModifiedFile,
  GitPulseCommit,
  GitRemoteStatus,
  GitSyncPullResult,
  GitSyncPushResult,
  GitVaultStatus,
  JournalCleanupSummary,
  JournalImportSummary,
  JournalSource,
} from "@shared/types";

import { AppError } from "@shared/errors";

import { registerHandler } from "./ipc-router";
import { openExternalIfAllowed } from "./security";
import { getCurrentVault, setCurrentVault } from "./vault-context";
import { getLogger } from "../services/logger";

import * as vaultFs from "../services/vault-fs";
import * as settingsStore from "../services/settings-store";
import * as connectionsStore from "../services/connections-store";
import * as userCacheStore from "../services/user-cache-store";
import * as resultStore from "../services/result-store";
import * as connectorRegistry from "../services/connectors/registry";
import * as search from "../services/search";
import * as secrets from "../services/secrets";
import * as git from "../services/git";
import * as journal from "../services/history-journal";
import * as deviceProfile from "../services/device-profile";
import * as syncOrchestrator from "../services/sync-orchestrator";
import * as vaultIndex from "../services/vault-index";
import * as autoUpdate from "../services/auto-updater";

/** 共用：所有 vault-级 handler 的入口拿当前 vault；没有时按 IPC 错误返回。 */
function requireVault(): string {
  const v = getCurrentVault();
  if (!v) {
    throw new AppError(
      "no_vault",
      "no vault is currently open; call vault.setCurrent first",
    );
  }
  return v;
}

const STARTUP_UPDATE_CHECK_DELAY_MS = 10_000;
const UPDATE_CHECK_THROTTLE_MS = 24 * 60 * 60 * 1000;
let startupUpdateCheckScheduled = false;

function scheduleStartupUpdateCheck(): void {
  if (startupUpdateCheckScheduled) return;
  startupUpdateCheckScheduled = true;
  setTimeout(() => {
    void (async () => {
      const cache = await userCacheStore.loadUserCache();
      const now = Date.now();
      if (
        cache.updateLastCheckedAt !== null &&
        now - cache.updateLastCheckedAt < UPDATE_CHECK_THROTTLE_MS
      ) {
        return;
      }
      await userCacheStore.patchUserCache({ updateLastCheckedAt: now });
      await autoUpdate.checkForUpdates();
    })().catch((err) => {
      getLogger("auto-updater").warn("startup update check skipped", {
        err: (err as Error).message,
      });
    });
  }, STARTUP_UPDATE_CHECK_DELAY_MS);
}

export interface HandlerCtx {
  getMainWindow: () => BrowserWindow | null;
}

export function registerAllHandlers(ctx: HandlerCtx): void {
  // ---------- Vault FS ----------
  registerHandler<{ path: string }, FileNode[]>(
    IPC.VAULT_LIST_DIR,
    ({ path }) => vaultFs.listDir(path),
  );
  registerHandler<{ path: string }, string>(IPC.VAULT_READ_FILE, ({ path }) =>
    vaultFs.readFile(path),
  );
  registerHandler<{ path: string }, string>(IPC.VAULT_READ_BINARY, ({ path }) =>
    vaultFs.readBinary(path),
  );
  registerHandler<{ path: string; contents: string }, void>(
    IPC.VAULT_WRITE_FILE,
    ({ path, contents }) => vaultFs.writeFile(path, contents),
  );
  registerHandler<{ path: string }, boolean>(
    IPC.VAULT_PATH_EXISTS,
    ({ path }) => vaultFs.pathExists(path),
  );
  registerHandler<{ vaultPath: string; path: string }, void>(
    IPC.VAULT_CREATE_DIR,
    ({ vaultPath, path }) => vaultFs.createDir(vaultPath, path),
  );
  registerHandler<{ vaultPath: string; path: string; contents: string }, void>(
    IPC.VAULT_CREATE_FILE,
    ({ vaultPath, path, contents }) =>
      vaultFs.createFile(vaultPath, path, contents),
  );
  registerHandler<{ vaultPath: string; from: string; to: string }, void>(
    IPC.VAULT_RENAME_PATH,
    ({ vaultPath, from, to }) => vaultFs.renamePath(vaultPath, from, to),
  );
  registerHandler<{ vaultPath: string; path: string }, void>(
    IPC.VAULT_DELETE_PATH,
    ({ vaultPath, path }) => vaultFs.deletePath(vaultPath, path),
  );
  registerHandler<{ vaultPath: string }, number>(
    IPC.VAULT_DB_SIZE,
    ({ vaultPath }) => vaultFs.storageDbSize(vaultPath),
  );

  // ---------- Dialog ----------
  const pickDir = async (
    title: string,
    defaultPath?: string,
  ): Promise<string | null> => {
    const win = ctx.getMainWindow();
    const opts: Electron.OpenDialogOptions = {
      properties: ["openDirectory", "createDirectory"],
      title,
    };
    if (defaultPath) opts.defaultPath = defaultPath;
    const r = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    if (r.canceled || r.filePaths.length === 0) return null;
    return r.filePaths[0]!;
  };
  registerHandler<Record<string, never>, string | null>(
    IPC.DIALOG_PICK_VAULT,
    () => pickDir("Choose Stela vault"),
  );
  registerHandler<{ title?: string; defaultPath?: string }, string | null>(
    IPC.DIALOG_PICK_DIRECTORY,
    ({ title, defaultPath }) =>
      pickDir(title ?? "Choose directory", defaultPath),
  );
  registerHandler<
    {
      title?: string;
      defaultPath?: string;
      filters?: { name: string; extensions: string[] }[];
    },
    string | null
  >(IPC.DIALOG_PICK_FILE, async ({ title, defaultPath, filters }) => {
    const win = ctx.getMainWindow();
    const opts: Electron.OpenDialogOptions = {
      properties: ["openFile"],
      title: title ?? "Choose file",
    };
    if (defaultPath) opts.defaultPath = defaultPath;
    if (filters && filters.length > 0) opts.filters = filters;
    const r = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    if (r.canceled || r.filePaths.length === 0) return null;
    return r.filePaths[0]!;
  });

  // ---------- Settings (vault-scoped) ----------
  registerHandler<Record<string, never>, AppSettings>(IPC.SETTINGS_LOAD, () =>
    settingsStore.loadAppSettings(requireVault()),
  );
  registerHandler<{ patch: PartialAppSettings }, AppSettings>(
    IPC.SETTINGS_PATCH,
    async ({ patch }) => {
      const vaultPath = requireVault();
      return settingsStore.patchAppSettings(vaultPath, patch);
    },
  );

  // ---------- Connections (vault-scoped) ----------
  registerHandler<Record<string, never>, ConnectionMap>(
    IPC.CONNECTIONS_LOAD,
    async () =>
      connectionsStore.loadConnections(
        requireVault(),
        (await deviceProfile.loadDeviceProfile()).slug,
      ),
  );
  registerHandler<{ name: string; entry: ConnectionEntry }, ConnectionMap>(
    IPC.CONNECTIONS_UPSERT,
    async ({ name, entry }) =>
      connectionsStore.upsertConnection(
        requireVault(),
        (await deviceProfile.loadDeviceProfile()).slug,
        name,
        entry,
      ),
  );
  registerHandler<{ name: string }, ConnectionMap>(
    IPC.CONNECTIONS_REMOVE,
    async ({ name }) =>
      connectionsStore.removeConnection(
        requireVault(),
        (await deviceProfile.loadDeviceProfile()).slug,
        name,
      ),
  );

  // ---------- User cache (cross-vault) ----------
  registerHandler<Record<string, never>, UserCache>(IPC.USER_CACHE_LOAD, () =>
    userCacheStore.loadUserCache(),
  );
  registerHandler<{ patch: PartialUserCache }, UserCache>(
    IPC.USER_CACHE_PATCH,
    ({ patch }) => userCacheStore.patchUserCache(patch),
  );

  // ---------- Vault context ----------
  registerHandler<{ vaultPath: string | null }, void>(
    IPC.VAULT_SET_CURRENT,
    ({ vaultPath }) => setCurrentVault(vaultPath),
  );
  registerHandler<Record<string, never>, string | null>(
    IPC.VAULT_GET_CURRENT,
    () => getCurrentVault(),
  );

  // ---------- Storage ----------
  registerHandler<{ vaultPath: string }, void>(
    IPC.STORAGE_OPEN,
    ({ vaultPath }) => resultStore.open(vaultPath),
  );
  registerHandler<{ record: RunRecord }, void>(
    IPC.STORAGE_SAVE_RUN,
    ({ record }) => {
      resultStore.saveRun(record);
    },
  );
  registerHandler<{ runId: string; columns: ColumnDef[] }, void>(
    IPC.STORAGE_SAVE_SCHEMA,
    ({ runId, columns }) => {
      resultStore.saveSchema(runId, columns);
    },
  );
  registerHandler<
    { runId: string; rows: unknown[][]; rowOffset?: number },
    void
  >(IPC.STORAGE_SAVE_ROWS, ({ runId, rows, rowOffset }) => {
    resultStore.saveRows(runId, rows, rowOffset ?? 0);
  });
  registerHandler<{ runId: string; offset: number; limit: number }, RowsPage>(
    IPC.STORAGE_QUERY_PAGE,
    ({ runId, offset, limit }) => resultStore.queryPage(runId, offset, limit),
  );
  registerHandler<{ runId: string }, ColumnDef[]>(
    IPC.STORAGE_GET_SCHEMA,
    ({ runId }) => resultStore.getSchema(runId),
  );
  registerHandler<Record<string, never>, RunRecord[]>(
    IPC.STORAGE_LIST_RUNS,
    () => resultStore.listRuns(),
  );
  registerHandler<
    {
      blockId: string;
      limit?: number;
      offset?: number;
      status?: "ok" | "err" | "all";
    },
    RunRecord[]
  >(IPC.STORAGE_LIST_RUNS_BY_BLOCK, ({ blockId, limit, offset, status }) =>
    resultStore.listRunsByBlockId(blockId, { limit, offset, status }),
  );
  registerHandler<{ keepDays: number }, number>(
    IPC.STORAGE_CLEANUP,
    ({ keepDays }) => resultStore.cleanup(keepDays),
  );

  // ---------- Connectors ----------
  registerHandler<Record<string, never>, ConnectorKindMeta[]>(
    IPC.CONNECTOR_LIST_KINDS,
    () => connectorRegistry.listKinds(),
  );
  registerHandler<{ kind: string; config: unknown }, TestResult>(
    IPC.CONNECTOR_TEST,
    ({ kind, config }) => connectorRegistry.test(kind, config),
  );
  registerHandler<{ kind: string; config: unknown; sql: string }, QueryResult>(
    IPC.CONNECTOR_EXECUTE,
    ({ kind, config, sql }) => connectorRegistry.execute(kind, config, sql),
  );
  registerHandler<{ kind: string; config: unknown }, string[]>(
    IPC.CONNECTOR_LIST_DATABASES,
    ({ kind, config }) => connectorRegistry.listDatabases(kind, config),
  );
  registerHandler<
    { kind: string; config: unknown; db?: string | null },
    string[]
  >(IPC.CONNECTOR_LIST_TABLES, ({ kind, config, db }) =>
    connectorRegistry.listTables(kind, config, db ?? null),
  );

  // ---------- Connector plugin management ----------
  registerHandler<Record<string, never>, PluginInfo[]>(
    IPC.CONNECTOR_LIST_PLUGINS,
    () => connectorRegistry.listPlugins(),
  );
  registerHandler<{ input: PluginInstallInput }, PluginInfo>(
    IPC.CONNECTOR_INSTALL_PLUGIN,
    ({ input }) => connectorRegistry.installPlugin(input),
  );
  registerHandler<{ kind: string }, void>(
    IPC.CONNECTOR_UNINSTALL_PLUGIN,
    ({ kind }) => connectorRegistry.uninstallPlugin(kind),
  );
  registerHandler<{ kind: string }, string[]>(
    IPC.CONNECTOR_GET_PLUGIN_LOGS,
    ({ kind }) => connectorRegistry.getPluginLogs(kind),
  );
  registerHandler<{ kind: string }, PluginInfo>(
    IPC.CONNECTOR_START_PLUGIN,
    ({ kind }) => connectorRegistry.startPlugin(kind),
  );
  registerHandler<{ kind: string }, PluginInfo>(
    IPC.CONNECTOR_STOP_PLUGIN,
    ({ kind }) => connectorRegistry.stopPlugin(kind),
  );
  registerHandler<{ kind: string }, PluginInfo>(
    IPC.CONNECTOR_RESTART_PLUGIN,
    ({ kind }) => connectorRegistry.restartPlugin(kind),
  );
  registerHandler<{ input: ModulePluginInstallInput }, PluginInfo>(
    IPC.CONNECTOR_INSTALL_MODULE_PLUGIN,
    ({ input }) => connectorRegistry.installModulePlugin(input),
  );
  registerHandler<Record<string, never>, BundledPluginInfo[]>(
    IPC.CONNECTOR_LIST_BUNDLED_PLUGINS,
    () => connectorRegistry.listBundledPlugins(),
  );
  registerHandler<{ id: string }, PluginInfo>(
    IPC.CONNECTOR_INSTALL_BUNDLED_PLUGIN,
    ({ id }) => connectorRegistry.installBundledPlugin(id),
  );

  // ---------- Search ----------
  registerHandler<
    {
      vaultPath: string;
      keyword: string;
      caseSensitive?: boolean;
      maxHits?: number | null;
    },
    SearchHit[]
  >(IPC.SEARCH_VAULT, ({ vaultPath, keyword, caseSensitive, maxHits }) => {
    const opts: SearchOptions = {};
    if (caseSensitive !== undefined) opts.caseSensitive = caseSensitive;
    if (maxHits !== undefined && maxHits !== null) opts.maxHits = maxHits;
    return search.searchVault(vaultPath, keyword, opts);
  });
  registerHandler<{ vaultPath: string; extensions: string[] }, string[]>(
    IPC.SEARCH_LIST_FILES,
    ({ vaultPath, extensions }) => search.listVaultFiles(vaultPath, extensions),
  );

  // ---------- Privacy ----------
  registerHandler<Record<string, never>, CredentialStorageStatus>(
    IPC.PRIVACY_GET_STATUS,
    () => secrets.getStatus(),
  );

  // ---------- Git 版本控制 ----------
  registerHandler<Record<string, never>, boolean>(IPC.GIT_IS_REPO, () =>
    git.isRepo(requireVault()),
  );
  registerHandler<Record<string, never>, void>(IPC.GIT_INIT_REPO, () =>
    git.initRepo(requireVault()),
  );
  registerHandler<{ remoteUrl: string; localPath: string }, string>(
    IPC.GIT_CLONE_REPO,
    ({ remoteUrl, localPath }) => git.clone(remoteUrl, localPath),
  );
  registerHandler<Record<string, never>, GitVaultStatus>(
    IPC.GIT_VAULT_STATUS,
    () => git.vaultStatus(requireVault()),
  );
  registerHandler<{ message: string }, string>(IPC.GIT_COMMIT, ({ message }) =>
    git.commit(requireVault(), message),
  );
  registerHandler<Record<string, never>, Awaited<ReturnType<typeof git.push>>>(
    IPC.GIT_PUSH,
    () => git.push(requireVault()),
  );
  registerHandler<Record<string, never>, Awaited<ReturnType<typeof git.pull>>>(
    IPC.GIT_PULL,
    () => git.pull(requireVault()),
  );
  registerHandler<Record<string, never>, GitRemoteStatus>(
    IPC.GIT_REMOTE_STATUS,
    () => git.remoteStatus(requireVault()),
  );
  registerHandler<{ remoteUrl: string }, GitAddRemoteResult>(
    IPC.GIT_ADD_REMOTE,
    ({ remoteUrl }) => git.addRemote(requireVault(), remoteUrl),
  );
  registerHandler<{ includeStats?: boolean }, GitModifiedFile[]>(
    IPC.GIT_MODIFIED_FILES,
    ({ includeStats }) =>
      git.getModifiedFiles(requireVault(), includeStats ?? false),
  );
  registerHandler<{ relPath: string }, string>(
    IPC.GIT_FILE_DIFF,
    ({ relPath }) => git.fileDiff(requireVault(), relPath),
  );
  registerHandler<{ relPath: string; commitHash: string }, string>(
    IPC.GIT_FILE_DIFF_AT_COMMIT,
    ({ relPath, commitHash }) =>
      git.fileDiffAtCommit(requireVault(), relPath, commitHash),
  );
  registerHandler<{ relPath: string; limit?: number }, GitCommit[]>(
    IPC.GIT_FILE_HISTORY,
    ({ relPath, limit }) => git.fileHistory(requireVault(), relPath, limit),
  );
  registerHandler<{ limit?: number; skip?: number }, GitPulseCommit[]>(
    IPC.GIT_VAULT_PULSE,
    ({ limit, skip }) => git.vaultPulse(requireVault(), limit, skip),
  );
  registerHandler<Record<string, never>, GitPulseCommit | null>(
    IPC.GIT_LAST_COMMIT,
    () => git.lastCommit(requireVault()),
  );
  registerHandler<Record<string, never>, string[]>(IPC.GIT_CONFLICT_FILES, () =>
    git.conflictFiles(requireVault()),
  );
  registerHandler<Record<string, never>, GitConflictMode>(
    IPC.GIT_CONFLICT_MODE,
    () => git.conflictMode(requireVault()),
  );
  registerHandler<{ file: string; strategy: "ours" | "theirs" }, void>(
    IPC.GIT_RESOLVE_CONFLICT,
    ({ file, strategy }) => git.resolveConflict(requireVault(), file, strategy),
  );
  registerHandler<Record<string, never>, string>(
    IPC.GIT_COMMIT_CONFLICT_RESOLUTION,
    () => git.commitConflictResolution(requireVault()),
  );
  registerHandler<{ relPath: string }, void>(
    IPC.GIT_DISCARD_FILE,
    ({ relPath }) => git.discardFile(requireVault(), relPath),
  );
  registerHandler<Record<string, never>, GitAuthorIdentity>(
    IPC.GIT_AUTHOR_IDENTITY,
    () => git.authorIdentity(requireVault()),
  );
  registerHandler<{ name: string; email: string }, void>(
    IPC.GIT_SET_AUTHOR_IDENTITY,
    ({ name, email }) => git.setAuthorIdentity(requireVault(), { name, email }),
  );
  registerHandler<{ message?: string }, GitSyncPushResult>(
    IPC.GIT_SYNC_PUSH,
    ({ message }) => syncOrchestrator.syncPush(requireVault(), message),
  );
  registerHandler<Record<string, never>, GitSyncPullResult>(
    IPC.GIT_SYNC_PULL,
    () => syncOrchestrator.syncPull(requireVault()),
  );

  // ---------- 执行历史 Journal ----------
  registerHandler<Record<string, never>, DeviceProfile>(
    IPC.JOURNAL_GET_DEVICE_PROFILE,
    () => deviceProfile.loadDeviceProfile(),
  );
  registerHandler<{ slug: string }, DeviceProfile>(
    IPC.JOURNAL_SET_DEVICE_SLUG,
    ({ slug }) => deviceProfile.setDeviceSlug(slug),
  );
  registerHandler<{ runId: string }, void>(
    IPC.JOURNAL_APPEND_RUN,
    async ({ runId }) =>
      journal.appendRunById(
        requireVault(),
        runId,
        await deviceProfile.loadDeviceProfile(),
      ),
  );
  registerHandler<Record<string, never>, JournalImportSummary>(
    IPC.JOURNAL_IMPORT_INCREMENTAL,
    () => journal.importIncremental(requireVault()),
  );
  registerHandler<{ runId: string }, boolean>(
    IPC.JOURNAL_IMPORT_RUN,
    ({ runId }) => journal.importRun(requireVault(), runId),
  );
  registerHandler<Record<string, never>, JournalImportSummary>(
    IPC.JOURNAL_REBUILD_CACHE,
    () => journal.rebuildCache(requireVault()),
  );
  registerHandler<Record<string, never>, JournalSource[]>(
    IPC.JOURNAL_LIST_SOURCES,
    async () =>
      journal.listSources(
        requireVault(),
        await deviceProfile.loadDeviceProfile(),
      ),
  );
  registerHandler<Record<string, never>, number>(
    IPC.JOURNAL_EXPORT_EXISTING,
    async () =>
      journal.exportExistingRunsToJournal(
        requireVault(),
        await deviceProfile.loadDeviceProfile(),
      ),
  );
  registerHandler<{ keepDays: number }, JournalCleanupSummary>(
    IPC.JOURNAL_CLEANUP_OLDER_THAN,
    ({ keepDays }) => journal.cleanupByKeepDays(requireVault(), keepDays),
  );

  // ---------- Shell ----------
  registerHandler<{ url: string }, void>(IPC.SHELL_OPEN_EXTERNAL, ({ url }) =>
    openExternalIfAllowed(url),
  );
  registerHandler<{ path: string }, void>(
    IPC.SHELL_SHOW_ITEM_IN_FOLDER,
    ({ path }) => vaultFs.showItemInFolder(requireVault(), path),
  );
  registerHandler<{ path: string }, void>(IPC.SHELL_OPEN_PATH, ({ path }) =>
    vaultFs.openPath(requireVault(), path),
  );

  // ---------- Vault import ----------
  registerHandler<
    { vaultPath: string; sourcePath: string; destDir: string },
    string
  >(IPC.VAULT_IMPORT_FILE, ({ vaultPath, sourcePath, destDir }) =>
    vaultFs.importFile(vaultPath, sourcePath, destDir),
  );

  registerHandler<
    {
      vaultPath: string;
      notePath: string;
      fileName: string;
      base64: string;
    },
    { absPath: string; relPath: string }
  >(IPC.VAULT_SAVE_ATTACHMENT, ({ vaultPath, notePath, fileName, base64 }) =>
    vaultFs.saveAttachment(vaultPath, notePath, fileName, base64),
  );

  // ---------- App lifecycle ----------
  const lifecycleLog = getLogger("lifecycle");
  registerHandler<Record<string, never>, void>(IPC.APP_RENDERER_READY, () => {
    lifecycleLog.info("renderer ready");
    scheduleStartupUpdateCheck();
  });

  // ---------- Auto update ----------
  registerHandler<Record<string, never>, UpdaterStatus>(
    IPC.UPDATER_GET_STATUS,
    () => autoUpdate.getStatus(),
  );
  registerHandler<Record<string, never>, UpdaterStatus>(
    IPC.UPDATER_CHECK_FOR_UPDATES,
    () => autoUpdate.checkForUpdates(),
  );
  registerHandler<Record<string, never>, UpdaterStatus>(
    IPC.UPDATER_DOWNLOAD_UPDATE,
    () => autoUpdate.downloadUpdate(),
  );
  registerHandler<Record<string, never>, UpdaterStatus>(
    IPC.UPDATER_QUIT_AND_INSTALL,
    () => autoUpdate.quitAndInstall(),
  );

  // ---------- Vault index (v0.3 双链 M2/M3) ----------
  registerHandler<{ query: string; limit?: number }, IndexCandidate[]>(
    IPC.INDEX_LIST_CANDIDATES,
    ({ query, limit }) => vaultIndex.listCandidates({ query, limit }),
  );
  registerHandler<{ target: string }, IndexBacklinkEntry[]>(
    IPC.INDEX_GET_BACKLINKS,
    ({ target }) => vaultIndex.getBacklinks({ target }),
  );
  registerHandler<{ path: string }, IndexEntrySummary | null>(
    IPC.INDEX_GET_ENTRY,
    ({ path: p }) => vaultIndex.getEntry({ path: p }),
  );

  // ---------- Export ----------
  registerHandler<
    { suggestedName: string; content: string; title?: string },
    { canceled: boolean; path: string | null }
  >(IPC.EXPORT_SAVE_MARKDOWN, async ({ suggestedName, content, title }) => {
    const win = ctx.getMainWindow();
    const defaultPath = path.join(app.getPath("documents"), suggestedName);
    const opts: Electron.SaveDialogOptions = {
      title: title ?? "Export Markdown",
      defaultPath,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    };
    const r = win
      ? await dialog.showSaveDialog(win, opts)
      : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return { canceled: true, path: null };
    await fs.writeFile(r.filePath, content, "utf-8");
    return { canceled: false, path: r.filePath };
  });
}
