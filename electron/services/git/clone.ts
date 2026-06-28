/**
 * 克隆 vault（移植自 tolaria `git/clone.rs`）。
 *
 * 非交互式（凭据委托系统 git）。失败时清理已创建的目标目录，避免残留半成品。
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { AppError } from "@shared/errors";
import { git } from "./command";

/**
 * 把远端仓库克隆到 localPath。localPath 必须不存在或为空目录。
 * 返回最终的 vault 绝对路径。
 */
export async function clone(
  remoteUrl: string,
  localPath: string,
): Promise<string> {
  const url = remoteUrl.trim();
  if (!url) throw new AppError("invalid_arg", "empty remote url");
  const dest = path.resolve(localPath);

  // 目标已存在且非空 → 拒绝（避免覆盖用户数据）。
  let existed = false;
  try {
    const entries = await fs.readdir(dest);
    existed = true;
    if (entries.length > 0) {
      throw new AppError(
        "git_clone_target_not_empty",
        `target directory not empty: ${dest}`,
      );
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    // ENOENT → 目录不存在，git clone 会创建。
  }

  const parent = path.dirname(dest);
  await fs.mkdir(parent, { recursive: true });

  const r = await git(["clone", url, dest], {
    cwd: parent,
    okExitCodes: [1, 128],
  });
  if (r.code !== 0) {
    // 清理可能残留的目标目录（仅当 clone 自己创建的）。
    if (!existed) {
      await fs.rm(dest, { recursive: true, force: true }).catch(() => {});
    }
    throw new AppError(
      "git_clone_failed",
      (r.stderr || r.stdout).trim() || "clone failed",
    );
  }
  return dest;
}
