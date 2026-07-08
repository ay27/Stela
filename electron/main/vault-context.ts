/**
 * Vault context（main 进程级单例）。
 *
 * 唯一管理"当前 vault 路径"的地方：
 *   - settings / connections / plugins handler 都从这里取 currentVaultPath
 *   - 切换 vault 时按固定顺序 shutdown 老插件 → seed `.stela/` → reload registry
 *   - vaultPath=null 表示当前没有打开的 vault（启动 / closeVault），handler 应该直接报 `no_vault`
 *
 * Renderer 通过 `window.stela.vault.setCurrent(path | null)` 间接调用 `setCurrentVault`。
 */

import { getLogger } from "../services/logger";
import { ensureGitignore } from "../services/git/init";
import { maybeSeedFromLegacy } from "../services/migrate-userdata-to-vault";
import { setVault as registrySetVault } from "../services/connectors/registry";
import { seedBundledPlugins } from "../services/connectors/bundled-plugins";
import * as resultStore from "../services/result-store";
import * as sqlIndex from "../services/sql-index";
import * as syncOrchestrator from "../services/sync-orchestrator";
import * as vaultIndex from "../services/vault-index";
import * as vaultWatcher from "../services/vault-watcher";

const log = getLogger("vault-context");

let currentVaultPath: string | null = null;

export function getCurrentVault(): string | null {
  return currentVaultPath;
}

/**
 * 切换当前 vault 上下文。串联：
 *   1. seed 老 userData 配置（仅当目标 vault 没有 .stela/ 时）
 *   2. shutdown 旧 vault 的 subprocess plugin → spawn 新 vault 的
 *   3. 更新本模块的 currentVaultPath
 *
 * 任何一步失败都会抛 AppError，状态保持原样（不部分提交）。
 */
export async function setCurrentVault(
  vaultPath: string | null,
): Promise<void> {
  if (vaultPath === currentVaultPath) {
    log.info("setCurrentVault no-op", { vaultPath });
    return;
  }
  log.info("setCurrentVault begin", {
    from: currentVaultPath,
    to: vaultPath,
  });
  if (vaultPath) {
    await maybeSeedFromLegacy(vaultPath).catch((err: unknown) => {
      // seed 失败不致命：日志记录后继续，让用户至少能用空 vault settings
      log.error("seed from legacy failed", {
        vaultPath,
        err: err instanceof Error ? err.message : String(err),
      });
    });
    // 向后兼容：把官方 mysql 插件 seed 进 vault（仅首次，marker 记录），
    // 保证旧 vault 里 kind:mysql 的连接在内置 connector 移除后仍开箱可用。
    await seedBundledPlugins(vaultPath).catch((err: unknown) => {
      log.error("seed bundled plugins failed", {
        vaultPath,
        err: err instanceof Error ? err.message : String(err),
      });
    });
    await ensureGitignore(vaultPath).catch((err: unknown) => {
      log.error("ensure gitignore failed", {
        vaultPath,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }
  await registrySetVault(vaultPath);
  // 执行历史 Journal：打开本机 SQLite 缓存并增量导入 `.stela/history/*.jsonl`。
  // SQLite 在 v2 模型下是查询加速缓存（可从 JSONL 重建），import 失败不致命：
  // 缺失的 runId 会在读取时按需回填。后台执行，不阻塞 setCurrentVault。
  if (vaultPath) {
    const vp = vaultPath;
    void resultStore
      .open(vp)
      .then(() => syncOrchestrator.onVaultOpen(vp))
      .catch((err: unknown) => {
        log.error("vault-open journal bootstrap failed", {
          vaultPath: vp,
          err: err instanceof Error ? err.message : String(err),
        });
      });
  }
  // 启动 / 切换 / 关停 vault watcher（v0.2 #7）。失败不致命：watcher 缺失时
  // 用户仍能正常使用，只是丢掉外部变更刷新能力。
  await vaultWatcher.start(vaultPath).catch((err: unknown) => {
    log.error("start vault watcher failed", {
      vaultPath,
      err: err instanceof Error ? err.message : String(err),
    });
  });
  // 启动 vault index（v0.3 双链 M2）。索引是 watcher 的下游消费者，所以
  // 必须在 watcher.start 之后再起，确保 subscribe 时 watcher 已就位；
  // 反向顺序里 first scan 期间发生的事件会丢。失败不致命：补全 / backlinks
  // 会返回空，编辑器主体仍可用。
  await vaultIndex.start(vaultPath).catch((err: unknown) => {
    log.error("start vault index failed", {
      vaultPath,
      err: err instanceof Error ? err.message : String(err),
    });
  });
  // 启动 SQL 事实索引（AST 结构化检索）。同样是 watcher 下游，必须在
  // watcher.start 之后再起；失败不致命，SQL 搜索面板会显示空结果 + 报错态。
  await sqlIndex.start(vaultPath).catch((err: unknown) => {
    log.error("start sql index failed", {
      vaultPath,
      err: err instanceof Error ? err.message : String(err),
    });
  });
  currentVaultPath = vaultPath;
  log.info("setCurrentVault done", { vaultPath });
}

/** 主进程退出前调用：让 registry shutdown 所有 subprocess plugin。 */
export function shutdownVaultContext(): void {
  void registrySetVault(null).catch(() => {});
  void vaultWatcher.stop().catch(() => {});
  void vaultIndex.stop().catch(() => {});
  void sqlIndex.stop().catch(() => {});
  currentVaultPath = null;
}
