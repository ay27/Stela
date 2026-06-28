/**
 * Vault-scoped 配置文件路径工具。
 *
 * 所有 vault 内的配置（settings / connections / connector_plugins）都集中在
 * `{vault}/.stela/`。这一层把"路径计算 + 目录创建 + 原子写"收敛到单点，避免
 * 三个 store 各写一遍。
 *
 * 设计要点：
 *   - **不**校验 vault 路径有效性。调用方（vault-context）保证传入的是真实 vault。
 *   - 写入走 `tmp + rename` atomic write，避免 crash 留半文件。
 *   - 读 ENOENT 时返回 null，由调用方走 defaults 逻辑。
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { AppError } from "@shared/errors";
import { atomicWriteFile } from "./atomic-write";

/** 存放 vault 级配置的子目录名。默认隐藏，对应 obsidian 的 `.obsidian/`。 */
export const VAULT_CONFIG_DIR = ".stela";

export function vaultConfigDir(vaultPath: string): string {
  return path.join(vaultPath, VAULT_CONFIG_DIR);
}

export function vaultFilePath(vaultPath: string, fileName: string): string {
  return path.join(vaultConfigDir(vaultPath), fileName);
}

/**
 * 读 `{vault}/.stela/<fileName>`；不存在返回 null。
 * 解析失败抛 AppError。
 */
export async function readVaultJson<T = unknown>(
  vaultPath: string,
  fileName: string,
): Promise<T | null> {
  const fp = vaultFilePath(vaultPath, fileName);
  let buf: string;
  try {
    buf = await fs.readFile(fp, "utf-8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return null;
    throw new AppError("vault_read_failed", `read ${fileName} failed: ${e.message}`);
  }
  try {
    return JSON.parse(buf) as T;
  } catch (err) {
    throw new AppError(
      "vault_parse_failed",
      `parse ${fileName} failed: ${(err as Error).message}`,
    );
  }
}

/** 原子写 `{vault}/.stela/<fileName>`。会创建 `.stela/` 目录（如缺）。 */
export async function writeVaultJson(
  vaultPath: string,
  fileName: string,
  data: unknown,
): Promise<void> {
  const fp = path.join(vaultConfigDir(vaultPath), fileName);
  await atomicWriteFile(fp, JSON.stringify(data, null, 2));
}

/** 仅创建 `.stela/` 目录（已存在则 no-op）。用于一次性 seed 流程。 */
export async function ensureVaultConfigDir(vaultPath: string): Promise<void> {
  await fs.mkdir(vaultConfigDir(vaultPath), { recursive: true });
}
