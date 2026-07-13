/**
 * Connector 注册表（main 进程级单例）。
 *
 * v0.5 起核心**不再编译进任何内置 connector**（http / mysql 已剥离为插件）。
 * 现在 registry 里的每个 connector 都来自插件，两种承载形态并存：
 *   - **subprocess**：stdio JSON-RPC 子进程插件，manifest 在
 *     `{vault}/.stela/connector_plugins.json`
 *   - **module**：进程内 JS 模块插件，安装在 `{vault}/.stela/plugins/<id>/`，
 *     由 module-loader 用 createRequire 动态加载（完整权限运行）
 *
 * 切 vault：先 shutdown/dispose 旧 vault 的所有插件并摘除，再加载新 vault 的
 * subprocess manifest + module 插件目录。没有当前 vault 时 registry 为空。
 *
 * Renderer 通过 IPC 调用统一查询方法（list-kinds / test / execute / list-*）与
 * 插件管理方法（list / install / install-module / install-bundled / uninstall / ...）。
 */

import { promises as fs } from "node:fs";

import { AppError } from "@shared/errors";
import type {
  BundledPluginInfo,
  ConnectorKindMeta,
  ModulePluginInstallInput,
  PluginInfo,
  PluginInstallInput,
  QueryResult,
  TestResult,
} from "@shared/types";

import { atomicWriteFile } from "../atomic-write";
import { getLogger } from "../logger";
import * as settingsStore from "../settings-store";
import { vaultConfigDir, vaultFilePath } from "../vault-paths";
import {
  bundledPluginDir,
  listBundledManifests,
} from "./bundled-plugins";
import {
  ModulePluginConnector,
  copyPluginPackage,
  loadAllModulePlugins,
  loadModulePlugin,
  pluginsRoot,
  readManifest,
  type ModulePluginLoadError,
} from "./module-loader";
import { SubprocessConnector, type PluginEntry } from "./subprocess";
import type { Connector } from "./types";

const MANIFEST_FILE = "connector_plugins.json";
const log = getLogger("connector:registry");

const registry = new Map<string, Connector>();
let initialized = false;
let currentVaultPath: string | null = null;
/** 最近一次 vault module 插件加载的失败记录，供 listPlugins 展示。 */
let moduleErrors: ModulePluginLoadError[] = [];

/**
 * 主进程启动时调用一次。v0.5 起核心无内置 connector，这里只置位 initialized；
 * 所有 connector 都在 `setVault(path)` 时从插件加载。保留函数名以兼容 index.ts。
 */
export function initBuiltinRegistry(): void {
  if (initialized) return;
  initialized = true;
}

// ---------- subprocess manifest IO ----------

function manifestPath(vaultPath: string): string {
  return vaultFilePath(vaultPath, MANIFEST_FILE);
}

async function readManifestFile(vaultPath: string): Promise<PluginEntry[]> {
  let buf: string;
  try {
    buf = await fs.readFile(manifestPath(vaultPath), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    log.error("read manifest error", { err: (err as Error).message });
    return [];
  }
  try {
    const parsed = JSON.parse(buf) as PluginEntry[];
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch (err) {
    log.error("parse manifest error", { err: (err as Error).message });
    return [];
  }
}

async function writeManifestFile(
  vaultPath: string,
  entries: PluginEntry[],
): Promise<void> {
  await atomicWriteFile(manifestPath(vaultPath), JSON.stringify(entries, null, 2));
}

// ---------- lifecycle ----------

/** shutdown subprocess（kill）+ dispose module（关池），并从 registry 摘除。 */
async function disposeAllDynamic(): Promise<void> {
  for (const [kind, c] of [...registry.entries()]) {
    try {
      if (c instanceof SubprocessConnector) {
        c.shutdown();
      } else if (c instanceof ModulePluginConnector) {
        await c.dispose();
      }
    } catch (err) {
      log.error("dispose connector failed", {
        kind,
        err: (err as Error).message,
      });
    }
    registry.delete(kind);
  }
}

async function loadSubprocessManifest(vaultPath: string): Promise<void> {
  const entries = await readManifestFile(vaultPath);
  for (const entry of entries) {
    if (registry.has(entry.kind)) {
      log.warn("subprocess plugin kind already registered, skipped", {
        kind: entry.kind,
      });
      continue;
    }
    try {
      const conn = await SubprocessConnector.spawnFromEntry(entry);
      registry.set(conn.meta().kind, conn);
      log.info("subprocess connector registered", {
        kind: conn.meta().kind,
        exePath: entry.exePath,
      });
    } catch (err) {
      log.error("subprocess connector failed", {
        kind: entry.kind,
        exePath: entry.exePath,
        err: (err as Error).message,
      });
    }
  }
}

async function loadModulePluginsForVault(vaultPath: string): Promise<void> {
  const root = pluginsRoot(vaultConfigDir(vaultPath));
  const { connectors, errors } = await loadAllModulePlugins(root);
  moduleErrors = errors;
  for (const c of connectors) {
    const kind = c.meta().kind;
    if (registry.has(kind)) {
      log.warn("module plugin kind conflicts, skipped", {
        kind,
        dir: c.dir,
      });
      await c.dispose();
      continue;
    }
    registry.set(kind, c);
  }
}

/**
 * 切换当前 vault 上下文：dispose 旧插件 → 加载新 vault 的 subprocess + module 插件。
 * vaultPath=null 表示无打开的 vault（启动 / closeVault），此时 registry 清空。
 */
export async function setVault(vaultPath: string | null): Promise<void> {
  initBuiltinRegistry();
  await disposeAllDynamic();
  moduleErrors = [];
  currentVaultPath = vaultPath;
  if (vaultPath) {
    await loadSubprocessManifest(vaultPath);
    await loadModulePluginsForVault(vaultPath);
  }
}

function requireVault(): string {
  if (!currentVaultPath) {
    throw new AppError("no_vault", "no vault is currently open");
  }
  return currentVaultPath;
}

function getOrThrow(kind: string): Connector {
  const c = registry.get(kind);
  if (!c) {
    throw new AppError("unknown_kind", `connector kind '${kind}' not registered`);
  }
  return c;
}

function capQueryRows(result: QueryResult, maxRows: number | null): QueryResult {
  if (
    result.kind !== "query" ||
    maxRows === null ||
    maxRows <= 0 ||
    result.rows.length <= maxRows
  ) {
    return result;
  }
  return { ...result, rows: result.rows.slice(0, maxRows) };
}

// ---------- unified query API ----------

export function listKinds(): ConnectorKindMeta[] {
  return [...registry.values()].map((c) => c.meta());
}

export async function test(kind: string, config: unknown): Promise<TestResult> {
  return getOrThrow(kind).test(config);
}

/**
 * ponytail: 每次 execute 都读一次 settings.json 拿 maxRows；上限是高频执行时
 * 多一次磁盘 IO，升级路径是在 setVault/patch 时把 maxRows 缓存到模块变量。
 * 当前 SQL 执行本身的网络往返远大于这次本地文件读取，先不做。
 * maxRows 只截断 Stela 保存/展示的结果行，不改写用户 SQL。
 */
export async function execute(
  kind: string,
  config: unknown,
  sql: string,
): Promise<QueryResult> {
  const connector = getOrThrow(kind);
  let maxRows: number | null = null;
  if (currentVaultPath) {
    try {
      const settings = await settingsStore.loadAppSettings(currentVaultPath);
      maxRows = settings.execution.maxRows;
    } catch (err) {
      log.warn("failed to load execution.maxRows, returning unbounded rows", {
        err: (err as Error).message,
      });
    }
  }
  return capQueryRows(await connector.execute(config, sql), maxRows);
}

export async function listDatabases(
  kind: string,
  config: unknown,
): Promise<string[]> {
  return getOrThrow(kind).listDatabases(config);
}

export async function listTables(
  kind: string,
  config: unknown,
  db?: string | null,
): Promise<string[]> {
  return getOrThrow(kind).listTables(config, db);
}

// ---------- Plugin management ----------

function toSubprocessInfo(kind: string, c: SubprocessConnector): PluginInfo {
  const meta = c.meta();
  const entry = c.getEntry();
  return {
    kind,
    displayName: meta.displayName,
    source: "subprocess",
    exePath: entry.exePath,
    args: entry.args,
    alive: c.isAlive(),
    recentLogs: c.getRecentStderr(),
  };
}

function toModuleInfo(kind: string, c: ModulePluginConnector): PluginInfo {
  return {
    kind,
    displayName: c.meta().displayName,
    source: "module",
    dir: c.dir,
    recentLogs: [],
  };
}

export function listPlugins(): PluginInfo[] {
  const out: PluginInfo[] = [];
  for (const [kind, c] of registry.entries()) {
    if (c instanceof SubprocessConnector) {
      out.push(toSubprocessInfo(kind, c));
    } else if (c instanceof ModulePluginConnector) {
      out.push(toModuleInfo(kind, c));
    } else {
      out.push({
        kind,
        displayName: c.meta().displayName,
        source: "builtin",
        recentLogs: [],
      });
    }
  }
  // 加载失败的 module 插件作为「未装上」条目展示原因
  for (const e of moduleErrors) {
    out.push({
      kind: e.id,
      displayName: e.displayName ?? e.id,
      source: "module",
      dir: e.dir,
      alive: false,
      loadError: e.error,
      recentLogs: [],
    });
  }
  out.sort((a, b) => {
    if (a.source !== b.source) return a.source.localeCompare(b.source);
    return a.kind.localeCompare(b.kind);
  });
  return out;
}

export async function installPlugin(
  input: PluginInstallInput,
): Promise<PluginInfo> {
  const vaultPath = requireVault();
  const exePath = input.exePath?.trim();
  if (!exePath) {
    throw new AppError("invalid_input", "exePath is required");
  }
  const stat = await fs.stat(exePath).catch(() => null);
  if (!stat || !stat.isFile()) {
    throw new AppError(
      "exe_not_found",
      `exePath does not exist or is not a file: ${exePath}`,
    );
  }
  const entry: PluginEntry = {
    kind: "__pending__",
    exePath,
    args: input.args && input.args.length > 0 ? input.args : undefined,
    env: input.env && Object.keys(input.env).length > 0 ? input.env : undefined,
  };
  const conn = await SubprocessConnector.spawnFromEntry(entry);
  const kind = conn.meta().kind;
  if (registry.get(kind)) {
    conn.shutdown();
    throw new AppError(
      "kind_conflict",
      `connector kind '${kind}' is already installed`,
    );
  }
  entry.kind = kind;
  const entries = await readManifestFile(vaultPath);
  const filtered = entries.filter((e) => e.kind !== kind);
  filtered.push(entry);
  await writeManifestFile(vaultPath, filtered);
  registry.set(kind, conn);
  log.info("subprocess plugin installed", { kind, exePath: entry.exePath });
  return toSubprocessInfo(kind, conn);
}

/**
 * 从一个本地目录安装 module 插件：校验 plugin.json → 拷贝到
 * `{vault}/.stela/plugins/<id>/` → 加载注册。同 id 重装即热重载。
 */
export async function installModulePlugin(
  input: ModulePluginInstallInput,
): Promise<PluginInfo> {
  const vaultPath = requireVault();
  const srcDir = input.srcDir?.trim();
  if (!srcDir) {
    throw new AppError("invalid_input", "srcDir is required");
  }
  const manifest = await readManifest(srcDir);
  const root = pluginsRoot(vaultConfigDir(vaultPath));
  const destDir = `${root}/${manifest.id}`;

  // 若该 id 已安装（同目录），先 dispose 旧实例以便热重载
  for (const [k, c] of [...registry.entries()]) {
    if (c instanceof ModulePluginConnector && c.dir === destDir) {
      await c.dispose();
      registry.delete(k);
    }
  }

  await copyPluginPackage(srcDir, destDir);
  let conn: ModulePluginConnector;
  try {
    conn = await loadModulePlugin(destDir);
  } catch (err) {
    await fs.rm(destDir, { recursive: true, force: true });
    throw err;
  }
  const kind = conn.meta().kind;
  const existing = registry.get(kind);
  if (existing) {
    await conn.dispose();
    await fs.rm(destDir, { recursive: true, force: true });
    throw new AppError(
      "kind_conflict",
      `connector kind '${kind}' is already provided by another plugin`,
    );
  }
  registry.set(kind, conn);
  // 重装成功后清掉该 id 残留的加载错误
  moduleErrors = moduleErrors.filter((e) => e.id !== manifest.id);
  log.info("module plugin installed", { id: manifest.id, kind, dir: destDir });
  return toModuleInfo(kind, conn);
}

/** 一键安装一个应用自带（bundled）的 module 插件。 */
export async function installBundledPlugin(id: string): Promise<PluginInfo> {
  return installModulePlugin({ srcDir: bundledPluginDir(id) });
}

/** 列出应用自带可一键安装的 module 插件，并标注当前 vault 是否已装该 kind。 */
export async function listBundledPlugins(): Promise<BundledPluginInfo[]> {
  const manifests = await listBundledManifests();
  return manifests.map((m) => ({
    id: m.id,
    kind: m.kind,
    displayName: m.displayName,
    installed: registry.has(m.kind),
  }));
}

export async function uninstallPlugin(kind: string): Promise<void> {
  const vaultPath = requireVault();
  const c = registry.get(kind);
  if (!c) {
    throw new AppError("unknown_kind", `connector kind '${kind}' not registered`);
  }
  if (c instanceof SubprocessConnector) {
    c.shutdown();
    registry.delete(kind);
    const entries = await readManifestFile(vaultPath);
    const remaining = entries.filter((e) => e.kind !== kind);
    await writeManifestFile(vaultPath, remaining);
    log.info("subprocess plugin uninstalled", { kind });
    return;
  }
  if (c instanceof ModulePluginConnector) {
    await c.dispose();
    registry.delete(kind);
    await fs.rm(c.dir, { recursive: true, force: true });
    log.info("module plugin uninstalled", { kind, dir: c.dir });
    return;
  }
  throw new AppError(
    "builtin_protected",
    `connector '${kind}' is not an uninstallable plugin`,
  );
}

export function getPluginLogs(kind: string): string[] {
  const c = registry.get(kind);
  if (!c) {
    throw new AppError("unknown_kind", `connector kind '${kind}' not registered`);
  }
  if (c instanceof SubprocessConnector) {
    return c.getRecentStderr();
  }
  return [];
}

/**
 * 找到一个 subprocess plugin；不是 subprocess 就抛 builtin_protected。
 * 用于 start/stop/restart 的入口共用守卫。
 */
function getSubprocessOrThrow(kind: string): SubprocessConnector {
  const c = registry.get(kind);
  if (!c) {
    throw new AppError(
      "unknown_kind",
      `connector kind '${kind}' not registered`,
    );
  }
  if (!(c instanceof SubprocessConnector)) {
    throw new AppError(
      "builtin_protected",
      `connector '${kind}' is not a subprocess plugin`,
    );
  }
  return c;
}

/** 启动指定 subprocess plugin（活的则 no-op，死的则 spawn + hello 握手）。 */
export async function startPlugin(kind: string): Promise<PluginInfo> {
  const c = getSubprocessOrThrow(kind);
  await c.start();
  log.info("plugin started", { kind });
  return toSubprocessInfo(kind, c);
}

/** 停止指定 subprocess plugin（杀子进程，registry 实例与 manifest 不变）。 */
export function stopPlugin(kind: string): PluginInfo {
  const c = getSubprocessOrThrow(kind);
  c.shutdown();
  log.info("plugin stopped", { kind });
  return toSubprocessInfo(kind, c);
}

/** 重启 = stop + start。 */
export async function restartPlugin(kind: string): Promise<PluginInfo> {
  const c = getSubprocessOrThrow(kind);
  c.shutdown();
  await c.start();
  log.info("plugin restarted", { kind });
  return toSubprocessInfo(kind, c);
}

/** App quit 时调用：dispose 所有插件。 */
export function shutdown(): void {
  void disposeAllDynamic();
  currentVaultPath = null;
}
