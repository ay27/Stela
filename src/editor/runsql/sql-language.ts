/**
 * SQL 编辑器扩展：`@codemirror/lang-sql` 语法 + 上下文感知的补全。
 *
 * 与早期 SQL 补全实现的区别：
 *   - 旧版三级：表名 > 关键字 > 同文档 word-based
 *   - 新版按"光标作用域"自动切换：
 *       1) `alias.|` / `db.table.|` / `table.|` → 只补该表的**列名**
 *          （来自 `ensureColumnsForTable` 探针 + `column-cache` TTL 缓存）
 *       2) 顶层（无 `xxx.` 前缀） → 表名 fuzzy + 关键字 + sibling words
 *     列上下文识别走 [`sql-scope.ts`](./sql-scope.ts) —— 复用 lang-sql 的 Lezer
 *     语法树 + 自家 alias/FROM 状态机。
 *
 * 为什么仍然 `override` 而不是叠在 lang-sql 内置 `schemaCompletionSource` 上：
 *   - lang-sql 的 schema 必须在 `sql({ schema })` 注册时一次性给定；我们的列
 *     是按需懒加载的，要靠 Compartment + reconfigure 才能更新，链路绕。
 *   - 单 source `async` 写法可以直接 await `column-cache.ensure(...)`，
 *     首次拉取就立即返回结果；命中缓存零延迟。
 *   - lang-sql 自带的关键字补全我们用不上（关键字列表自己维护，方便约束顺序）。
 */
import { sql } from "@codemirror/lang-sql";
import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";

import type { ColumnDef } from "@/contracts";

import {
  extractAliasMap,
  getCompletionPath,
  resolveTargetTable,
} from "./sql-scope";

const SQL_KEYWORDS: readonly string[] = [
  "SELECT",
  "FROM",
  "WHERE",
  "GROUP BY",
  "ORDER BY",
  "LIMIT",
  "OFFSET",
  "HAVING",
  "JOIN",
  "LEFT JOIN",
  "RIGHT JOIN",
  "INNER JOIN",
  "OUTER JOIN",
  "ON",
  "AS",
  "AND",
  "OR",
  "NOT",
  "IN",
  "BETWEEN",
  "LIKE",
  "IS",
  "NULL",
  "DISTINCT",
  "INSERT INTO",
  "VALUES",
  "UPDATE",
  "SET",
  "DELETE FROM",
  "SHOW",
  "SHOW DATABASES",
  "SHOW TABLES",
  "DESCRIBE",
  "EXPLAIN",
  "CREATE TABLE",
  "ALTER TABLE",
  "DROP TABLE",
  "INDEX",
  "PRIMARY KEY",
  "FOREIGN KEY",
  "REFERENCES",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "CAST",
  "COUNT",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
];

export interface SqlExtensionOptions {
  /** 同文档其它 runsql block 的 SQL 文本，用作 word-based 补全词典（同步返回） */
  getSiblingSqls?: () => string[];
  /** 当前 connection 的表名，异步；失败请 resolve([]) */
  getTableNames?: () => Promise<string[]>;
  /**
   * 取指定表的列元数据。首次拉取应在内部 await `LIMIT 0` 探针，
   * 后续 TTL 缓存命中要立即返回（不再卡补全弹窗）。失败请 resolve([])
   * —— 补全 source 会自动降级为"无列可补"。
   */
  ensureColumnsForTable?: (
    db: string | null,
    table: string,
  ) => Promise<ColumnDef[]>;
}

function normalizePrefix(prefix: string): string {
  return prefix.trim().toUpperCase();
}

function normalizeForFuzzyMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSubsequence(query: string, target: string): boolean {
  if (query.length === 0) return true;
  let qi = 0;
  for (let i = 0; i < target.length && qi < query.length; i += 1) {
    if (target[i] === query[qi]) qi += 1;
  }
  return qi === query.length;
}

/**
 * 表名匹配评分（越小越靠前；null 表示完全不命中）。
 * 对齐 legacy：prefix(0) > substring(1) > subsequence(2)；带 "." 时只走 prefix。
 */
export function tableScore(query: string, name: string): number | null {
  const q = query.trim();
  if (!q) return 0;
  const lq = q.toLowerCase();
  const ln = name.toLowerCase();
  if (ln.startsWith(lq)) return 0;
  if (q.includes(".")) return null;
  if (ln.includes(lq)) return 1;
  if (isSubsequence(normalizeForFuzzyMatch(q), normalizeForFuzzyMatch(name)))
    return 2;
  return null;
}

/** 按 SQL 补全同款评分过滤表名，供 AI @ 引用等场景复用。 */
export function filterTableNames(
  prefix: string,
  tableNames: readonly string[],
  limit = 12,
): string[] {
  return tableNames
    .map((name, idx) => ({ name, idx, score: tableScore(prefix, name) }))
    .filter(
      (entry): entry is { name: string; idx: number; score: number } =>
        entry.score !== null,
    )
    .sort((a, b) => a.score - b.score || a.idx - b.idx)
    .slice(0, limit)
    .map((entry) => entry.name);
}

/** 抽取同文档其它 runsql block 里的 word 做 word-based 补全候选。 */
function collectWords(sqls: string[], exclude: Set<string>): string[] {
  const out = new Set<string>();
  for (const s of sqls) {
    const matches = s.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g);
    if (!matches) continue;
    for (const m of matches) {
      if (exclude.has(m.toUpperCase())) continue;
      out.add(m);
    }
  }
  return Array.from(out);
}

const KEYWORDS_SET = new Set(SQL_KEYWORDS);

/**
 * 顶层补全候选：表名 > 关键字 > sibling words。与 legacy 行为一致。
 *
 * 暴露出来主要给单测 (tests/sql-language.test.ts 等) 走纯函数路径。
 */
export function buildTopLevelOptions(
  prefix: string,
  tableNames: readonly string[],
  siblingSqls: readonly string[],
): Completion[] {
  const normalized = normalizePrefix(prefix);

  const keywordOpts: Completion[] = SQL_KEYWORDS.filter((k) =>
    k.startsWith(normalized),
  ).map((k) => ({ label: k, type: "keyword" as const, boost: 0 }));

  const tableEntries = tableNames
    .map((name, idx) => ({ name, idx, score: tableScore(prefix, name) }))
    .filter(
      (e): e is { name: string; idx: number; score: number } =>
        e.score !== null,
    )
    .sort((a, b) => a.score - b.score || a.idx - b.idx);
  const tableOpts: Completion[] = tableEntries.map((e) => ({
    label: e.name,
    type: "type" as const,
    boost: 5,
  }));

  const exclude = new Set<string>(KEYWORDS_SET);
  tableNames.forEach((t) => exclude.add(t.toUpperCase()));
  const words = collectWords(Array.from(siblingSqls), exclude)
    .filter((w) => w.toLowerCase().startsWith(prefix.toLowerCase()))
    .map<Completion>((w) => ({
      label: w,
      type: "text" as const,
      boost: -5,
    }));

  return [...tableOpts, ...keywordOpts, ...words];
}

export function topLevelValidFor(parents: readonly string[]): RegExp {
  return parents.length === 0 ? /^\w*$/ : /^[\w.]*$/;
}

function buildColumnOptions(
  columns: readonly ColumnDef[],
  prefix: string,
): Completion[] {
  const lower = prefix.toLowerCase();
  return columns
    .filter((c) => (lower ? c.name.toLowerCase().startsWith(lower) : true))
    .map<Completion>((c) => ({
      label: c.name,
      type: "property",
      detail: c.typeName || undefined,
      // 列上下文里只该出列，给个高 boost 让它压过偶发同名 sibling word。
      boost: 10,
    }));
}

function logColumnCompletionDebug(
  data: Record<string, unknown>,
): void {
  if (!import.meta.env.DEV) return;
  console.info("[stela] column completion", data);
}

export function sqlExtensions(options: SqlExtensionOptions = {}): Extension[] {
  const { getSiblingSqls, getTableNames, ensureColumnsForTable } = options;

  const fetchTables = async (): Promise<string[]> => {
    if (!getTableNames) return [];
    try {
      return await getTableNames();
    } catch (err) {
      console.warn("[stela] listTables failed", err);
      return [];
    }
  };

  const fetchColumns = async (
    db: string | null,
    table: string,
  ): Promise<ColumnDef[]> => {
    if (!ensureColumnsForTable) return [];
    try {
      return await ensureColumnsForTable(db, table);
    } catch (err) {
      console.warn("[stela] ensureColumns failed", db, table, err);
      return [];
    }
  };

  const source = async (
    ctx: CompletionContext,
  ): Promise<CompletionResult | null> => {
    const token = ctx.matchBefore(/[\w.]+/);
    if (!token && !ctx.explicit) return null;

    const path = getCompletionPath(ctx.state, ctx.pos);

    if (path.parents.length > 0) {
      // 列上下文：先尝试 alias → 表，再尝试 parents 末两段当 db.table 直查。
      const aliases = extractAliasMap(ctx.state, ctx.pos);
      const target = resolveTargetTable(path.parents, aliases);
      if (target) {
        const cols = await fetchColumns(target.db, target.table);
        const opts = buildColumnOptions(cols, path.prefix);
        logColumnCompletionDebug({
          parents: path.parents,
          prefix: path.prefix,
          target,
          columnCount: cols.length,
          optionCount: opts.length,
          sample: cols.slice(0, 5).map((c) => c.name),
        });
        if (cols.length > 0) {
          if (opts.length > 0) {
            return {
              from: path.from,
              options: opts,
              // 列名是单段 identifier，不含点；用 /^\w*$/ 让 CM 在用户继续敲
              // 字母时复用同一份结果，不必每次重跑 source。
              validFor: /^\w*$/,
            };
          }
        }
      } else {
        logColumnCompletionDebug({
          parents: path.parents,
          prefix: path.prefix,
          target: null,
        });
      }
      // 走到这里有两种可能：解析不到表、或者列拉失败 / 为空。
      // parents.length === 1 时，"db." 这种前缀也可能用户想列 db 下的表 ——
      // 让 fall-through 到顶层路径继续提供表名 fuzzy。
      if (path.parents.length !== 1) return null;
    }

    const tables = await fetchTables();
    const siblings = getSiblingSqls?.() ?? [];
    const prefix = token?.text ?? "";
    const opts = buildTopLevelOptions(prefix, tables, siblings);
    if (opts.length === 0) return null;
    return {
      from: token?.from ?? ctx.pos,
      options: opts,
      // 裸顶层不能把 "." 视为仍然有效，否则 `o` 的旧结果会盖住后续 `o.`
      // 字段上下文。点号 fallback（如 `db.table` 表名前缀）仍保留 legacy 行为。
      validFor: topLevelValidFor(path.parents),
    };
  };

  // 注意：保留 sql() 是为了语法高亮 + 提供 syntaxTree(state) 给 sql-scope.ts 使用。
  // autocompletion override 会屏蔽 lang-sql 自带的 keyword / schema source，
  // 全部由本文件的 `source` 一手包揽（避免双源出现"列 + 表"重复或交错）。
  return [sql(), autocompletion({ override: [source] })];
}
