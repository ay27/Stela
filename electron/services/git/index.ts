/**
 * Git 服务聚合入口。
 *
 * 把分散在 init / status / commit / remote / conflict / history / pulse / clone
 * 的能力收敛成一个 namespace，供 main 端 handlers 调用，并提供一个
 * `vaultStatus()` 聚合查询给状态栏一次性拉取。
 */

import type { GitVaultStatus } from "@shared/types";

import { isRepo, initRepo, ensureGitignore } from "./init";
import { authorIdentity, setAuthorIdentity, currentBranch } from "./author";
import { getModifiedFiles, discardFile } from "./status";
import { commit } from "./commit";
import { pull, push, remoteStatus, addRemote, hasRemote } from "./remote";
import {
  conflictFiles,
  conflictMode,
  resolveConflict,
  commitConflictResolution,
} from "./conflict";
import { fileHistory, fileDiff, fileDiffAtCommit } from "./history";
import { vaultPulse, lastCommit } from "./pulse";
import { clone } from "./clone";

export {
  isRepo,
  initRepo,
  ensureGitignore,
  authorIdentity,
  setAuthorIdentity,
  currentBranch,
  getModifiedFiles,
  discardFile,
  commit,
  pull,
  push,
  remoteStatus,
  addRemote,
  hasRemote,
  conflictFiles,
  conflictMode,
  resolveConflict,
  commitConflictResolution,
  fileHistory,
  fileDiff,
  fileDiffAtCommit,
  vaultPulse,
  lastCommit,
  clone,
};

/**
 * 一次性聚合 vault 的 Git 概览，状态栏轮询用。非 repo 时返回 isRepo=false，
 * 其它字段取默认值。任何子查询失败不抛错（状态栏要稳）。
 */
export async function vaultStatus(vaultPath: string): Promise<GitVaultStatus> {
  const repo = await isRepo(vaultPath).catch(() => false);
  if (!repo) {
    return {
      isRepo: false,
      branch: null,
      hasRemote: false,
      ahead: 0,
      behind: 0,
      changedCount: 0,
      conflictCount: 0,
      conflictMode: "none",
    };
  }
  const [branch, remote, files, conflicts, mode] = await Promise.all([
    currentBranch(vaultPath).catch(() => null),
    remoteStatus(vaultPath).catch(() => ({
      hasRemote: false,
      branch: null,
      ahead: 0,
      behind: 0,
      remoteUrl: null,
    })),
    getModifiedFiles(vaultPath, false).catch(() => []),
    conflictFiles(vaultPath).catch(() => []),
    conflictMode(vaultPath).catch(() => "none" as const),
  ]);
  const changedCount = files.filter((f) => f.status !== "conflict").length;
  return {
    isRepo: true,
    branch: branch ?? remote.branch,
    hasRemote: remote.hasRemote,
    ahead: remote.ahead,
    behind: remote.behind,
    changedCount,
    conflictCount: conflicts.length,
    conflictMode: mode,
  };
}
