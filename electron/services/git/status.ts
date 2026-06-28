/**
 * 工作区状态与变更（移植自 tolaria `git/status.rs`）。
 *
 * 基于 `git status --porcelain=v1 -z`，把双字符 XY 状态归一化为 UI 友好枚举。
 * discard 走 `checkout -- <file>`（已跟踪）或删除（untracked）。
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { AppError } from "@shared/errors";
import type { GitModifiedFile } from "@shared/types";
import { git, gitOut } from "./command";

/** 解析 porcelain XY 双字符为归一化状态。 */
function classify(xy: string): GitModifiedFile["status"] {
  if (xy === "??") return "untracked";
  const x = xy[0] ?? " ";
  const y = xy[1] ?? " ";
  // 冲突：两侧任一为 U，或 AA / DD 等 unmerged 组合。
  if (x === "U" || y === "U" || xy === "AA" || xy === "DD") return "conflict";
  if (x === "R" || y === "R") return "renamed";
  if (x === "A" || y === "A") return "added";
  if (x === "D" || y === "D") return "deleted";
  return "modified";
}

/**
 * 列出工作区变更文件。`-z` 用 NUL 分隔，避免文件名含空格 / 换行时解析错位。
 * renamed 条目格式为 `R  old\0new`，这里取 new path。
 */
export async function getModifiedFiles(
  vaultPath: string,
  includeStats = false,
): Promise<GitModifiedFile[]> {
  const r = await git(["status", "--porcelain=v1", "-z"], {
    cwd: vaultPath,
  });
  const tokens = r.stdout.split("\0").filter((t) => t.length > 0);
  const files: GitModifiedFile[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    // 每条记录形如 `XY <path>`；XY 占前两位，第三位是空格。
    const xy = token.slice(0, 2);
    let p = token.slice(3);
    const status = classify(xy);
    if (status === "renamed") {
      // rename 的目标路径在下一个 NUL 段。
      const next = tokens[i + 1];
      if (next !== undefined) {
        p = next;
        i += 1;
      }
    }
    files.push({ path: p, status });
  }

  if (includeStats) {
    await attachStats(vaultPath, files);
  }
  return files;
}

/** 用 `git diff --numstat` 给已跟踪文件补行级增删统计。 */
async function attachStats(
  vaultPath: string,
  files: GitModifiedFile[],
): Promise<void> {
  const out = await gitOut(["diff", "--numstat", "HEAD"], {
    cwd: vaultPath,
    okExitCodes: [128],
  }).catch(() => "");
  if (!out) return;
  const byPath = new Map<string, { add: number; del: number }>();
  for (const line of out.split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const add = Number.parseInt(parts[0]!, 10);
    const del = Number.parseInt(parts[1]!, 10);
    byPath.set(parts[2]!, {
      add: Number.isFinite(add) ? add : 0,
      del: Number.isFinite(del) ? del : 0,
    });
  }
  for (const f of files) {
    const s = byPath.get(f.path);
    if (s) {
      f.additions = s.add;
      f.deletions = s.del;
    }
  }
}

/**
 * 丢弃单个文件的工作区改动。
 *   - 已跟踪（modified / deleted）：`git checkout -- <file>` 还原到 HEAD。
 *   - 未跟踪（untracked / added 但未 commit）：直接从磁盘删除。
 */
export async function discardFile(
  vaultPath: string,
  relPath: string,
): Promise<void> {
  if (relPath.includes("..")) {
    throw new AppError("invalid_path", `relPath contains '..': ${relPath}`);
  }
  // 先判断是否被 git 跟踪。
  const tracked = await git(["ls-files", "--error-unmatch", "--", relPath], {
    cwd: vaultPath,
    okExitCodes: [1],
  });
  if (tracked.code === 0) {
    await git(["checkout", "HEAD", "--", relPath], { cwd: vaultPath });
    return;
  }
  // 未跟踪：删除磁盘文件。
  await fs.rm(path.join(vaultPath, relPath), { force: true });
}
