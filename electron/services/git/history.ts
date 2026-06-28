/**
 * 文件历史与 diff（移植自 tolaria `git/history.rs`）。
 */

import { AppError } from "@shared/errors";
import type { GitCommit } from "@shared/types";
import { git, gitOut } from "./command";

/** 用 NUL 分隔的 log 格式：hash\0short\0author\0unixSeconds\0subject。 */
const LOG_FORMAT = "%H%x00%h%x00%an%x00%at%x00%s";

function parseCommits(out: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\u0000");
    if (parts.length < 5) continue;
    commits.push({
      hash: parts[0]!,
      shortHash: parts[1]!,
      author: parts[2]!,
      date: (Number.parseInt(parts[3]!, 10) || 0) * 1000,
      message: parts.slice(4).join("\u0000"),
    });
  }
  return commits;
}

/** 单个文件最近 N 条提交历史。 */
export async function fileHistory(
  vaultPath: string,
  relPath: string,
  limit = 20,
): Promise<GitCommit[]> {
  if (relPath.includes("..")) {
    throw new AppError("invalid_path", `relPath contains '..': ${relPath}`);
  }
  const out = await gitOut(
    [
      "log",
      `--max-count=${limit}`,
      `--format=${LOG_FORMAT}`,
      "--",
      relPath,
    ],
    { cwd: vaultPath, okExitCodes: [128] },
  ).catch(() => "");
  return parseCommits(out);
}

/** 单个文件当前未提交 diff（工作区 + staged 合并视角，对 HEAD）。 */
export async function fileDiff(
  vaultPath: string,
  relPath: string,
): Promise<string> {
  if (relPath.includes("..")) {
    throw new AppError("invalid_path", `relPath contains '..': ${relPath}`);
  }
  // HEAD vs 工作区。新文件（untracked）无 HEAD 版本，用 --no-index 兜底。
  const tracked = await git(["ls-files", "--error-unmatch", "--", relPath], {
    cwd: vaultPath,
    okExitCodes: [1],
  });
  if (tracked.code !== 0) {
    const r = await git(
      ["diff", "--no-index", "--", "/dev/null", relPath],
      { cwd: vaultPath, okExitCodes: [1] },
    ).catch(() => null);
    return r?.stdout ?? "";
  }
  const r = await git(["diff", "HEAD", "--", relPath], {
    cwd: vaultPath,
    okExitCodes: [1, 128],
  });
  return r.stdout;
}

/** 某个文件在指定 commit 引入的 diff。 */
export async function fileDiffAtCommit(
  vaultPath: string,
  relPath: string,
  commitHash: string,
): Promise<string> {
  if (relPath.includes("..")) {
    throw new AppError("invalid_path", `relPath contains '..': ${relPath}`);
  }
  if (!/^[0-9a-fA-F]{4,64}$/.test(commitHash)) {
    throw new AppError("invalid_arg", `invalid commit hash: ${commitHash}`);
  }
  const r = await git(
    ["show", commitHash, "--format=", "--", relPath],
    { cwd: vaultPath, okExitCodes: [1, 128] },
  );
  return r.stdout;
}
