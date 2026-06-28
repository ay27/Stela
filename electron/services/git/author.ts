/**
 * 作者身份解析与自愈（移植自 tolaria `git/author.rs`）。
 *
 * 很多用户从未配置全局 `git config user.name/email`。首次提交会失败。
 * 这里在 init / commit 前确保 repo-local 有可用身份：优先沿用 global，缺失时
 * 写入一个明确的 fallback，避免 "Please tell me who you are" 阻断流程。
 */

import { git, gitOut } from "./command";
import type { GitAuthorIdentity } from "@shared/types";

const FALLBACK_NAME = "Stela User";
const FALLBACK_EMAIL = "stela@localhost";

async function localOrGlobal(
  vaultPath: string,
  key: string,
): Promise<string | null> {
  // 先查 effective config（含 local + global），命中即用。
  const r = await git(["config", key], {
    cwd: vaultPath,
    okExitCodes: [1],
  });
  const v = r.stdout.trim();
  return v.length > 0 ? v : null;
}

/** 确保 repo 有可用的 user.name / user.email；缺失时写 repo-local fallback。 */
export async function ensureAuthorConfig(vaultPath: string): Promise<void> {
  const name = await localOrGlobal(vaultPath, "user.name");
  if (!name) {
    await git(["config", "user.name", FALLBACK_NAME], { cwd: vaultPath });
  }
  const email = await localOrGlobal(vaultPath, "user.email");
  if (!email) {
    await git(["config", "user.email", FALLBACK_EMAIL], { cwd: vaultPath });
  }
}

/** 读取当前生效的作者身份（供 Settings 展示）。 */
export async function authorIdentity(
  vaultPath: string,
): Promise<GitAuthorIdentity> {
  const name =
    (await localOrGlobal(vaultPath, "user.name")) ?? FALLBACK_NAME;
  const email =
    (await localOrGlobal(vaultPath, "user.email")) ?? FALLBACK_EMAIL;
  return { name, email };
}

/** 写入 repo-local 作者身份（Settings 编辑作者用）。 */
export async function setAuthorIdentity(
  vaultPath: string,
  identity: GitAuthorIdentity,
): Promise<void> {
  await git(["config", "user.name", identity.name], { cwd: vaultPath });
  await git(["config", "user.email", identity.email], { cwd: vaultPath });
}

/** 当前分支名；detached / 空仓库返回 null。 */
export async function currentBranch(
  vaultPath: string,
): Promise<string | null> {
  try {
    const out = await gitOut(["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: vaultPath,
      okExitCodes: [128],
    });
    if (!out || out === "HEAD") return null;
    return out;
  } catch {
    return null;
  }
}
