/**
 * 仓库初始化与 `.gitignore`（移植自 tolaria `git/mod.rs` 的 init_repo / ensure_gitignore）。
 *
 * Stela 与 tolaria 的关键差异：`.stela.sqlite*` 是**本机查询缓存**，永不进 git；
 * 执行历史靠 `.stela/history/history_*.jsonl`（append-only，跨设备 Git 同步）。
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { AppError } from "@shared/errors";
import { getLogger } from "../logger";
import { git } from "./command";
import { ensureAuthorConfig } from "./author";

const log = getLogger("git");

/**
 * Stela 默认 `.gitignore`。
 *
 * - `.stela.sqlite*`：本机查询缓存（可从 JSONL 重建），不同步。
 * - `.stela-knowledge.sqlite`：旧版本地派生产物，保留 ignore 避免老 vault 误提交。
 * - `.stela/connections.json`：**不** ignore —— 拆分后只含非敏感连接配置（无 secret），跨设备同步。
 * - `.stela/secrets/secrets_*.json`：**不** ignore —— 每设备 safeStorage 包裹的 secret 分片；
 *   随 Git 同步，但只有对应设备能解密自己的那份（同 history JSONL 的写隔离思路）。
 * - `.stela/history/`：**不** ignore —— 这是执行历史真相源，靠 Git 同步。
 */
export const DEFAULT_GITIGNORE = `# Stela machine-local cache (never commit)
.stela.sqlite
.stela.sqlite-wal
.stela.sqlite-shm
.stela-knowledge.sqlite

# NOTE: .stela/connections.json (non-secret config) and
# .stela/secrets/secrets_*.json (per-device safeStorage-wrapped secrets) are
# intentionally tracked and synced via Git. Each device can only decrypt its
# own shard; other devices' shards stay opaque but portable.
#
# NOTE: .stela/history/*.jsonl is intentionally tracked — it is the
# cross-device execution-history source of truth, synced via Git.

# macOS / editors
.DS_Store
.AppleDouble
._*
.vscode/
.idea/
*.swp
*.swo
`;

/** vault 是否是 git 仓库（存在 `.git`）。 */
export async function isRepo(vaultPath: string): Promise<boolean> {
  try {
    const r = await git(["rev-parse", "--is-inside-work-tree"], {
      cwd: vaultPath,
      okExitCodes: [128],
    });
    return r.code === 0 && r.stdout.trim() === "true";
  } catch {
    return false;
  }
}

/** 仅当 `.gitignore` 不存在时写入默认规则（保留用户既有文件）。 */
export async function ensureGitignore(vaultPath: string): Promise<void> {
  const fp = path.join(vaultPath, ".gitignore");
  try {
    await fs.access(fp);
    return;
  } catch {
    /* not exists → write default */
  }
  await fs.writeFile(fp, DEFAULT_GITIGNORE, "utf-8");
}

/**
 * 初始化 vault 为 git 仓库：`git init` → 写默认 `.gitignore` → 配置作者 →
 * `git add .` → 首次提交（强制关闭 GPG sign，避免无 key 环境失败）。
 *
 * 安全：拒绝在明显过宽的目录（home / Documents / Desktop）直接 init，防止误把
 * 整个文档目录变成仓库（对齐 tolaria 行为）。
 */
export async function initRepo(vaultPath: string): Promise<void> {
  assertNotOverlyBroadPath(vaultPath);
  if (await isRepo(vaultPath)) {
    log.info("initRepo: already a repo", { vaultPath });
    await ensureGitignore(vaultPath);
    return;
  }
  await git(["init"], { cwd: vaultPath });
  await ensureGitignore(vaultPath);
  await ensureAuthorConfig(vaultPath);
  await git(["add", "."], { cwd: vaultPath });
  await git(
    ["-c", "commit.gpgsign=false", "commit", "-m", "Initial vault setup"],
    { cwd: vaultPath, okExitCodes: [1] },
  );
  log.info("initRepo done", { vaultPath });
}

function assertNotOverlyBroadPath(vaultPath: string): void {
  const resolved = path.resolve(vaultPath);
  const home = path.resolve(
    process.env.HOME ?? process.env.USERPROFILE ?? "",
  );
  if (!home) return;
  const broad = [
    home,
    path.join(home, "Documents"),
    path.join(home, "Desktop"),
    path.join(home, "Downloads"),
  ];
  if (broad.some((b) => path.resolve(b) === resolved)) {
    throw new AppError(
      "git_unsafe_init",
      `Refusing to git-init a broad directory: ${resolved}. Choose a dedicated vault folder.`,
    );
  }
}
