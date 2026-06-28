/**
 * 统一同步编排（替代旧 COS sync-service）。
 *
 * 把"笔记 + 执行历史 JSONL"收敛成一对用户操作：
 *   - syncPush：`git add -A` + commit（含 JSONL）→ 可选 push
 *   - syncPull：`git pull` → journal 增量导入 → 重扫 vault index
 *
 * 凭据全委托系统 git；无对象存储 / 无密钥落盘。
 */

import type { GitSyncPullResult, GitSyncPushResult } from "@shared/types";

import { getLogger } from "./logger";
import * as deviceProfile from "./device-profile";
import * as git from "./git";
import * as journal from "./history-journal";
import * as vaultIndex from "./vault-index";

const log = getLogger("sync");

const NOTE_EXTS = [".md"];

function isNote(p: string): boolean {
  return NOTE_EXTS.some((ext) => p.toLowerCase().endsWith(ext));
}

/** 时间戳兜底信息（拿不到变更列表时用）。 */
function timestampMessage(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `Stela checkpoint ${stamp}`;
}

/**
 * 自动 commit 信息（借鉴 tolaria generateAutomaticCommitMessage）：按变更文件数
 * 生成 `Updated N notes` / `Updated N files`，比固定时间戳信息量更大。全是
 * 笔记用 note(s)，否则用 file(s)。拿不到变更列表 / 无变更时退回时间戳。
 */
async function autoMessage(vaultPath: string): Promise<string> {
  try {
    const files = await git.getModifiedFiles(vaultPath, false);
    const changed = files.filter((f) => f.status !== "conflict");
    if (changed.length > 0) {
      const allNotes = changed.every((f) => isNote(f.path));
      const noun = allNotes
        ? changed.length === 1
          ? "note"
          : "notes"
        : changed.length === 1
          ? "file"
          : "files";
      return `Updated ${changed.length} ${noun}`;
    }
  } catch {
    // fall through to timestamp
  }
  return timestampMessage();
}

/**
 * 推送：提交全部变更（含 JSONL）→ 若配置了 remote 则 push。
 * 无变更可提交时 committed=false（非错误）。
 */
export async function syncPush(
  vaultPath: string,
  message?: string,
): Promise<GitSyncPushResult> {
  if (!(await git.isRepo(vaultPath))) {
    return {
      committed: false,
      commitHash: null,
      pushed: false,
      pullRequired: false,
      message: "not a git repo",
    };
  }
  let commitHash: string | null = null;
  let committed = false;
  try {
    const msg = message?.trim() || (await autoMessage(vaultPath));
    commitHash = await git.commit(vaultPath, msg);
    committed = true;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "git_nothing_to_commit") {
      committed = false;
    } else {
      throw err;
    }
  }

  if (!(await git.hasRemote(vaultPath))) {
    return {
      committed,
      commitHash,
      pushed: false,
      pullRequired: false,
      message: committed ? "committed (no remote)" : "nothing to commit",
    };
  }
  const pushed = await git.push(vaultPath);
  return {
    committed,
    commitHash,
    pushed: pushed.ok,
    pullRequired: pushed.pullRequired,
    message: pushed.message,
  };
}

/**
 * 拉取：git pull → 增量导入 JSONL → 重扫 index。冲突时 conflicted=true，
 * 调用方（renderer hook）据此打开冲突解决流程。
 */
export async function syncPull(vaultPath: string): Promise<GitSyncPullResult> {
  if (!(await git.isRepo(vaultPath)) || !(await git.hasRemote(vaultPath))) {
    return {
      pulled: false,
      updated: false,
      conflicted: false,
      conflictMode: "none",
      imported: 0,
      message: "no remote configured",
    };
  }
  const pull = await git.pull(vaultPath);
  if (pull.conflicted) {
    return {
      pulled: false,
      updated: false,
      conflicted: true,
      conflictMode: pull.conflictMode,
      imported: 0,
      message: pull.message,
    };
  }
  let imported = 0;
  if (pull.ok && pull.updated) {
    try {
      const summary = await journal.importIncremental(vaultPath);
      imported = summary.imported;
    } catch (err) {
      log.error("post-pull journal import failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
    // 重扫 vault index（broadcast INDEX_CHANGED 让 renderer 失效缓存）。
    await vaultIndex.start(vaultPath).catch((err: unknown) => {
      log.error("post-pull reindex failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }
  return {
    pulled: pull.ok,
    updated: pull.updated,
    conflicted: false,
    conflictMode: "none",
    imported,
    message: pull.message,
  };
}

/**
 * vault 打开时调用：增量导入 JSONL 到缓存（后台，不阻塞 UI），
 * 并按设置可选触发一次 auto-pull（由 caller 决定是否调用 syncPull）。
 */
export async function onVaultOpen(vaultPath: string): Promise<void> {
  try {
    await journal.importIncremental(vaultPath);
  } catch (err) {
    log.error("vault-open journal import failed", {
      vaultPath,
      err: err instanceof Error ? err.message : String(err),
    });
  }
  // 反向保护：把本机 SQLite 里有、但当前设备 JSONL 里没有的 run 一并补到 JSONL。
  // 兜底两类历史场景：
  //   1. v2 启用 JSONL 之前的旧 run（SQLite 里仍存在，但从未进过 JSONL）
  //   2. 历史上某次 appendRunById 被信号 / 崩溃打断（saveRun 成功但 append 没跑完）
  // 走 exportExistingRunsToJournal 自带去重：已经在 JSONL 里的 run 不会重复写入。
  // 注意：两台设备同时打开同一 vault 时不会双写 —— 该函数只读本设备 JSONL 做去重，
  // 写的也只是本设备 slug 文件，slug 隔离保证了写隔离语义不破。
  try {
    const profile = await deviceProfile.loadDeviceProfile();
    const n = await journal.exportExistingRunsToJournal(vaultPath, profile);
    if (n > 0) {
      log.info("vault-open back-fill journal from sqlite", {
        runs: n,
        slug: profile.slug,
      });
    }
  } catch (err) {
    log.error("vault-open journal back-fill failed", {
      vaultPath,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
