/**
 * 远端同步（移植自 tolaria `git/remote.rs` + `git/connect.rs`）。
 *
 * - pull 采用 merge（`--no-rebase`），冲突时不抛错，返回 conflicted=true 让 UI
 *   进入冲突解决流程。
 * - push 被拒绝（non-fast-forward）时返回 pullRequired=true 而非抛错。
 * - 凭据完全委托系统 git（SSH agent / GCM / Keychain）；不在应用内存 token。
 */

import type {
  GitAddRemoteResult,
  GitPushResult,
  GitPullResult,
  GitRemoteStatus,
} from "@shared/types";
import { git, gitOut } from "./command";
import { conflictMode } from "./conflict";
import { currentBranch } from "./author";

/** 是否配置了 origin 远端。 */
export async function hasRemote(vaultPath: string): Promise<boolean> {
  const out = await gitOut(["remote"], { cwd: vaultPath, okExitCodes: [128] });
  return out.split("\n").some((l) => l.trim() === "origin");
}

/** 远端连接状态：branch / ahead / behind / url。 */
export async function remoteStatus(
  vaultPath: string,
): Promise<GitRemoteStatus> {
  const branch = await currentBranch(vaultPath);
  const has = await hasRemote(vaultPath);
  if (!has) {
    return { hasRemote: false, branch, ahead: 0, behind: 0, remoteUrl: null };
  }
  const remoteUrl =
    (await gitOut(["remote", "get-url", "origin"], {
      cwd: vaultPath,
      okExitCodes: [1, 2, 128],
    })) || null;

  // 先 fetch 让 ahead/behind 反映最新远端（失败不致命，离线时跳过）。
  await git(["fetch", "origin"], { cwd: vaultPath, okExitCodes: [1, 128] }).catch(
    () => undefined,
  );

  let ahead = 0;
  let behind = 0;
  if (branch) {
    const counts = await gitOut(
      ["rev-list", "--left-right", "--count", `origin/${branch}...HEAD`],
      { cwd: vaultPath, okExitCodes: [128] },
    ).catch(() => "");
    const m = counts.split(/\s+/);
    if (m.length >= 2) {
      behind = Number.parseInt(m[0]!, 10) || 0;
      ahead = Number.parseInt(m[1]!, 10) || 0;
    }
  }
  return { hasRemote: true, branch, ahead, behind, remoteUrl };
}

/** merge pull。冲突时返回 conflicted=true（不抛错）。 */
export async function pull(vaultPath: string): Promise<GitPullResult> {
  const before = await gitOut(["rev-parse", "HEAD"], {
    cwd: vaultPath,
    okExitCodes: [128],
  }).catch(() => "");

  const r = await git(["pull", "--no-rebase", "origin"], {
    cwd: vaultPath,
    okExitCodes: [1, 128],
  });
  const text = `${r.stdout}\n${r.stderr}`.toLowerCase();

  if (r.code !== 0) {
    const mode = await conflictMode(vaultPath);
    if (
      mode !== "none" ||
      text.includes("conflict") ||
      text.includes("fix conflicts")
    ) {
      return {
        ok: false,
        updated: false,
        conflicted: true,
        conflictMode: mode,
        message: (r.stderr || r.stdout).trim(),
      };
    }
    return {
      ok: false,
      updated: false,
      conflicted: false,
      conflictMode: "none",
      message: (r.stderr || r.stdout).trim() || "pull failed",
    };
  }

  const after = await gitOut(["rev-parse", "HEAD"], {
    cwd: vaultPath,
    okExitCodes: [128],
  }).catch(() => "");
  return {
    ok: true,
    updated: before !== after,
    conflicted: false,
    conflictMode: "none",
    message: r.stdout.trim() || "Already up to date.",
  };
}

/** push 到 origin 当前分支。non-fast-forward 拒绝时返回 pullRequired=true。 */
export async function push(vaultPath: string): Promise<GitPushResult> {
  const branch = await currentBranch(vaultPath);
  const args = branch
    ? ["push", "-u", "origin", branch]
    : ["push", "origin"];
  const r = await git(args, { cwd: vaultPath, okExitCodes: [1, 128] });
  if (r.code !== 0) {
    const text = `${r.stdout}\n${r.stderr}`.toLowerCase();
    const pullRequired =
      text.includes("non-fast-forward") ||
      text.includes("fetch first") ||
      text.includes("rejected");
    return {
      ok: false,
      pullRequired,
      message: (r.stderr || r.stdout).trim() || "push failed",
    };
  }
  return { ok: true, pullRequired: false, message: r.stdout.trim() || "pushed" };
}

/**
 * 添加 origin 远端：set origin → fetch → 设 upstream。
 * 远端非空（已有提交）时 remoteHasHistory=true，UI 提示用户先 pull / 合并。
 */
export async function addRemote(
  vaultPath: string,
  remoteUrl: string,
): Promise<GitAddRemoteResult> {
  const url = remoteUrl.trim();
  if (!url) {
    return { ok: false, remoteHasHistory: false, message: "empty remote url" };
  }
  // 已存在 origin → 更新 URL；否则 add。
  if (await hasRemote(vaultPath)) {
    await git(["remote", "set-url", "origin", url], { cwd: vaultPath });
  } else {
    await git(["remote", "add", "origin", url], { cwd: vaultPath });
  }
  const fetched = await git(["fetch", "origin"], {
    cwd: vaultPath,
    okExitCodes: [1, 128],
  });
  let remoteHasHistory = false;
  if (fetched.code === 0) {
    const refs = await gitOut(["branch", "-r"], {
      cwd: vaultPath,
      okExitCodes: [128],
    }).catch(() => "");
    remoteHasHistory = refs.trim().length > 0;
  }
  const branch = await currentBranch(vaultPath);
  if (branch && remoteHasHistory) {
    // 若远端有同名分支，设 upstream（失败不致命）。
    await git(
      ["branch", `--set-upstream-to=origin/${branch}`, branch],
      { cwd: vaultPath, okExitCodes: [1, 128] },
    ).catch(() => undefined);
  }
  return {
    ok: fetched.code === 0,
    remoteHasHistory,
    message:
      fetched.code === 0
        ? "remote connected"
        : (fetched.stderr || fetched.stdout).trim() || "fetch failed",
  };
}
