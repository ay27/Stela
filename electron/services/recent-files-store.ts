/**
 * Per-vault、机器本地的「最近打开文件」列表。
 *
 * 文件：`{vault}/.stela/recent-files.local.json`
 *
 * 不进 Git：每台机器编辑的文件不同，若落在 settings.json 里会在多机 pull/merge
 * 时反复冲突。与 `recentVaults`（user-cache）同理，属于本机 UX 状态。
 */

import { promises as fs } from "node:fs";

import { AppError } from "@shared/errors";
import type { RecentFileEntry } from "@shared/types";

import { atomicWriteFile } from "./atomic-write";
import { vaultFilePath } from "./vault-paths";

export const FILE_NAME = "recent-files.local.json";

/** 最近文件列表的硬上限。超过的尾部会被截断。 */
export const RECENT_FILES_LIMIT = 24;

export function sanitizeRecentFiles(input: unknown): RecentFileEntry[] {
  if (!Array.isArray(input)) return [];
  const out: RecentFileEntry[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const p = r.path;
    const ts = r.openedAt;
    if (typeof p !== "string" || p.length === 0) continue;
    if (typeof ts !== "number" || !Number.isFinite(ts)) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push({ path: p, openedAt: ts });
    if (out.length >= RECENT_FILES_LIMIT) break;
  }
  return out;
}

function filePath(vaultPath: string): string {
  return vaultFilePath(vaultPath, FILE_NAME);
}

async function readRaw(vaultPath: string): Promise<RecentFileEntry[] | null> {
  try {
    const buf = await fs.readFile(filePath(vaultPath), "utf-8");
    const parsed = JSON.parse(buf) as unknown;
    if (Array.isArray(parsed)) {
      return sanitizeRecentFiles(parsed);
    }
    if (parsed && typeof parsed === "object") {
      const files = (parsed as { files?: unknown }).files;
      return sanitizeRecentFiles(files);
    }
    return [];
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return null;
    throw new AppError(
      "recent_files_read_failed",
      `read recent files failed: ${e.message}`,
    );
  }
}

async function writeRaw(
  vaultPath: string,
  files: RecentFileEntry[],
): Promise<void> {
  await atomicWriteFile(
    filePath(vaultPath),
    JSON.stringify({ files: sanitizeRecentFiles(files) }, null, 2),
  );
}

export async function loadRecentFiles(vaultPath: string): Promise<RecentFileEntry[]> {
  const raw = await readRaw(vaultPath);
  return raw ?? [];
}

export async function saveRecentFiles(
  vaultPath: string,
  files: RecentFileEntry[],
): Promise<RecentFileEntry[]> {
  const next = sanitizeRecentFiles(files);
  await writeRaw(vaultPath, next);
  return next;
}

/**
 * 从 settings.json 迁出 legacy `vault.recentFiles`（仅当 local 文件尚不存在）。
 * 返回是否执行了迁移。
 */
export async function migrateFromSettingsIfNeeded(
  vaultPath: string,
  legacyFiles: unknown,
): Promise<boolean> {
  const existing = await readRaw(vaultPath);
  if (existing !== null) return false;
  const migrated = sanitizeRecentFiles(legacyFiles);
  if (migrated.length === 0) return false;
  await writeRaw(vaultPath, migrated);
  return true;
}
