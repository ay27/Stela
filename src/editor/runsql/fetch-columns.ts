/**
 * 列元数据拉取（按表）：`SELECT * FROM <qualified> LIMIT 0` 探针。
 *
 * 提取自 SchemaBrowserPanel 的内联逻辑，让 Schema 浏览器侧栏与 SQL 补全列名
 * 共用同一份 SQL 拼接 / 错误归一化，避免日后两边分别长歪。
 *
 *   - 适配几乎所有 SQL 方言：LIMIT 0 返回零行但带列元数据
 *   - 失败兜底由调用方决定（侧栏 inline 错误 / 补全静默忽略）
 *   - 不做复杂引号转义：表名来自 listTables，特殊字符的概率极低
 */
import type { ColumnDef } from "@/contracts";
import type { QueryResult } from "@/contracts";
import { electronConnectorRegistry } from "@/services/connectors/electron-connector";
import { useConnections } from "@/state/connections";

/** `db` 非空时返回 `db.table`，否则裸表名。与 Schema 侧栏 tableKey 一致。 */
export function qualifiedTableName(db: string | null, table: string): string {
  return db ? `${db}.${table}` : table;
}

function findColumnIndex(columns: readonly ColumnDef[], names: readonly string[]): number {
  const lowerNames = new Set(names.map((name) => name.toLowerCase()));
  return columns.findIndex((column) => lowerNames.has(column.name.toLowerCase()));
}

export function columnsFromDescribeResult(result: QueryResult): ColumnDef[] {
  if (result.kind !== "query") return [];

  const fieldIdx = findColumnIndex(result.columns, [
    "field",
    "column_name",
    "name",
  ]);
  if (fieldIdx < 0) return [];

  const typeIdx = findColumnIndex(result.columns, [
    "type",
    "data_type",
    "column_type",
  ]);

  return result.rows
    .map((row) => {
      const name = row[fieldIdx];
      if (typeof name !== "string" || !name) return null;
      const typeName = typeIdx >= 0 ? row[typeIdx] : null;
      return {
        name,
        typeName: typeof typeName === "string" ? typeName : "UNKNOWN",
      };
    })
    .filter((column): column is ColumnDef => column !== null);
}

/**
 * 真实拉取指定表的列元数据。
 *
 * 抛错情形：
 *   - 连接 entry 不存在（被删了 / 名字打错）
 *   - connector.execute 自身报错
 *   - 返回 mutation 而非 query（极少见，多半是 connector 实现 bug）
 */
export async function fetchColumnsForTable(
  connection: string,
  db: string | null,
  table: string,
): Promise<ColumnDef[]> {
  const entry = useConnections.getState().get(connection);
  if (!entry) {
    throw new Error(`未找到连接 ${connection}`);
  }
  const sql = `SELECT * FROM ${qualifiedTableName(db, table)} LIMIT 0`;
  const result = await electronConnectorRegistry.execute(
    entry.kind,
    entry.config,
    sql,
  );
  if (result.kind !== "query") {
    throw new Error("connector 未返回列结构");
  }
  if (result.columns.length > 0) return result.columns;

  const describeSql = `DESCRIBE ${qualifiedTableName(db, table)}`;
  const describeResult = await electronConnectorRegistry.execute(
    entry.kind,
    entry.config,
    describeSql,
  );
  return columnsFromDescribeResult(describeResult);
}
