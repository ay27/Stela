/**
 * Connector 抽象的前端契约。
 *
 * 与 Rust 端的 `ConnectorKindMeta`、`QueryResult`、`TestResult`、`ConnectorError`
 * 一一对应。前端只面对 IConnectorRegistry，看不到具体 in-process / subprocess
 * 实现的差别。
 */

export interface ConnectorKindMeta {
  kind: string;
  displayName: string;
  /** JSON Schema 风格描述，前端按字段渲染表单 */
  configSchema: unknown;
  defaultConfig: unknown;
  /** 是否子进程实现 */
  subprocess: boolean;
  /** SQL 方言名（"MySQL" / "PostgreSQL" / "StarRocks" 等），不填时按 kind 启发式回退 */
  dialect?: string;
}

export interface ColumnDef {
  name: string;
  /** 原始数据库列类型字符串，例 VARCHAR / DATETIME / BLOB */
  typeName: string;
}

export type QueryResult =
  | {
      kind: "query";
      columns: ColumnDef[];
      rows: unknown[][];
      elapsedMs: number;
    }
  | {
      kind: "mutation";
      affectedRows: number;
      elapsedMs: number;
    };

export interface TestResult {
  ok: boolean;
  message?: string;
  latencyMs?: number;
}

export interface ConnectorError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface IConnectorRegistry {
  listKinds(): Promise<ConnectorKindMeta[]>;
  test(kind: string, config: unknown): Promise<TestResult>;
  execute(kind: string, config: unknown, sql: string): Promise<QueryResult>;
  listDatabases(kind: string, config: unknown): Promise<string[]>;
  listTables(kind: string, config: unknown, db?: string): Promise<string[]>;
}
