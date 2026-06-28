/**
 * 提交（移植自 tolaria `git/commit.rs`）。
 *
 * `git add -A` 暂存全部（含删除），再 commit。若因 GPG signing 失败（无 key /
 * gpg 未装），单次以 `commit.gpgsign=false` 重试，避免阻断本地提交。
 */

import { AppError } from "@shared/errors";
import { getLogger } from "../logger";
import { git, gitOut } from "./command";
import { ensureAuthorConfig } from "./author";

const log = getLogger("git");

/**
 * 提交全部变更，返回新提交的短哈希。
 * 无变更可提交时抛 `git_nothing_to_commit`（UI 可静默忽略）。
 */
export async function commit(
  vaultPath: string,
  message: string,
): Promise<string> {
  const msg = message.trim();
  if (!msg) {
    throw new AppError("git_empty_message", "commit message is empty");
  }
  await ensureAuthorConfig(vaultPath);
  await git(["add", "-A"], { cwd: vaultPath });

  // 无任何暂存变更 → commit 返回 1。归一化为明确错误码。
  const staged = await git(["diff", "--cached", "--quiet"], {
    cwd: vaultPath,
    okExitCodes: [1],
  });
  if (staged.code === 0) {
    throw new AppError("git_nothing_to_commit", "nothing to commit");
  }

  const first = await git(["commit", "-m", msg], {
    cwd: vaultPath,
    okExitCodes: [1],
  });
  if (first.code !== 0) {
    const detail = (first.stderr || first.stdout).toLowerCase();
    if (detail.includes("gpg") || detail.includes("signing")) {
      log.warn("commit gpg sign failed; retrying unsigned", { vaultPath });
      await git(["-c", "commit.gpgsign=false", "commit", "-m", msg], {
        cwd: vaultPath,
      });
    } else {
      throw new AppError("git_failed", first.stderr || first.stdout);
    }
  }
  return gitOut(["rev-parse", "--short", "HEAD"], { cwd: vaultPath });
}
