/**
 * SQL 事实索引前端 service（Electron 适配）。
 *
 * 走 main 进程 `electron/services/sql-index.ts`：结构化过滤（操作类型 / 读写表 /
 * 写列）在 main 侧内存索引里求交集，本文件只是 IPC 薄封装 + 状态变化订阅。
 */

import type {
  SqlIndexFacets,
  SqlIndexFilter,
  SqlIndexHit,
  SqlIndexStatus,
} from "@shared/types";

export type {
  SqlIndexFacets,
  SqlIndexFilter,
  SqlIndexHit,
  SqlIndexOperation,
  SqlIndexStatus,
} from "@shared/types";

export async function querySqlIndex(
  filter: SqlIndexFilter,
): Promise<SqlIndexHit[]> {
  return window.stela.sqlIndex.query(filter);
}

export async function sqlIndexFacets(): Promise<SqlIndexFacets> {
  return window.stela.sqlIndex.facets();
}

export async function sqlIndexStatus(): Promise<SqlIndexStatus> {
  return window.stela.sqlIndex.status();
}

/** 订阅 main 推送的索引状态变化（建库进度 / 就绪 / 增量更新）。返回 unsubscribe。 */
export function onSqlIndexChanged(callback: () => void): () => void {
  return window.stela.sqlIndex.onChanged(callback);
}
