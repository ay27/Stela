/**
 * 统一同步编排（替代旧 COS sync-service）。
 *
 * 把"笔记 + Git 共享的 .stela 域"收敛成一个串行事务：
 *   checkpoint → fetch → fast-forward/rebase → domain refresh → push。
 * legacy syncPush / syncPull 仅是兼容入口，也委托给同一事务。
 *
 * 凭据全委托系统 git；无对象存储 / 无密钥落盘。
 */

import type {
  GitSyncChangedDomain,
  GitSyncPullResult,
  GitSyncPushResult,
  GitSyncRequest,
  GitSyncResult,
} from "@shared/types";

import { getLogger } from "./logger";
import * as git from "./git";
import * as journal from "./history-journal";
import * as settingsStore from "./settings-store";
import * as vaultIndex from "./vault-index";

const log = getLogger("sync");

const NOTE_EXTS = [".md"];
const syncTails = new Map<string, Promise<void>>();

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
 * App 退出前的最后一次 checkpoint：仅 commit，不 push（避免 credential
 * prompt 卡住退出）。尊重 git.enabled + autoCommit；无 vault / 未开自动
 * 提交时 no-op。
 */
export async function flushAutoCommitOnQuit(vaultPath: string): Promise<void> {
  const settings = await settingsStore.loadAppSettings(vaultPath);
  if (!settings.git.enabled || !settings.git.autoCommit) {
    log.info("quit flush skipped", { enabled: settings.git.enabled, autoCommit: settings.git.autoCommit });
    return;
  }
  log.info("quit flush commit start");
  await syncPush(vaultPath, undefined, { push: false });
  log.info("quit flush commit done");
}

export function classifyChangedDomains(paths: string[]): GitSyncChangedDomain[] {
  const domains = new Set<GitSyncChangedDomain>();
  for (const rawPath of paths) {
    const relPath = rawPath.replaceAll("\\", "/").replace(/^\.\//, "");
    if (relPath === ".stela/settings.json") domains.add("settings");
    else if (relPath === ".stela/connections.json") domains.add("connections");
    else if (relPath.startsWith(".stela/history/")) domains.add("history");
    else if (relPath.startsWith(".stela/agent-history/")) domains.add("agent-history");
    else if (relPath.startsWith(".stela/skills/")) domains.add("skills");
    else if (relPath.startsWith(".stela/sql-templates/")) domains.add("templates");
    else if (relPath.endsWith(".md") || relPath.endsWith(".stela.canvas") || relPath.endsWith(".stela.chat")) domains.add("vault-files");
  }
  return [...domains];
}

async function withVaultSyncLock<T>(vaultPath: string, task: () => Promise<T>): Promise<T> {
  const previous = syncTails.get(vaultPath) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const tail = run.then(() => undefined, () => undefined);
  syncTails.set(vaultPath, tail);
  try {
    return await run;
  } finally {
    if (syncTails.get(vaultPath) === tail) syncTails.delete(vaultPath);
  }
}

function emptySyncResult(message: string): GitSyncResult {
  return {
    committed: false,
    commitHash: null,
    integrated: false,
    pushed: false,
    conflicted: false,
    conflictMode: "none",
    importedRuns: 0,
    changedDomains: [],
    blockedReason: null,
    message,
  };
}

async function refreshIntegratedData(
  vaultPath: string,
  changedPaths: string[],
): Promise<{ importedRuns: number; changedDomains: GitSyncChangedDomain[] }> {
  const changedDomains = classifyChangedDomains(changedPaths);
  let importedRuns = 0;
  if (changedDomains.includes("history")) {
    try {
      importedRuns = (await journal.importIncremental(vaultPath)).imported;
    } catch (err) {
      log.error("post-sync journal import failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (changedDomains.includes("vault-files")) {
    await vaultIndex.start(vaultPath).catch((err: unknown) => {
      log.error("post-sync reindex failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }
  return { importedRuns, changedDomains };
}

/**
 * One serialized Git synchronization transaction for a Vault. Callers choose
 * capabilities; push always follows integration (also enforced by IPC schema).
 */
export async function syncNow(
  vaultPath: string,
  request: GitSyncRequest,
): Promise<GitSyncResult> {
  return withVaultSyncLock(vaultPath, async () => {
    const result = emptySyncResult("nothing to sync");
    if (!(await git.isRepo(vaultPath))) return { ...result, message: "not a git repo" };
    const existingConflictMode = await git.conflictMode(vaultPath);
    if (existingConflictMode !== "none") {
      return {
        ...result,
        conflicted: true,
        conflictMode: existingConflictMode,
        blockedReason: "conflict",
        message: "resolve the existing Git conflict before syncing",
      };
    }

    if (!request.commit && request.integrate) {
      const localChanges = await git.getModifiedFiles(vaultPath, false);
      if (localChanges.length > 0) {
        return {
          ...result,
          blockedReason: "local-changes",
          message: "local changes block inbound sync until they are checkpointed",
        };
      }
    }

    if (request.commit) {
      try {
        result.commitHash = await git.commit(
          vaultPath,
          request.message?.trim() || (await autoMessage(vaultPath)),
        );
        result.committed = true;
      } catch (err) {
        if ((err as { code?: string }).code !== "git_nothing_to_commit") throw err;
      }
    }

    const hasRemote = await git.hasRemote(vaultPath);
    if (!hasRemote || (!request.integrate && !request.push)) {
      return {
        ...result,
        message: result.committed
          ? hasRemote ? "checkpoint committed" : "checkpoint committed (no remote)"
          : hasRemote ? "nothing to commit" : "nothing to commit (no remote)",
      };
    }

    const changedPaths = new Set<string>();
    const refreshPendingData = async (): Promise<void> => {
      if (changedPaths.size === 0) return;
      const refreshed = await refreshIntegratedData(vaultPath, [...changedPaths]);
      changedPaths.clear();
      result.importedRuns += refreshed.importedRuns;
      result.changedDomains = [
        ...new Set([...result.changedDomains, ...refreshed.changedDomains]),
      ];
    };
    if (request.integrate) {
      const integration = await git.integrateOrigin(vaultPath);
      for (const changedPath of integration.changedPaths) changedPaths.add(changedPath);
      if (integration.conflicted) {
        return {
          ...result,
          conflicted: true,
          conflictMode: integration.conflictMode,
          blockedReason: "conflict",
          message: integration.message,
        };
      }
      if (!integration.ok) {
        return { ...result, blockedReason: "offline", message: integration.message };
      }
      result.integrated = integration.updated;
      await refreshPendingData();
    }

    if (request.push) {
      let pushed = await git.push(vaultPath);
      if (!pushed.ok && pushed.pullRequired) {
        const retryIntegration = await git.integrateOrigin(vaultPath);
        for (const changedPath of retryIntegration.changedPaths) changedPaths.add(changedPath);
        if (retryIntegration.conflicted) {
          return {
            ...result,
            conflicted: true,
            conflictMode: retryIntegration.conflictMode,
            blockedReason: "conflict",
            message: retryIntegration.message,
          };
        }
        if (!retryIntegration.ok) {
          return { ...result, blockedReason: "offline", message: retryIntegration.message };
        }
        result.integrated ||= retryIntegration.updated;
        await refreshPendingData();
        pushed = await git.push(vaultPath);
      }
      if (!pushed.ok) return { ...result, blockedReason: "offline", message: pushed.message };
      result.pushed = true;
    }

    await refreshPendingData();
    result.message = result.pushed
      ? "synchronized"
      : result.integrated
        ? "remote changes integrated"
        : result.committed
          ? "checkpoint committed"
          : "Already up to date.";
    log.info("git sync transaction completed", {
      trigger: request.trigger,
      committed: result.committed,
      integrated: result.integrated,
      pushed: result.pushed,
      changedDomains: result.changedDomains,
    });
    return result;
  });
}

/**
 * 推送：提交全部变更（含 JSONL）→ 若配置了 remote 则 push。
 * 无变更可提交时 committed=false（非错误）。
 */
export async function syncPush(
  vaultPath: string,
  message?: string,
  options?: { push?: boolean },
): Promise<GitSyncPushResult> {
  const shouldPush = options?.push !== false;
  const synced = await syncNow(vaultPath, {
    trigger: "manual",
    commit: true,
    integrate: shouldPush,
    push: shouldPush,
    ...(message?.trim() ? { message: message.trim() } : {}),
  });
  return {
    committed: synced.committed,
    commitHash: synced.commitHash,
    pushed: synced.pushed,
    pullRequired: false,
    message: synced.message,
  };
}

/**
 * 拉取：git pull → 增量导入 JSONL → 重扫 index。冲突时 conflicted=true，
 * 调用方（renderer hook）据此打开冲突解决流程。
 */
export async function syncPull(vaultPath: string): Promise<GitSyncPullResult> {
  const synced = await syncNow(vaultPath, {
    trigger: "manual",
    commit: false,
    integrate: true,
    push: false,
  });
  return {
    pulled: synced.blockedReason === null,
    updated: synced.integrated,
    conflicted: synced.conflicted,
    conflictMode: synced.conflictMode,
    imported: synced.importedRuns,
    message: synced.message,
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
    const deviceProfile = await import("./device-profile");
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
