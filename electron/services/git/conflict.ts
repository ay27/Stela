/**
 * 冲突检测与解决（移植自 tolaria `git/conflict.rs`）。
 *
 * 支持 merge 与 rebase 两种冲突态：
 *   - 列出 unmerged 文件（`ls-files --unmerged`）
 *   - 逐文件采用 ours / theirs（`checkout --ours/--theirs` + `add`）
 *   - 全部解决后 `rebase --continue` 或生成 merge commit
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { AppError } from "@shared/errors";
import type { GitConflictMode, GitConflictStrategy } from "@shared/types";
import { git, gitOut, splitLines } from "./command";

/** 当前是否处于冲突态以及模式。 */
export async function conflictMode(
  vaultPath: string,
): Promise<GitConflictMode> {
  const gitDir = await gitOut(["rev-parse", "--git-dir"], {
    cwd: vaultPath,
    okExitCodes: [128],
  }).catch(() => "");
  if (!gitDir) return "none";
  const base = path.isAbsolute(gitDir) ? gitDir : path.join(vaultPath, gitDir);
  const exists = async (p: string): Promise<boolean> => {
    try {
      await fs.access(path.join(base, p));
      return true;
    } catch {
      return false;
    }
  };
  if ((await exists("rebase-merge")) || (await exists("rebase-apply"))) {
    return "rebase";
  }
  if (await exists("MERGE_HEAD")) return "merge";
  // 没有进行中的 merge/rebase，但若有 unmerged 文件仍算 merge 冲突态。
  const files = await conflictFiles(vaultPath);
  return files.length > 0 ? "merge" : "none";
}

/** 列出处于冲突（unmerged）的文件相对路径。 */
export async function conflictFiles(vaultPath: string): Promise<string[]> {
  const out = await gitOut(["diff", "--name-only", "--diff-filter=U"], {
    cwd: vaultPath,
    okExitCodes: [128],
  }).catch(() => "");
  return splitLines(out);
}

/** 用 ours / theirs 解决单个冲突文件并 stage。 */
export async function resolveConflict(
  vaultPath: string,
  file: string,
  strategy: GitConflictStrategy,
): Promise<void> {
  if (file.includes("..")) {
    throw new AppError("invalid_path", `file contains '..': ${file}`);
  }
  const flag = strategy === "ours" ? "--ours" : "--theirs";
  await git(["checkout", flag, "--", file], { cwd: vaultPath });
  await git(["add", "--", file], { cwd: vaultPath });
}

/**
 * 所有冲突解决后收尾：rebase → `rebase --continue`；merge → 生成 merge commit。
 * 返回结果短哈希（rebase 续跑可能无新 commit 时返回 HEAD）。
 */
export async function commitConflictResolution(
  vaultPath: string,
): Promise<string> {
  const mode = await conflictMode(vaultPath);
  if (mode === "rebase") {
    await git(["-c", "commit.gpgsign=false", "rebase", "--continue"], {
      cwd: vaultPath,
      // rebase 续跑可能因 editor 交互返回非 0；GIT_EDITOR=true 兜底。
      okExitCodes: [1],
    });
  } else {
    // merge：仍有 unmerged 会失败；前置应已全部 add。
    await git(
      ["-c", "commit.gpgsign=false", "commit", "--no-edit"],
      { cwd: vaultPath, okExitCodes: [1] },
    );
  }
  return gitOut(["rev-parse", "--short", "HEAD"], { cwd: vaultPath });
}
