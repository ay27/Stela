/**
 * Module 插件加载器（进程内 JS 模块 connector）。
 *
 * 与 subprocess 插件并列的第二种 connector 承载形态：
 *   - 插件是一个**单文件 CJS bundle**（见 plugins/<id>/build.mjs），随 vault 安装在
 *     `{vault}/.stela/plugins/<id>/`，由 main 进程用 `createRequire` 动态 require 进来，
 *     以**完整 Node/Electron 权限**运行（安装即完全信任，类比 VSCode 扩展）。
 *   - 每个插件目录含 `plugin.json` manifest + `dist/index.cjs`（entry）。
 *
 * 设计要点：
 *   - 本模块刻意**不 import electron**，纯 Node，方便 tsx 单测。
 *   - 重装 / 切 vault 通过 `delete require.cache[entry]` 实现热重载（bundle 单文件，
 *     删一个 cache key 即可甩掉整棵依赖树）。
 *   - 加载失败不抛到上层 setVault，由调用方收集成 ModulePluginLoadError 展示在 UI。
 *
 * 协议版本：v1（与 plugin-sdk 的 CONNECTOR_PLUGIN_API_VERSION 对齐）。
 */

import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import path from "node:path";

import { AppError } from "@shared/errors";

import { getLogger } from "../logger";
import type { Connector } from "./types";

const log = getLogger("connector:module-loader");
const requireModule = createRequire(import.meta.url);

/** host 支持的最高 module 插件协议版本。 */
export const MODULE_PLUGIN_API_VERSION = 1;

/** vault 内放 module 插件的子目录（位于 `{vault}/.stela/plugins/`）。 */
export const PLUGINS_DIRNAME = "plugins";

const MANIFEST_FILE = "plugin.json";
/** 合法插件 id：小写字母 / 数字 / `-` / `_`，禁止 `.` 与路径分隔符，避免越权写。 */
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface ModulePluginManifest {
  /** 安装目录名 = 插件唯一 id。 */
  id: string;
  /** connector kind（信息性；权威 kind 取自加载后的 meta().kind）。 */
  kind: string;
  displayName: string;
  apiVersion: number;
  /** 相对插件目录的 entry 路径，例 "dist/index.cjs"。 */
  entry: string;
}

/** 一个插件目录加载失败的记录，供 UI 展示「为什么没装上」。 */
export interface ModulePluginLoadError {
  id: string;
  displayName?: string;
  dir: string;
  error: string;
}

/** `{vault}/.stela/plugins` 绝对路径。 */
export function pluginsRoot(vaultConfigDirPath: string): string {
  return path.join(vaultConfigDirPath, PLUGINS_DIRNAME);
}

/**
 * 包装一个 module 插件返回的 connector，附带 manifest / 安装目录，供 registry
 * 用 `instanceof` 区分来源、listPlugins 展示、卸载时删目录。
 */
export class ModulePluginConnector implements Connector {
  constructor(
    private readonly inner: Connector,
    readonly manifest: ModulePluginManifest,
    readonly dir: string,
  ) {}

  meta() {
    return this.inner.meta();
  }
  test(cfg: unknown) {
    return this.inner.test(cfg);
  }
  execute(cfg: unknown, sql: string) {
    return this.inner.execute(cfg, sql);
  }
  listDatabases(cfg: unknown) {
    return this.inner.listDatabases(cfg);
  }
  listTables(cfg: unknown, db?: string | null) {
    return this.inner.listTables(cfg, db);
  }
  async dispose(): Promise<void> {
    try {
      await this.inner.dispose?.();
    } catch (err) {
      log.error("module plugin dispose failed", {
        id: this.manifest.id,
        err: (err as Error).message,
      });
    }
  }
}

function assertManifest(raw: unknown, dir: string): ModulePluginManifest {
  if (!raw || typeof raw !== "object") {
    throw new AppError("bad_manifest", `${MANIFEST_FILE} is not an object`);
  }
  const m = raw as Record<string, unknown>;
  const id = m.id;
  const kind = m.kind;
  const displayName = m.displayName;
  const apiVersion = m.apiVersion;
  const entry = m.entry;
  if (typeof id !== "string" || !ID_RE.test(id)) {
    throw new AppError(
      "bad_manifest",
      `invalid plugin id (a-z0-9-_): ${String(id)}`,
    );
  }
  if (typeof kind !== "string" || kind.length === 0) {
    throw new AppError("bad_manifest", "manifest.kind required");
  }
  if (typeof entry !== "string" || entry.length === 0) {
    throw new AppError("bad_manifest", "manifest.entry required");
  }
  // entry 不能越出插件目录
  const entryAbs = path.resolve(dir, entry);
  if (!entryAbs.startsWith(path.resolve(dir) + path.sep)) {
    throw new AppError("bad_manifest", `entry escapes plugin dir: ${entry}`);
  }
  return {
    id,
    kind,
    displayName: typeof displayName === "string" ? displayName : id,
    apiVersion: typeof apiVersion === "number" ? apiVersion : 0,
    entry,
  };
}

export async function readManifest(dir: string): Promise<ModulePluginManifest> {
  const fp = path.join(dir, MANIFEST_FILE);
  let buf: string;
  try {
    buf = await fs.readFile(fp, "utf-8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    throw new AppError(
      e.code === "ENOENT" ? "manifest_not_found" : "manifest_read_failed",
      `read ${MANIFEST_FILE} failed: ${e.message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf);
  } catch (err) {
    throw new AppError(
      "manifest_parse_failed",
      `parse ${MANIFEST_FILE} failed: ${(err as Error).message}`,
    );
  }
  return assertManifest(parsed, dir);
}

function pluginLogger(id: string) {
  const l = getLogger(`plugin:${id}`);
  return {
    info: (m: string, meta?: Record<string, unknown>) => l.info(m, meta ?? {}),
    warn: (m: string, meta?: Record<string, unknown>) => l.warn(m, meta ?? {}),
    error: (m: string, meta?: Record<string, unknown>) =>
      l.error(m, meta ?? {}),
  };
}

function validateConnector(c: unknown, id: string): Connector {
  const obj = c as Partial<Connector> | null;
  if (
    !obj ||
    typeof obj.meta !== "function" ||
    typeof obj.test !== "function" ||
    typeof obj.execute !== "function" ||
    typeof obj.listDatabases !== "function" ||
    typeof obj.listTables !== "function"
  ) {
    throw new AppError(
      "bad_plugin",
      `plugin '${id}' create() did not return a valid Connector`,
    );
  }
  return obj as Connector;
}

/**
 * 加载单个插件目录 → ModulePluginConnector。
 * 失败抛 AppError。会先 bust require.cache 以支持热重载（重装）。
 */
export async function loadModulePlugin(
  dir: string,
): Promise<ModulePluginConnector> {
  const manifest = await readManifest(dir);
  if (manifest.apiVersion > MODULE_PLUGIN_API_VERSION) {
    throw new AppError(
      "incompatible_plugin",
      `plugin '${manifest.id}' apiVersion ${manifest.apiVersion} > host ${MODULE_PLUGIN_API_VERSION}`,
    );
  }
  const entryAbs = path.resolve(dir, manifest.entry);
  // 热重载：删掉旧 cache（bundle 单文件，删一个 key 足够）
  try {
    delete requireModule.cache[requireModule.resolve(entryAbs)];
  } catch {
    /* 首次加载没有 cache，忽略 */
  }
  let raw: unknown;
  try {
    raw = requireModule(entryAbs);
  } catch (err) {
    throw new AppError(
      "plugin_require_failed",
      `require '${manifest.id}' failed: ${(err as Error).message}`,
    );
  }
  const mod = (raw as { default?: unknown })?.default ?? raw;
  const modObj = mod as { apiVersion?: unknown; create?: unknown } | null;
  if (
    !modObj ||
    typeof modObj.create !== "function" ||
    typeof modObj.apiVersion !== "number"
  ) {
    throw new AppError(
      "bad_plugin",
      `plugin '${manifest.id}' default export is not a StelaConnectorPluginModule`,
    );
  }
  if (modObj.apiVersion > MODULE_PLUGIN_API_VERSION) {
    throw new AppError(
      "incompatible_plugin",
      `plugin '${manifest.id}' module apiVersion ${modObj.apiVersion} > host ${MODULE_PLUGIN_API_VERSION}`,
    );
  }
  const created = (
    modObj.create as (ctx: {
      pluginDir: string;
      log: ReturnType<typeof pluginLogger>;
    }) => unknown
  )({ pluginDir: dir, log: pluginLogger(manifest.id) });
  const connector = validateConnector(created, manifest.id);
  return new ModulePluginConnector(connector, manifest, dir);
}

/**
 * 扫描 `{root}/*`（每个子目录一个插件），逐个加载。
 * 返回成功的 connector + 失败记录；不抛（让 setVault 不被单个坏插件拖垮）。
 */
export async function loadAllModulePlugins(root: string): Promise<{
  connectors: ModulePluginConnector[];
  errors: ModulePluginLoadError[];
}> {
  const connectors: ModulePluginConnector[] = [];
  const errors: ModulePluginLoadError[] = [];
  let dirents: import("node:fs").Dirent[];
  try {
    dirents = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") {
      log.error("read plugins root failed", { root, err: e.message });
    }
    return { connectors, errors };
  }
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    try {
      const conn = await loadModulePlugin(dir);
      connectors.push(conn);
      log.info("module plugin loaded", {
        id: conn.manifest.id,
        kind: conn.meta().kind,
        dir,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ id: d.name, dir, error: msg });
      log.error("module plugin load failed", { dir, err: msg });
    }
  }
  return { connectors, errors };
}

/**
 * 把一个「插件包」目录（含 plugin.json + entry）拷贝到目标安装目录。
 * 只拷 manifest 与 entry 文件（含其相对子目录），不带 src / node_modules。
 * 目标若已存在会被覆盖式更新（先删再建）。
 */
export async function copyPluginPackage(
  srcDir: string,
  destDir: string,
): Promise<ModulePluginManifest> {
  const manifest = await readManifest(srcDir);
  const srcEntry = path.resolve(srcDir, manifest.entry);
  const stat = await fs.stat(srcEntry).catch(() => null);
  if (!stat || !stat.isFile()) {
    throw new AppError(
      "entry_not_found",
      `plugin entry not found (build first?): ${manifest.entry}`,
    );
  }
  await fs.rm(destDir, { recursive: true, force: true });
  await fs.mkdir(destDir, { recursive: true });
  // manifest
  await fs.copyFile(
    path.join(srcDir, MANIFEST_FILE),
    path.join(destDir, MANIFEST_FILE),
  );
  // entry（保留相对子目录，如 dist/index.cjs）
  const destEntry = path.resolve(destDir, manifest.entry);
  await fs.mkdir(path.dirname(destEntry), { recursive: true });
  await fs.copyFile(srcEntry, destEntry);
  return manifest;
}
