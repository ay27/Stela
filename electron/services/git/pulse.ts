/**
 * Pulse：vault 级提交活动流（移植自 tolaria `git/pulse.rs`）。
 *
 * 用 `git log --name-status` 一次拿到提交 + 改动文件清单，供 PulseView 展示
 * "什么时候改了哪些笔记 / 历史"。
 */

import type { GitPulseCommit, GitPulseFile } from "@shared/types";
import { git } from "./command";

const PULSE_FORMAT = "\u0001%H%x00%h%x00%an%x00%at%x00%s";

function mapStatus(code: string): GitPulseFile["status"] {
  const c = code[0] ?? "M";
  if (c === "A") return "added";
  if (c === "D") return "deleted";
  if (c === "R") return "renamed";
  return "modified";
}

/** 最近的提交活动流（含每条 commit 的文件改动）。 */
export async function vaultPulse(
  vaultPath: string,
  limit = 50,
  skip = 0,
): Promise<GitPulseCommit[]> {
  const r = await git(
    [
      "log",
      `--max-count=${limit}`,
      `--skip=${skip}`,
      "--name-status",
      `--format=${PULSE_FORMAT}`,
    ],
    { cwd: vaultPath, okExitCodes: [128] },
  ).catch(() => null);
  if (!r) return [];

  const commits: GitPulseCommit[] = [];
  let current: GitPulseCommit | null = null;
  for (const rawLine of r.stdout.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith("\u0001")) {
      const parts = line.slice(1).split("\u0000");
      if (parts.length < 5) continue;
      current = {
        hash: parts[0]!,
        shortHash: parts[1]!,
        author: parts[2]!,
        date: (Number.parseInt(parts[3]!, 10) || 0) * 1000,
        message: parts.slice(4).join("\u0000"),
        files: [],
      };
      commits.push(current);
      continue;
    }
    if (!line.trim() || !current) continue;
    // name-status 行：`M\tpath` 或 `R100\told\tnew`。
    const cols = line.split("\t");
    if (cols.length < 2) continue;
    const status = mapStatus(cols[0]!);
    const p = cols[cols.length - 1]!;
    current.files.push({ path: p, status });
  }
  return commits;
}

/** 最近一条提交摘要（状态栏 "last synced" 用）。 */
export async function lastCommit(
  vaultPath: string,
): Promise<GitPulseCommit | null> {
  const commits = await vaultPulse(vaultPath, 1, 0);
  return commits[0] ?? null;
}
