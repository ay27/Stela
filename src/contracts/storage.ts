/**
 * Stela 结果存储的前端契约（与 Rust SqliteStore 命令一一对应）。
 *
 * RunRecord 的 status 是枚举字符串：
 *   - "ok"：执行成功
 *   - "err"：连接器或数据库返回错误
 *   - "running"：（保留）流式执行场景占位，M3 暂不使用
 */

import type { ColumnDef } from "./connector";

export interface RunRecord {
  runId: string;
  blockId: string;
  sql: string;
  status: "ok" | "err" | "running";
  message: string | null;
  /** Unix epoch ms */
  startedAt: number;
  elapsedMs: number;
  rowCount: number;
  connectionName: string;
  /**
   * 触发该 run 的笔记文件绝对路径。Run History（v0.2 #5）用来跳回对应文件。
   * 历史数据没有这个字段，会是 null —— 点击该行时不跳，只展示 SQL。
   */
  notePath: string | null;
}

export interface RowsPage {
  offset: number;
  limit: number;
  rows: unknown[][];
  total: number;
}

export interface IStorage {
  /** 切换 vault 时调用一次，重新打开 SQLite 文件 */
  open(vaultPath: string): Promise<void>;
  saveRun(record: RunRecord): Promise<void>;
  saveSchema(runId: string, columns: ColumnDef[]): Promise<void>;
  saveRows(runId: string, rows: unknown[][]): Promise<void>;
  queryPage(runId: string, offset: number, limit: number): Promise<RowsPage>;
  getSchema(runId: string): Promise<ColumnDef[]>;
  /** 列出所有 run，按 startedAt 倒序。Run History 视图（v0.2 #5）用。 */
  listRuns(): Promise<RunRecord[]>;
  /** 列出某 block 的历史 run，按 startedAt 倒序。Block 内 Run Rail / diff 用。 */
  listRunsByBlockId(
    blockId: string,
    options?: ListRunsByBlockOptions,
  ): Promise<RunRecord[]>;
  /** 清掉早于 keepDays 天的 runs（级联删 schemas / rows） */
  cleanup(keepDays: number): Promise<number>;
}

export interface ListRunsByBlockOptions {
  limit?: number;
  offset?: number;
  status?: "ok" | "err" | "all";
}
