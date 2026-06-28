/**
 * 设备标识（机器级，跨 vault）。
 *
 * 文件：`{userData}/device-profile.json`，**不进 vault / git**。
 * 用途：执行历史按设备分片写入 `.stela/history/history_{slug}.jsonl`，做到
 * "写隔离、读合并"——不同设备写不同文件，Git 层永不行级冲突。
 *
 * - `deviceId`：稳定 UUID，用于检测两台机器误用同一 slug（clone 后同名）。
 * - `slug`：文件名片段，默认取主机名消毒；用户可在 Settings 改。
 */

import { app } from "electron";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { AppError } from "@shared/errors";
import type { DeviceProfile } from "@shared/types";

import { atomicWriteFile } from "./atomic-write";
import { getLogger } from "./logger";

const FILE_NAME = "device-profile.json";
const log = getLogger("device-profile");

let cached: DeviceProfile | null = null;

function filePath(): string {
  return path.join(app.getPath("userData"), FILE_NAME);
}

/** slug 消毒：小写、非 [a-z0-9_-] 折叠为 `-`、去首尾 `-`、上限 48 字符。 */
export function sanitizeSlug(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return base || "device";
}

function defaultSlug(): string {
  const host = os.hostname().split(".")[0] ?? "device";
  return sanitizeSlug(host);
}

async function readRaw(): Promise<Partial<DeviceProfile> | null> {
  try {
    const buf = await fs.readFile(filePath(), "utf-8");
    return JSON.parse(buf) as Partial<DeviceProfile>;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return null;
    throw new AppError(
      "device_profile_read_failed",
      `read device profile failed: ${e.message}`,
    );
  }
}

/** 读取（或首次生成并落盘）本机设备标识。结果缓存到内存。 */
export async function loadDeviceProfile(): Promise<DeviceProfile> {
  if (cached) return cached;
  const raw = await readRaw();
  if (raw && typeof raw.deviceId === "string" && raw.deviceId.length > 0) {
    const profile: DeviceProfile = {
      deviceId: raw.deviceId,
      slug:
        typeof raw.slug === "string" && raw.slug.length > 0
          ? sanitizeSlug(raw.slug)
          : defaultSlug(),
    };
    cached = profile;
    return profile;
  }
  const fresh: DeviceProfile = {
    deviceId: randomUUID(),
    slug: defaultSlug(),
  };
  await atomicWriteFile(filePath(), JSON.stringify(fresh, null, 2)).catch(
    (err: unknown) => {
      log.error("write device profile failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    },
  );
  cached = fresh;
  return fresh;
}

/** 修改 slug（保持 deviceId 不变）。返回更新后的 profile。 */
export async function setDeviceSlug(slug: string): Promise<DeviceProfile> {
  const current = await loadDeviceProfile();
  const next: DeviceProfile = {
    deviceId: current.deviceId,
    slug: sanitizeSlug(slug),
  };
  await atomicWriteFile(filePath(), JSON.stringify(next, null, 2));
  cached = next;
  return next;
}
