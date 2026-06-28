/**
 * Vault 级连接配置持久化（per-device secret shard 模型）。
 *
 * 文件布局：
 *   - `{vault}/.stela/connections.json`            共享：连接名 / kind / 非敏感 config / schemaDir
 *   - `{vault}/.stela/secrets/secrets_<slug>.json` 每设备：本机 safeStorage 包裹的 secret
 *
 * 设计动机（跨设备同步）：
 *   safeStorage 加密值是「本机可解」的——macOS Keychain / Windows DPAPI / Linux libsecret，
 *   另一台机器拿到密文解不开。因此把 secret 从共享 connections.json 拆出来，按设备 slug
 *   分片落到 `secrets/secrets_<slug>.json`：
 *     - 共享 connections.json 不含任何 secret 字段，可安全进 Git；
 *     - 每台设备只读写自己 slug 对应的 shard，物理层零写冲突（同 history JSONL 的写隔离思路）；
 *     - 所有设备的 shard 都随 Git 同步，但只有对应设备能解密自己的那份。
 *   新设备首次打开 vault 会看到连接（来自共享配置）但本机缺 secret，需在本机补填一次。
 *
 * device slug 由调用方（handlers，已 import device-profile）注入；本模块**不** import
 * device-profile，避免把 electron `app` 依赖带进来导致 RUN_AS_NODE 单测无法加载。
 *
 * 凭据保护：
 *   - shard 写盘前把 secret 字段（secrets.isSecretKey 命中）经 safeStorage 加密；
 *   - load 时解密 shard 并合并回 config，返回 renderer 的是明文（一次性透传）；
 *   - safeStorage 不可用时退化为 `__plain:` 前缀（UI 应显示 banner 警告）；
 *   - 空 secret（用户清空或本机缺失）不覆盖 shard 里已有的 wrapped 值。
 *
 * 写策略：atomic write（.tmp + rename）。
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { AppError } from "@shared/errors";
import type { ConnectionEntry, ConnectionMap } from "@shared/types";

import { atomicWriteFile } from "./atomic-write";
import { getLogger } from "./logger";
import * as secrets from "./secrets";
import { vaultConfigDir, vaultFilePath } from "./vault-paths";

const FILE_NAME = "connections.json";
const SECRETS_DIR = "secrets";
const log = getLogger("connections");

interface RawFile {
  entries?: ConnectionMap;
}

/** 每设备 secret shard：连接名 → { secret 字段名 → wrapped 值 }。 */
interface SecretShard {
  entries?: Record<string, Record<string, string>>;
}

function filePath(vaultPath: string): string {
  return vaultFilePath(vaultPath, FILE_NAME);
}

function shardPath(vaultPath: string, slug: string): string {
  return path.join(vaultConfigDir(vaultPath), SECRETS_DIR, `secrets_${slug}.json`);
}

async function readRaw(vaultPath: string): Promise<RawFile> {
  try {
    const buf = await fs.readFile(filePath(vaultPath), "utf-8");
    return JSON.parse(buf) as RawFile;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return {};
    throw new AppError(
      "connections_read_failed",
      `read connections failed: ${e.message}`,
    );
  }
}

async function writeRaw(vaultPath: string, raw: RawFile): Promise<void> {
  await atomicWriteFile(filePath(vaultPath), JSON.stringify(raw, null, 2));
}

async function readShard(vaultPath: string, slug: string): Promise<SecretShard> {
  try {
    const buf = await fs.readFile(shardPath(vaultPath, slug), "utf-8");
    return JSON.parse(buf) as SecretShard;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return {};
    throw new AppError(
      "connections_read_failed",
      `read secret shard failed: ${e.message}`,
    );
  }
}

async function writeShard(
  vaultPath: string,
  slug: string,
  shard: SecretShard,
): Promise<void> {
  await atomicWriteFile(
    shardPath(vaultPath, slug),
    JSON.stringify(shard, null, 2),
  );
}

/**
 * 把一个 config 拆成「非敏感字段」与「提交的 secret 字段（明文，可能为空串）」。
 * 非敏感字段写共享 connections.json；secret 字段进当前设备 shard。
 */
function partitionConfig(config: unknown): {
  base: Record<string, unknown>;
  submittedSecrets: Record<string, string>;
} {
  const base: Record<string, unknown> = {};
  const submittedSecrets: Record<string, string> = {};
  if (!config || typeof config !== "object") {
    return { base, submittedSecrets };
  }
  for (const [k, v] of Object.entries(config as Record<string, unknown>)) {
    if (secrets.isSecretKey(k)) {
      if (typeof v === "string") submittedSecrets[k] = v;
      // 非字符串 secret 值直接丢弃（不应出现）
    } else {
      base[k] = v;
    }
  }
  return { base, submittedSecrets };
}

/**
 * 合并当前设备 shard 的 secret 到「非敏感 config」上，secret 解密成明文。
 * 用于 load 时把共享配置 + 本机 secret 拼回 renderer 可用的完整 config。
 */
function mergeShardIntoEntry(
  entry: ConnectionEntry,
  shardEntry: Record<string, string> | undefined,
): ConnectionEntry {
  const base = { ...partitionConfig(entry.config).base };
  if (shardEntry) {
    for (const [k, wrapped] of Object.entries(shardEntry)) {
      if (typeof wrapped !== "string") continue;
      base[k] = secrets.decryptToken(wrapped);
    }
  }
  return { ...entry, config: base };
}

function mergeShardIntoMap(
  map: ConnectionMap,
  shard: SecretShard,
): ConnectionMap {
  const out: ConnectionMap = {};
  for (const [name, entry] of Object.entries(map)) {
    out[name] = mergeShardIntoEntry(entry, shard.entries?.[name]);
  }
  return out;
}

/**
 * 旧配置迁移：把「token 明文塞在 `config.headers.Authorization`」归一化为顶层
 * `authorization` 字段（去掉 `Bearer ` 前缀；http connector 注入时会自动补）。
 *
 * 只迁移 `Bearer ` 开头的 Authorization；其它鉴权方案（Basic 等）原样保留。已有顶层
 * authorization 时不覆盖，只清掉 header 明文。幂等：无 header 凭据时返回 changed=false。
 */
function migrateHeaderAuth(entry: ConnectionEntry): {
  entry: ConnectionEntry;
  changed: boolean;
} {
  const cfg = entry.config;
  if (!cfg || typeof cfg !== "object") return { entry, changed: false };
  const c = cfg as Record<string, unknown>;
  const headers = c.headers;
  if (!headers || typeof headers !== "object") return { entry, changed: false };
  const h = headers as Record<string, unknown>;
  const rawHeader = h.Authorization ?? h.authorization;
  if (typeof rawHeader !== "string") return { entry, changed: false };
  const m = /^Bearer\s+(.+)$/i.exec(rawHeader.trim());
  if (!m) return { entry, changed: false };
  const token = m[1]!.trim();
  if (!token) return { entry, changed: false };

  const nextHeaders: Record<string, unknown> = { ...h };
  delete nextHeaders.Authorization;
  delete nextHeaders.authorization;

  const nextConfig: Record<string, unknown> = { ...c, headers: nextHeaders };
  const hasTop =
    typeof c.authorization === "string" && c.authorization.length > 0;
  if (!hasTop) nextConfig.authorization = token;

  return { entry: { ...entry, config: nextConfig }, changed: true };
}

/**
 * 把单个共享 entry 里残留的 secret（旧机器级格式：secret 直接落在 connections.json
 * 的 config 里，可能是 wrapped 或明文）迁移进当前设备 shard，并从共享 config 剥离。
 *
 * 返回剥离 secret 后的共享 entry、要并入 shard 的 secret（已 wrapped），以及是否发生迁移。
 */
function migrateInlineSecrets(
  entry: ConnectionEntry,
  existingShardEntry: Record<string, string> | undefined,
): {
  sharedEntry: ConnectionEntry;
  shardEntry: Record<string, string>;
  changed: boolean;
} {
  const { base, submittedSecrets } = partitionConfig(entry.config);
  const shardEntry: Record<string, string> = { ...(existingShardEntry ?? {}) };
  let changed = false;

  for (const [k, v] of Object.entries(submittedSecrets)) {
    if (v.length === 0) continue;
    // shard 已有该 secret 时不覆盖（shard 是本机权威）。
    if (typeof shardEntry[k] === "string" && shardEntry[k]!.length > 0) {
      changed = true; // 仍需把共享 config 里的明文剥离
      continue;
    }
    shardEntry[k] = secrets.isWrapped(v) ? v : secrets.encryptToken(v);
    changed = true;
  }

  return {
    sharedEntry: changed ? { ...entry, config: base } : entry,
    shardEntry,
    changed,
  };
}

/**
 * 读取连接：共享非敏感配置 + 当前设备 secret shard 合并成完整 config。
 *
 * 顺带做一次幂等迁移：把旧式 header 凭据归一化到顶层 authorization，并把残留在
 * 共享 connections.json 里的 inline secret 搬进当前设备 shard、从共享文件剥离。
 * 只有真正发生迁移时才回写磁盘。
 */
export async function loadConnections(
  vaultPath: string,
  slug: string,
): Promise<ConnectionMap> {
  const raw = await readRaw(vaultPath);
  const src = raw.entries ?? {};
  const shard = await readShard(vaultPath, slug);
  const shardEntries: Record<string, Record<string, string>> = {
    ...(shard.entries ?? {}),
  };

  let sharedChanged = false;
  let shardChanged = false;
  const sharedOut: ConnectionMap = {};

  for (const [name, entry] of Object.entries(src)) {
    const afterHeader = migrateHeaderAuth(entry);
    if (afterHeader.changed) sharedChanged = true;

    const m = migrateInlineSecrets(afterHeader.entry, shardEntries[name]);
    if (m.changed) {
      sharedChanged = true;
      shardChanged = true;
      shardEntries[name] = m.shardEntry;
    }
    sharedOut[name] = m.sharedEntry;
  }

  if (sharedChanged) {
    await writeRaw(vaultPath, { entries: sharedOut });
  }
  if (shardChanged) {
    await writeShard(vaultPath, slug, { entries: shardEntries });
  }

  return mergeShardIntoMap(sharedOut, { entries: shardEntries });
}

/**
 * 写入/更新一个连接：
 *   - 非敏感字段写共享 connections.json（进 Git）；
 *   - secret 字段加密后写当前设备 shard（secrets_<slug>.json）；
 *   - 提交的 secret 为空 / 缺失时，保留 shard 里已有 wrapped 值（不被空值擦除）。
 */
export async function upsertConnection(
  vaultPath: string,
  slug: string,
  name: string,
  entry: ConnectionEntry,
): Promise<ConnectionMap> {
  // 先做 header→顶层 authorization 归一化，再拆分 secret。
  const normalized = migrateHeaderAuth(entry).entry;
  const { base, submittedSecrets } = partitionConfig(normalized.config);

  log.info("upsert", {
    name,
    kind: normalized.kind,
    config: secrets.redactConfig(normalized.config),
    schemaDir: normalized.schemaDir,
  });

  // 共享文件：写入非敏感 config（不含任何 secret 字段）。
  const raw = await readRaw(vaultPath);
  const map = raw.entries ?? {};
  map[name] = { ...normalized, config: base };
  await writeRaw(vaultPath, { entries: map });

  // 当前设备 shard：更新本机 secret。
  const shard = await readShard(vaultPath, slug);
  const shardEntries: Record<string, Record<string, string>> = {
    ...(shard.entries ?? {}),
  };
  const nextShardEntry: Record<string, string> = { ...(shardEntries[name] ?? {}) };
  for (const [k, v] of Object.entries(submittedSecrets)) {
    // 空值（清空 / 本机暂缺）不覆盖已有 wrapped 值。
    if (v.length === 0) continue;
    nextShardEntry[k] = secrets.isWrapped(v) ? v : secrets.encryptToken(v);
  }
  if (Object.keys(nextShardEntry).length > 0) {
    shardEntries[name] = nextShardEntry;
  } else {
    delete shardEntries[name];
  }
  await writeShard(vaultPath, slug, { entries: shardEntries });

  return mergeShardIntoMap(map, { entries: shardEntries });
}

/**
 * 删除连接：从共享 connections.json 删除条目，并删掉当前设备 shard 里的同名 secret。
 *
 * 不主动删其它设备 shard 的孤儿 secret——避免误删别的设备仍在用的密钥；其它设备下次
 * 同步后共享条目消失，孤儿 secret 可后续清理。
 */
export async function removeConnection(
  vaultPath: string,
  slug: string,
  name: string,
): Promise<ConnectionMap> {
  log.info("remove", { name });
  const raw = await readRaw(vaultPath);
  const map = raw.entries ?? {};
  delete map[name];
  await writeRaw(vaultPath, { entries: map });

  const shard = await readShard(vaultPath, slug);
  const shardEntries: Record<string, Record<string, string>> = {
    ...(shard.entries ?? {}),
  };
  if (shardEntries[name]) {
    delete shardEntries[name];
    await writeShard(vaultPath, slug, { entries: shardEntries });
  }

  return mergeShardIntoMap(map, { entries: shardEntries });
}
