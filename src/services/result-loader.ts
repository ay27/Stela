/**
 * 结果分页加载器：本地优先，必要时按 runId 从执行历史 JSONL 恢复一次。
 *
 * 这是 v2 Git+JSONL 同步链路的"读侧"补丁：
 *   - main 端 [`importRun`](../../electron/services/history-journal.ts) 能"按 runId
 *     扫描 `.stela/history/*.jsonl` 找到该 run 并写回本机 SQLite 缓存"。
 *   - 但 renderer 之前直接走 `electronStorage.getSchema / queryPage`，本地缓存缺结果
 *     时只会返回空表。用户在另一台设备执行、或清空过本机缓存后，已同步到 JSONL
 *     的结果集就"读不出来"。
 *
 * 本模块把"判断何时应该恢复 + 导入一次 + 重读一次"集中起来，[`BlockResult`](../components/block-result.tsx)
 * 不再自己拼这些条件分支。同时通过依赖注入把 storage / journal 抽出来，
 * 在 [`./result-loader.test.ts`](./result-loader.test.ts) 中可纯 Node 单测。
 *
 * 触发条件（保守，避免 mutation / 真·空结果误触发）：
 *   - 必须传入 runId（block 已经执行过）
 *   - `detailRowCount > 0`（笔记里 `<detail>` 记录过非零行数）
 *   - 且 (本地 schema 为空) 或 (本地 total === 0)
 *
 * 一次 load 调用最多触发一次 JSONL 导入——即使导入后本地仍读不到（JSONL 里没有
 * 该 runId），也不会再次重试，避免恶性循环。
 */

import type { ColumnDef, IStorage, RowsPage } from "@/contracts";

/** loader 依赖；测试时可注入内存版 storage / journal。 */
export interface ResultLoaderDeps {
  storage: Pick<IStorage, "getSchema" | "queryPage">;
  journal: {
    /** 后端 [`importRun`](../../electron/services/history-journal.ts) 投影：
     *  按 runId 从 JSONL 导入到本机缓存，返回是否找到并导入。 */
    importRun: (runId: string) => Promise<boolean>;
  };
}

export interface LoadResultRequest {
  runId: string;
  /**
   * `<detail>` 里记录的 rowCount。null 表示笔记里没有 detail 摘要（block 还没
   * 执行过 / 或者只有 mutation）。
   */
  detailRowCount: number | null;
  pageIndex: number;
  pageSize: number;
}

export interface LoadResultPage {
  schema: ColumnDef[];
  rows: unknown[][];
  total: number;
  /**
   * 本次 load 是否触发了一次远端恢复。UI 可据此显示一次性的"已从远端恢复"
   * 提示，但不强制要求。
   */
  recovered: boolean;
}

function shouldRecover(
  detailRowCount: number | null,
  schema: ColumnDef[],
  page: RowsPage,
): boolean {
  // detail 里没记 rowCount → 视为"无结果集"或"未知"，保守不拉。
  if (detailRowCount === null || detailRowCount <= 0) return false;
  // 完全没 schema → 无疑缺数据。
  if (schema.length === 0) return true;
  // schema 在但 rows 没了（手动 cleanup / 半残）→ 也需要恢复。
  if (page.total === 0) return true;
  return false;
}

/**
 * 加载一页结果。如果本地命中 → 直接返回；否则尝试一次远端恢复，再重读本地。
 *
 * 异常处理：
 *   - storage 抛错：直接向上抛（按现有契约由 UI 显示）。
 *   - journal.importRun 抛错：向上抛，**不**回退到"返回空表"。让 UI 把具体错误
 *     暴露出来，方便用户决定下一步。
 */
export async function loadResultPage(
  req: LoadResultRequest,
  deps: ResultLoaderDeps,
): Promise<LoadResultPage> {
  const { runId, detailRowCount, pageIndex, pageSize } = req;
  const offset = pageIndex * pageSize;

  // 第一次本地读：schema + 当前页。getSchema 与 queryPage 互不依赖，并发就好。
  const [firstSchema, firstPage] = await Promise.all([
    deps.storage.getSchema(runId),
    deps.storage.queryPage(runId, offset, pageSize),
  ]);

  if (!shouldRecover(detailRowCount, firstSchema, firstPage)) {
    return {
      schema: firstSchema,
      rows: firstPage.rows,
      total: firstPage.total,
      recovered: false,
    };
  }

  // 触发一次 JSONL 导入。importRun 内部会写回 runs / result_schemas /
  // result_rows，因此导入后再读一遍本地即可拿到完整数据。
  await deps.journal.importRun(runId);

  const [schema, page] = await Promise.all([
    deps.storage.getSchema(runId),
    deps.storage.queryPage(runId, offset, pageSize),
  ]);

  return {
    schema,
    rows: page.rows,
    total: page.total,
    recovered: true,
  };
}
