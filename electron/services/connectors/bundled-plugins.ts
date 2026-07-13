/**
 * 应用自带（bundled）module 插件的解析与按需 seed。
 *
 * 公开自带插件源码在仓库 `plugins/<id>/`，构建产物（`plugin.json` + `dist/index.cjs`）
 * 随应用分发：
 *   - dev：直接读仓库根 `plugins/`（app.getAppPath() = 项目根）
 *   - prod：electron-builder `extraResources` 把 `plugins/` 拷到
 *     `process.resourcesPath/plugins/`
 *
 * 用途：
 *   1. Plugins 面板「安装自带示例」一键安装（listBundled / installBundled 走 registry）
 *   2. 向后兼容 seed：打开任意 vault 时，确保官方 mysql/postgresql 插件已就位。
 *      用 marker 记录已 seed 的 id，用户主动卸载后不会被重新塞回。
 *
 * 本模块 import electron `app`，仅在 main 进程使用。
 */

import { app } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";

import { getLogger } from "../logger";
import { vaultConfigDir } from "../vault-paths";
import {
  copyPluginPackage,
  pluginsRoot,
  readManifest,
  type ModulePluginManifest,
} from "./module-loader";

const log = getLogger("connector:bundled-plugins");

/**
 * 开源默认分发的自带插件 id。
 *
 * STELA_BUNDLED_PLUGINS 主要给内部私有构建使用；公开构建不需要设置它。
 * 即使 dev 目录里存在其它插件，也不会出现在 catalog 或 seed 流程里。
 */
const DEFAULT_BUNDLED_PLUGIN_IDS = [
  "connector-mysql",
  "connector-postgresql",
  "connector-http-sample",
];

/** 打开 vault 时自动 seed 的官方 connector。 */
const AUTO_SEED_IDS = ["connector-mysql", "connector-postgresql"];
const SEED_MARKER = ".bundled-seeded.json";

interface SeedMarker {
  /** 曾成功 seed 过的 id（审计用；是否跳过看 removed + 是否已安装）。 */
  seeded: string[];
  /** 用户主动卸载的 auto-seed 插件，打开 vault 时不再自动装回。 */
  removed: string[];
}

const IS_DEV = !!process.env.ELECTRON_RENDERER_URL;

export function isAutoSeedPluginId(id: string): boolean {
  return (AUTO_SEED_IDS as readonly string[]).includes(id);
}

/** 自带插件包根目录。 */
export function bundledPluginsRoot(): string {
  return IS_DEV
    ? path.join(app.getAppPath(), "plugins")
    : path.join(process.resourcesPath, "plugins");
}

export function bundledPluginDir(id: string): string {
  return path.join(bundledPluginsRoot(), id);
}

function bundledPluginIds(): string[] {
  const raw = process.env.STELA_BUNDLED_PLUGINS;
  if (!raw || !raw.trim()) return DEFAULT_BUNDLED_PLUGIN_IDS;
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

async function dirExists(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

async function isPluginInstalled(
  pluginsDir: string,
  id: string,
): Promise<boolean> {
  const dir = path.join(pluginsDir, id);
  try {
    const manifest = await readManifest(dir);
    return await fileExists(path.resolve(dir, manifest.entry));
  } catch {
    return false;
  }
}

function parseSeedMarker(raw: unknown): SeedMarker {
  if (Array.isArray(raw)) {
    return {
      seeded: raw.filter((id): id is string => typeof id === "string"),
      removed: [],
    };
  }
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const seeded = Array.isArray(o.seeded)
      ? o.seeded.filter((id): id is string => typeof id === "string")
      : [];
    const removed = Array.isArray(o.removed)
      ? o.removed.filter((id): id is string => typeof id === "string")
      : [];
    return { seeded, removed };
  }
  return { seeded: [], removed: [] };
}

async function readSeedMarker(markerPath: string): Promise<SeedMarker> {
  try {
    const raw = JSON.parse(await fs.readFile(markerPath, "utf-8")) as unknown;
    return parseSeedMarker(raw);
  } catch {
    return { seeded: [], removed: [] };
  }
}

async function writeSeedMarker(
  root: string,
  marker: SeedMarker,
): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, SEED_MARKER),
    JSON.stringify(marker, null, 2),
    "utf-8",
  );
}

/** 用户卸载 auto-seed 插件时写入 marker，避免下次打开 vault 又自动装回。 */
export async function markBundledPluginRemoved(
  vaultPath: string,
  pluginId: string,
): Promise<void> {
  if (!isAutoSeedPluginId(pluginId)) return;
  const root = pluginsRoot(vaultConfigDir(vaultPath));
  const markerPath = path.join(root, SEED_MARKER);
  const marker = await readSeedMarker(markerPath);
  if (!marker.removed.includes(pluginId)) {
    marker.removed.push(pluginId);
  }
  try {
    await writeSeedMarker(root, marker);
  } catch (err) {
    log.error("write seed marker failed", { err: (err as Error).message });
  }
}

/** 列出所有自带插件包（读各自 plugin.json）。entry 未构建的包会被跳过。 */
export async function listBundledManifests(): Promise<ModulePluginManifest[]> {
  const root = bundledPluginsRoot();
  const out: ModulePluginManifest[] = [];
  for (const id of bundledPluginIds()) {
    const dir = path.join(root, id);
    try {
      const m = await readManifest(dir);
      const entryBuilt = await fileExists(path.resolve(dir, m.entry));
      if (entryBuilt) out.push(m);
    } catch {
      /* 跳过非法 / 未构建的包 */
    }
  }
  return out;
}

/**
 * 按需把自带的官方插件 seed 到目标 vault 的 `.stela/plugins/`。
 *
 * - 已安装（manifest + entry 在）→ 跳过
 * - 用户在 removed 列表里 → 跳过（主动卸载后不再自动装回）
 * - marker 里写过 seeded 但文件丢了 → 仍会补种（修复损坏 / 被误删）
 */
export async function seedBundledPlugins(vaultPath: string): Promise<void> {
  const root = pluginsRoot(vaultConfigDir(vaultPath));
  const marker = await readSeedMarker(path.join(root, SEED_MARKER));
  let changed = false;
  const allowed = new Set(bundledPluginIds());
  for (const id of AUTO_SEED_IDS) {
    if (!allowed.has(id)) continue;
    if (marker.removed.includes(id)) continue;
    if (await isPluginInstalled(root, id)) continue;
    const src = bundledPluginDir(id);
    if (!(await dirExists(src))) {
      log.warn("bundled plugin source missing, skip seed", { id, src });
      continue;
    }
    try {
      await copyPluginPackage(src, path.join(root, id));
      if (!marker.seeded.includes(id)) {
        marker.seeded.push(id);
      }
      changed = true;
      log.info("seeded bundled plugin", { id, vaultPath });
    } catch (err) {
      log.error("seed bundled plugin failed", {
        id,
        err: (err as Error).message,
      });
    }
  }
  if (changed) {
    try {
      await writeSeedMarker(root, marker);
    } catch (err) {
      log.error("write seed marker failed", { err: (err as Error).message });
    }
  }
}
