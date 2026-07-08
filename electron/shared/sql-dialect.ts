/**
 * SQL 方言解析：从 connector 元信息推导出一个统一的方言名，并映射到
 * `@codemirror/lang-sql` 的 lezer `SQLDialect`。main / preload / renderer 共用
 * （经 `@shared` 别名），纯函数、无 Electron / DOM 依赖。
 *
 * 解析优先级：
 *   1. 插件在 `meta().dialect` 里显式声明的方言名（推荐，见 plugin-sdk）。
 *   2. 启发式回退 `dialectFromKind`：按 kind/displayName 关键字猜（兼容存量插件，
 *      未声明 dialect 字段时不至于全部退化成 StandardSQL）。
 *
 * lezer 只有词法层方言（关键字/引号/注释/cast 语法），没有 StarRocks —— StarRocks
 * 走 MySQL 协议且语法基本兼容，映射到 `MySQL` 足够覆盖 DML 语句的 tokenize。
 */
import {
  MySQL,
  PostgreSQL,
  StandardSQL,
  type SQLDialect,
} from "@codemirror/lang-sql";

/** 启发式回退：按 kind + displayName 的关键字猜方言名。 */
export function dialectFromKind(kind: string, displayName: string): string {
  const key = `${kind} ${displayName}`.toLowerCase();
  if (key.includes("starrocks")) return "StarRocks";
  if (key.includes("postgres")) return "PostgreSQL";
  if (key.includes("mysql")) return "MySQL";
  if (key.includes("sqlite")) return "SQLite";
  if (key.includes("duckdb")) return "DuckDB";
  return displayName || kind;
}

export interface DialectSource {
  kind: string;
  displayName: string;
  dialect?: string | null;
}

/** 统一解析入口：优先用插件显式声明，否则按 kind/displayName 回退猜测。 */
export function resolveDialect(meta: DialectSource): string {
  return meta.dialect || dialectFromKind(meta.kind, meta.displayName);
}

/**
 * 方言名 → lezer `SQLDialect`。用于编辑器语法高亮/补全（`sql({ dialect })`）与
 * SQL 事实抽取器的 tokenize 阶段。未识别的方言名回退到 `StandardSQL`。
 */
export function lezerDialectFor(dialectName: string | null | undefined): SQLDialect {
  const key = (dialectName ?? "").toLowerCase();
  if (key.includes("postgres")) return PostgreSQL;
  // StarRocks 用 MySQL 协议、语法基本兼容 MySQL；MariaDB/TiDB 等同理。
  if (key.includes("mysql") || key.includes("starrocks") || key.includes("maria") || key.includes("tidb")) {
    return MySQL;
  }
  return StandardSQL;
}
