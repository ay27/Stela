/**
 * Connector runtime 内部类型。
 *
 * Connector service 运行时契约：
 *   - meta() 返回 ConnectorKindMeta（前端表单渲染依据）
 *   - test(cfg) 探活
 *   - execute(cfg, sql) 跑 SQL
 *   - listDatabases / listTables 浏览 schema
 *
 * 错误一律抛 AppError（带 code）；caller 在 IPC 边界归一化。
 */

import type {
  ConnectorKindMeta,
  DataQueryRequest,
  MaterializedQueryResult,
  QueryArtifactRequest,
  QueryResult,
  TableDescriptor,
  TestResult,
} from "@shared/types";

export interface Connector {
  meta(): ConnectorKindMeta;
  test(cfg: unknown): Promise<TestResult>;
  execute(cfg: unknown, sql: string): Promise<QueryResult>;
  /** API v3 structured query entry. Missing implementations remain SQL-only. */
  executeQuery?(cfg: unknown, request: DataQueryRequest): Promise<QueryResult>;
  materializeQuery?(
    cfg: unknown,
    sql: string,
    request: QueryArtifactRequest,
  ): Promise<MaterializedQueryResult>;
  /** API v3 structured-query artifact path. */
  materializeDataQuery?(
    cfg: unknown,
    query: DataQueryRequest,
    request: QueryArtifactRequest,
  ): Promise<MaterializedQueryResult>;
  listDatabases(cfg: unknown): Promise<string[]>;
  listTables(cfg: unknown, db?: string | null): Promise<string[]>;
  /**
   * 可选：批量拿表结构（含 COMMENT）。实现后是 AI 列注释打分的干净路径；
   * 不实现时 host 回退到 listTables + DESCRIBE 拼装（详见 ADR-0042）。
   */
  describeTables?(
    cfg: unknown,
    tables: Array<{ database: string | null; table: string }>,
  ): Promise<TableDescriptor[]>;
  /**
   * 可选：释放底层资源（连接池 / socket）。registry 在切 vault / 卸载插件时调用。
   * 内置 / subprocess connector 可不实现；module 插件（如 mysql）借此关连接池。
   */
  dispose?(): void | Promise<void>;
}
