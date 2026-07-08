/**
 * SQL 事实抽取器：把一条 SQL 语句解析成结构化事实（操作类型 / 读写表 / 写入列），
 * 用于 SQL 索引服务的正排 / 倒排构建。main / renderer 共用，无 DOM / Electron 依赖。
 *
 * 解析策略：直接用 `@codemirror/lang-sql` 的 lezer parser 解析 SQL 字符串
 * （不依赖 CodeMirror `EditorState`，方便批量跑），拿到的 `Statement` 语法树是
 * **扁平**的（INSERT / UPDATE 的关键字、标识符、`Parens`、操作符都是 Statement
 * 的直接子节点，子查询整块折叠进一个 `Parens` 节点，不会展开进来）——这既是
 * 限制也是便利：我们可以用状态机顺序扫描直接子节点来识别 `INSERT INTO t (...)
 * VALUES (...)`、`UPDATE t SET a=1 WHERE ...`、`ON DUPLICATE KEY UPDATE ...`
 * 这类结构，不需要写一个完整的 SQL parser。alias / FROM 扫描的状态机思路借鉴自
 * [`src/editor/runsql/sql-scope.ts`](../../src/editor/runsql/sql-scope.ts)（该文件
 * 依赖 CodeMirror `EditorState`，只用于编辑器内补全，这里重新实现一份不依赖
 * `EditorState` 的版本，供 main 进程批量索引使用）。
 *
 * 已知限制（对齐 plan 的"已知限制"一节，v1 不解决）：
 *   - INSERT 无列清单 / `INSERT ... SELECT` 且未写列清单：标 `columns-unknown`，
 *     不接 schema-dump 反查猜列序。
 *   - 拼接 / 模板 SQL（`${var}`、解析失败片段）：标 `dynamic`，不猜测结构。
 *   - 子查询 / CTE 内层 alias 不保证解析（子查询整块在一个 `Parens` 节点里，
 *     我们不递归进去找它内部的表/列）。
 *   - `⚠`（lezer 错误恢复节点）覆盖的语句直接整条标 `dynamic`。
 */
import type { SQLDialect } from "@codemirror/lang-sql";
import { StandardSQL } from "@codemirror/lang-sql";
import type { SyntaxNode, Tree } from "@lezer/common";

export type SqlOperation =
  | "select"
  | "insert"
  | "replace"
  | "update"
  | "delete"
  | "upsert"
  | "ddl"
  | "other";

export interface TableRef {
  db: string | null;
  table: string;
}

export interface ColumnRef {
  db: string | null;
  /** 无法归属到具体表时为 null（多表 UPDATE 里未加前缀的列、或别名解析失败）。 */
  table: string | null;
  column: string;
}

export type UnresolvedKind = "columns-unknown" | "dynamic";

export interface StatementFacts {
  operation: SqlOperation;
  readTables: TableRef[];
  writeTables: TableRef[];
  writeColumns: ColumnRef[];
  unresolved: UnresolvedKind[];
  /** 语句在原始 SQL 文本内的字符偏移（含首尾空白裁剪前的 lezer 节点范围）。 */
  from: number;
  to: number;
}

export interface ExtractSqlFactsOptions {
  /** lezer 方言。默认 `StandardSQL`；建议传 `lezerDialectFor(resolveDialect(meta))`。 */
  dialect?: SQLDialect;
}

const MAIN_VERBS = new Set([
  "SELECT",
  "INSERT",
  "REPLACE",
  "UPDATE",
  "DELETE",
  "CREATE",
  "ALTER",
  "DROP",
  "TRUNCATE",
  "RENAME",
]);

const DDL_VERBS = new Set(["CREATE", "ALTER", "DROP", "TRUNCATE", "RENAME"]);

/** UPDATE/SELECT 的表引用扫描在遇到这些关键字时停止（进入了 SET/WHERE/聚合等子句）。 */
const TABLE_SCAN_STOP_WORDS = new Set([
  "set",
  "where",
  "group",
  "having",
  "order",
  "union",
  "intersect",
  "except",
  "limit",
  "offset",
  "fetch",
  "for",
  "returning",
]);

/** 解析一段 SQL 文本（可能含多条以 `;` 分隔的语句），逐条抽取事实。 */
export function extractSqlFacts(
  sql: string,
  options: ExtractSqlFactsOptions = {},
): StatementFacts[] {
  const dialect = options.dialect ?? StandardSQL;
  const trimmed = sql;
  if (!trimmed.trim()) return [];

  let tree: Tree;
  try {
    tree = dialect.language.parser.parse(trimmed);
  } catch {
    // lezer 是容错解析器，理论上不会抛异常；防御性兜底，避免一条坏 SQL 拖垮整个索引。
    return [
      {
        operation: "other",
        readTables: [],
        writeTables: [],
        writeColumns: [],
        unresolved: ["dynamic"],
        from: 0,
        to: trimmed.length,
      },
    ];
  }

  const statements: StatementFacts[] = [];
  for (const stmt of childrenOf(tree.topNode)) {
    if (stmt.name !== "Statement") continue;
    statements.push(extractStatement(trimmed, stmt));
  }
  return statements;
}

// ---------- 单条语句 ----------

function extractStatement(text: string, stmt: SyntaxNode): StatementFacts {
  const children = childrenOf(stmt);
  const errorFlagged = hasErrorDescendant(stmt);

  const verbIdx = findMainVerbIndex(text, children);
  const base: Omit<StatementFacts, "from" | "to"> =
    verbIdx < 0
      ? { operation: "other", readTables: [], writeTables: [], writeColumns: [], unresolved: [] }
      : dispatchByVerb(text, children, verbIdx);

  if (errorFlagged && !base.unresolved.includes("dynamic")) {
    base.unresolved = [...base.unresolved, "dynamic"];
  }

  return { ...base, from: stmt.from, to: stmt.to };
}

function dispatchByVerb(
  text: string,
  children: SyntaxNode[],
  verbIdx: number,
): Omit<StatementFacts, "from" | "to"> {
  const verb = textOf(text, children[verbIdx]!).toUpperCase();
  const rest = children.slice(verbIdx);
  switch (verb) {
    case "INSERT":
    case "REPLACE":
      return extractInsert(text, rest, verb === "REPLACE" ? "replace" : "insert");
    case "UPDATE":
      return extractUpdate(text, rest);
    case "DELETE":
      return extractDelete(text, rest);
    case "SELECT":
      return extractSelect(text, rest);
    default:
      if (DDL_VERBS.has(verb)) {
        return { operation: "ddl", readTables: [], writeTables: [], writeColumns: [], unresolved: [] };
      }
      return { operation: "other", readTables: [], writeTables: [], writeColumns: [], unresolved: [] };
  }
}

function findMainVerbIndex(text: string, children: SyntaxNode[]): number {
  for (let i = 0; i < children.length; i++) {
    const c = children[i]!;
    if (c.name !== "Keyword") continue;
    if (MAIN_VERBS.has(textOf(text, c).toUpperCase())) return i;
  }
  return -1;
}

// ---------- INSERT / REPLACE ----------

function extractInsert(
  text: string,
  children: SyntaxNode[],
  operation: "insert" | "replace",
): Omit<StatementFacts, "from" | "to"> {
  const unresolved: UnresolvedKind[] = [];

  // children[0] 是 INSERT/REPLACE 关键字本身。跳过修饰词（INTO / IGNORE /
  // OVERWRITE(StarRocks，被误标成 Identifier) / LOW_PRIORITY 等），直到遇到
  // 目标表标识符。找不到就整条标 dynamic。
  let i = 1;
  while (i < children.length) {
    const c = children[i]!;
    if (c.name === "Keyword" && textOf(text, c).toUpperCase() === "INTO") {
      i++;
      break;
    }
    if (isTableIdentLike(c)) break;
    i++;
  }

  if (i >= children.length || !isTableIdentLike(children[i]!)) {
    return {
      operation,
      readTables: [],
      writeTables: [],
      writeColumns: [],
      unresolved: ["dynamic"],
    };
  }

  const targetRef = toTableRef(pathFor(text, children[i]!));
  const writeTables = targetRef ? [targetRef] : [];
  if (!targetRef) unresolved.push("dynamic");
  i++;

  let writeColumns: ColumnRef[] = [];
  let columnsExplicit = false;
  if (children[i]?.name === "Parens") {
    columnsExplicit = true;
    writeColumns = columnNamesFromParens(text, children[i]!).map((column) => ({
      db: targetRef?.db ?? null,
      table: targetRef?.table ?? null,
      column,
    }));
    i++;
  }

  let isUpsert = false;

  // 找 VALUES / SELECT / SET（写入来源），再看是否有 upsert 尾巴。
  outer: for (; i < children.length; i++) {
    const c = children[i]!;
    if (c.name !== "Keyword") continue;
    const w = textOf(text, c).toUpperCase();
    if (w === "VALUES") {
      if (!columnsExplicit) unresolved.push("columns-unknown");
      i++;
      while (i < children.length && (children[i]!.name === "Parens" || isPunct(text, children[i]!, ","))) {
        i++;
      }
      break outer;
    }
    if (w === "SELECT" || w === "WITH") {
      // INSERT ... SELECT：子查询整块在后面的 token 里，我们不解析它的投影列。
      if (!columnsExplicit) unresolved.push("columns-unknown");
      // 子查询会消费掉本语句剩余的大部分 token；upsert 尾巴在 INSERT...SELECT
      // 后面极罕见，不再继续找，直接结束扫描。
      i = children.length;
      break outer;
    }
    if (w === "SET") {
      // MySQL 特有：INSERT INTO t SET col1 = val1, col2 = val2
      const { assignments, nextIndex } = parseAssignments(text, children, i + 1, new Set(["ON"]));
      writeColumns = mergeColumnRefs(
        writeColumns,
        assignments.map((a) => toColumnRef(a, targetRef)),
      );
      i = nextIndex;
      break outer;
    }
  }

  // upsert 尾巴：MySQL `ON DUPLICATE KEY UPDATE ...` / Postgres `ON CONFLICT ... DO UPDATE SET ...`
  for (; i < children.length; i++) {
    const c = children[i]!;
    if (c.name !== "Keyword" || textOf(text, c).toUpperCase() !== "ON") continue;
    const tail = parseUpsertTail(text, children, i, targetRef);
    if (tail) {
      writeColumns = mergeColumnRefs(writeColumns, tail.writeColumns);
      isUpsert = true;
    }
    break;
  }

  return {
    operation: isUpsert ? "upsert" : operation,
    readTables: [],
    writeTables,
    writeColumns,
    unresolved,
  };
}

/** 解析 `ON DUPLICATE KEY UPDATE ...` / `ON CONFLICT [(cols)] DO UPDATE SET ...`。 */
function parseUpsertTail(
  text: string,
  children: SyntaxNode[],
  onIdx: number,
  targetRef: TableRef | null,
): { writeColumns: ColumnRef[] } | null {
  const w1 = children[onIdx + 1] ? textOf(text, children[onIdx + 1]!).toUpperCase() : "";

  if (w1 === "DUPLICATE") {
    let j = onIdx + 2;
    if (children[j] && textOf(text, children[j]!).toUpperCase() === "KEY") j++;
    if (children[j] && textOf(text, children[j]!).toUpperCase() === "UPDATE") j++;
    const { assignments } = parseAssignments(text, children, j, new Set(["WHERE", "RETURNING"]));
    return { writeColumns: assignments.map((a) => toColumnRef(a, targetRef)) };
  }

  if (w1 === "CONFLICT") {
    let j = onIdx + 2;
    if (children[j]?.name === "Parens") j++; // 冲突判定列，不是写入列
    if (children[j] && textOf(text, children[j]!).toUpperCase() === "CONSTRAINT") {
      j += 2; // CONSTRAINT <name>
    }
    if (children[j] && textOf(text, children[j]!).toUpperCase() === "DO") {
      j++;
      const doWhat = children[j] ? textOf(text, children[j]!).toUpperCase() : "";
      if (doWhat === "NOTHING") return { writeColumns: [] };
      if (doWhat === "UPDATE") {
        j++;
        if (children[j] && textOf(text, children[j]!).toUpperCase() === "SET") j++;
        const { assignments } = parseAssignments(text, children, j, new Set(["WHERE", "RETURNING"]));
        return { writeColumns: assignments.map((a) => toColumnRef(a, targetRef)) };
      }
    }
    return { writeColumns: [] };
  }

  return null;
}

// ---------- UPDATE ----------

function extractUpdate(text: string, children: SyntaxNode[]): Omit<StatementFacts, "from" | "to"> {
  // children[0] = UPDATE 关键字。扫到 SET 为止的这段是目标表 (+ 可能的 JOIN)。
  const setIdx = findKeywordIndex(text, children, 1, new Set(["set"]));
  if (setIdx < 0) {
    return { operation: "update", readTables: [], writeTables: [], writeColumns: [], unresolved: ["dynamic"] };
  }

  const { tables: targetTables, aliases } = scanTableRefs(text, children, 1, setIdx, new Set());
  if (targetTables.length === 0) {
    return { operation: "update", readTables: [], writeTables: [], writeColumns: [], unresolved: ["dynamic"] };
  }

  const singleTable = targetTables.length === 1 ? targetTables[0]! : null;
  const { assignments, nextIndex } = parseAssignments(
    text,
    children,
    setIdx + 1,
    new Set(["from", "where", "returning"]),
  );

  const writeColumns = assignments.map((a) => {
    if (a.table) {
      const resolved = aliases.get(a.table) ?? { db: null, table: a.table };
      return { db: resolved.db, table: resolved.table, column: a.column };
    }
    if (singleTable) return { db: singleTable.db, table: singleTable.table, column: a.column };
    // 多表 UPDATE 且列没加前缀：无法归属到具体表，保留列名、table 置空。
    return { db: null, table: null, column: a.column };
  });

  // Postgres `UPDATE t SET ... FROM other WHERE ...`：FROM 后面的表是读的，不是写的。
  let readTables: TableRef[] = [];
  let i = nextIndex;
  if (children[i] && textOf(text, children[i]!).toLowerCase() === "from") {
    const stopAt = findKeywordIndex(text, children, i + 1, new Set(["where", "returning"]));
    const end = stopAt < 0 ? children.length : stopAt;
    readTables = scanTableRefs(text, children, i + 1, end, new Set()).tables;
  }

  return {
    operation: "update",
    readTables,
    writeTables: targetTables,
    writeColumns,
    unresolved: [],
  };
}

// ---------- DELETE ----------

function extractDelete(text: string, children: SyntaxNode[]): Omit<StatementFacts, "from" | "to"> {
  // `DELETE FROM t [WHERE ...]` 或 MySQL 多表 `DELETE t1[,t2] FROM t1 JOIN t2 ON ... WHERE ...`
  const fromIdx = findKeywordIndex(text, children, 1, new Set(["from"]));
  if (fromIdx < 0) {
    return { operation: "delete", readTables: [], writeTables: [], writeColumns: [], unresolved: ["dynamic"] };
  }

  const targetAliasNames = collectPlainIdentNames(text, children, 1, fromIdx);

  const stopAt = findKeywordIndex(text, children, fromIdx + 1, TABLE_SCAN_STOP_WORDS);
  const end = stopAt < 0 ? children.length : stopAt;
  const { tables, aliases } = scanTableRefs(text, children, fromIdx + 1, end, new Set());

  let writeTables = tables;
  if (targetAliasNames.length > 0) {
    // `DELETE t1 FROM t1 JOIN t2 ...`：只删 t1 别名对应的表，不是 join 里的全部表。
    const resolved = targetAliasNames
      .map((name) => aliases.get(name) ?? tables.find((t) => t.table === name) ?? null)
      .filter((t): t is TableRef => t !== null);
    if (resolved.length > 0) writeTables = resolved;
  }

  return { operation: "delete", readTables: [], writeTables, writeColumns: [], unresolved: [] };
}

// ---------- SELECT（给 readTables 用，facets / 过滤"读了某表"场景） ----------

function extractSelect(text: string, children: SyntaxNode[]): Omit<StatementFacts, "from" | "to"> {
  const fromIdx = findKeywordIndex(text, children, 1, new Set(["from"]));
  if (fromIdx < 0) {
    return { operation: "select", readTables: [], writeTables: [], writeColumns: [], unresolved: [] };
  }
  const stopAt = findKeywordIndex(text, children, fromIdx + 1, TABLE_SCAN_STOP_WORDS);
  const end = stopAt < 0 ? children.length : stopAt;
  const { tables } = scanTableRefs(text, children, fromIdx + 1, end, new Set());
  return { operation: "select", readTables: tables, writeTables: [], writeColumns: [], unresolved: [] };
}

// ---------- 表引用 / alias 扫描（借鉴 sql-scope.ts 的状态机，改为在纯数组上跑） ----------

function scanTableRefs(
  text: string,
  children: SyntaxNode[],
  start: number,
  end: number,
  extraStopWords: ReadonlySet<string>,
): { tables: TableRef[]; aliases: Map<string, TableRef> } {
  const tables: TableRef[] = [];
  const aliases = new Map<string, TableRef>();
  let expectTable = true;
  let prevId: SyntaxNode | null = null;
  let prevRef: TableRef | null = null;
  const aliasSources = new Set<SyntaxNode>();

  for (let idx = start; idx < end; idx++) {
    const node = children[idx]!;
    const kw = node.name === "Keyword" ? textOf(text, node).toLowerCase() : null;
    let aliasNode: SyntaxNode | null = null;

    if (kw && (TABLE_SCAN_STOP_WORDS.has(kw) || extraStopWords.has(kw))) break;

    if (kw === "as" && prevId && isPlainIdLike(children[idx + 1])) {
      aliasNode = children[idx + 1]!;
    } else if (kw === "join" || (kw && kw.endsWith("join"))) {
      expectTable = true;
    } else if (kw === "on" || kw === "using") {
      expectTable = false;
    } else if (kw) {
      // INNER / OUTER / NATURAL / CROSS / LATERAL 等修饰词：忽略，状态不变
    } else if (isPunct(text, node, ",")) {
      expectTable = true;
    } else if (prevId && isPlainIdLike(node)) {
      aliasNode = node;
    }

    if (aliasNode && prevId && prevRef) {
      aliases.set(idText(text, aliasNode), prevRef);
      aliasSources.add(aliasNode);
    }

    if (expectTable && isAnyIdLike(node) && !aliasSources.has(node)) {
      const ref = toTableRef(pathFor(text, node));
      if (ref) {
        tables.push(ref);
        prevRef = ref;
      } else {
        prevRef = null;
      }
      expectTable = false;
    }

    prevId = isAnyIdLike(node) ? node : null;
  }

  return { tables, aliases };
}

// ---------- SET col=expr[, col2=expr2...] 赋值列表 ----------

interface Assignment {
  table: string | null;
  column: string;
}

/**
 * 某些方言把常见列名收进了保留字表（典型例子：PostgreSQL 的 `CLUSTER`，本身是
 * `CLUSTER table [USING index]` 维护命令的关键字），lezer 会把它们 token 成
 * `Keyword` 而不是 `Identifier`，导致 `isColumnIdentLike` 判定失败、整条赋值被
 * 当成"无法识别的 token"跳过——SET 列表里这类赋值就会静默丢失。
 *
 * 由于这里已经严格限定在 SET 赋值列表的扫描窗口内（`stopWords` 已经拦掉了
 * FROM/WHERE/RETURNING 等真正的语句关键字），"关键字 token 紧跟着 `=`" 在这个
 * 上下文里唯一合理的解释就是它被当成列名用，可以放心当列名候选处理。
 */
function isAssignmentTargetLike(
  text: string,
  children: SyntaxNode[],
  i: number,
): boolean {
  const c = children[i]!;
  if (isColumnIdentLike(c)) return true;
  const next = children[i + 1];
  return c.name === "Keyword" && !!next && isOperatorEquals(text, next);
}

function parseAssignments(
  text: string,
  children: SyntaxNode[],
  start: number,
  stopWords: ReadonlySet<string>,
): { assignments: Assignment[]; nextIndex: number } {
  const assignments: Assignment[] = [];
  let i = start;
  while (i < children.length) {
    const c = children[i]!;
    if (c.name === "Keyword" && stopWords.has(textOf(text, c).toLowerCase())) break;
    if (isPunct(text, c, ",")) {
      i++;
      continue;
    }
    if (isAssignmentTargetLike(text, children, i)) {
      const path = pathFor(text, c);
      const column = path[path.length - 1]!;
      const table = path.length >= 2 ? path[path.length - 2]! : null;
      i++;
      if (children[i] && isOperatorEquals(text, children[i]!)) i++;
      // 跳过表达式（可能是多 token，如 `price + 1`），直到下一个逗号或停止词
      while (i < children.length) {
        const cc = children[i]!;
        if (isPunct(text, cc, ",")) break;
        if (cc.name === "Keyword" && stopWords.has(textOf(text, cc).toLowerCase())) break;
        i++;
      }
      assignments.push({ table, column });
      continue;
    }
    // 无法识别的 token（如 postgres 的元组赋值 `(a,b) = (...)`）：跳过，不强猜。
    i++;
  }
  return { assignments, nextIndex: i };
}

function toColumnRef(a: Assignment, fallback: TableRef | null): ColumnRef {
  if (a.table) return { db: null, table: a.table, column: a.column };
  return { db: fallback?.db ?? null, table: fallback?.table ?? null, column: a.column };
}

function mergeColumnRefs(a: ColumnRef[], b: ColumnRef[]): ColumnRef[] {
  return [...a, ...b];
}

// ---------- Parens 内的裸列名清单（INSERT 列清单 / ON CONFLICT 冲突列） ----------

function columnNamesFromParens(text: string, parens: SyntaxNode): string[] {
  const names: string[] = [];
  for (const c of childrenOf(parens)) {
    if (c.name === "(" || c.name === ")") continue;
    if (isPunct(text, c, ",")) continue;
    if (/Comment$/.test(c.name)) continue;
    // Postgres 下列名有时被误标成 Keyword（观察到的 lezer 歧义解析行为），
    // 这里放宽成"任何非括号/逗号 token 都当列名候选"，比严格类型判断更稳。
    const t = idText(text, c);
    if (t) names.push(t);
  }
  return names;
}

// ---------- DELETE 目标别名清单（`DELETE t1, t2 FROM ...`） ----------

function collectPlainIdentNames(
  text: string,
  children: SyntaxNode[],
  start: number,
  end: number,
): string[] {
  const names: string[] = [];
  for (let i = start; i < end; i++) {
    const c = children[i]!;
    if (isPunct(text, c, ",")) continue;
    if (isPlainIdLike(c)) names.push(idText(text, c));
  }
  return names;
}

// ---------- 节点级别工具 ----------

function childrenOf(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) out.push(c);
  return out;
}

function textOf(text: string, node: SyntaxNode): string {
  return text.slice(node.from, node.to);
}

function isPlainIdLike(node: SyntaxNode | null | undefined): boolean {
  return !!node && (node.name === "Identifier" || node.name === "QuotedIdentifier");
}

function isAnyIdLike(node: SyntaxNode): boolean {
  return /Identifier$/.test(node.name);
}

/** 表标识符候选：普通/引用标识符或复合路径（`db.table`）。 */
function isTableIdentLike(node: SyntaxNode): boolean {
  return isAnyIdLike(node);
}

/** 列名候选：与表标识符判定相同，语法层面本就不区分表/列标识符节点类型。 */
function isColumnIdentLike(node: SyntaxNode): boolean {
  return isAnyIdLike(node);
}

function isPunct(text: string, node: SyntaxNode, ch: string): boolean {
  return textOf(text, node) === ch;
}

function isOperatorEquals(text: string, node: SyntaxNode): boolean {
  return node.name === "Operator" && textOf(text, node) === "=";
}

/** 去掉标识符引号（`` ` `` / `"` / `'` / `[...]`），与 sql-scope.ts 的 idName 一致。 */
function idText(text: string, node: SyntaxNode): string {
  const raw = textOf(text, node);
  const quoted = /^([`'"[])(.*)([`'"\]])$/.exec(raw);
  return quoted ? quoted[2]! : raw;
}

function pathFor(text: string, node: SyntaxNode): string[] {
  if (node.name === "CompositeIdentifier") {
    const path: string[] = [];
    for (const ch of childrenOf(node)) {
      if (isPlainIdLike(ch)) path.push(idText(text, ch));
    }
    return path.length > 0 ? path : [textOf(text, node)];
  }
  return [idText(text, node)];
}

function toTableRef(path: string[]): TableRef | null {
  if (path.length === 0 || !path[0]) return null;
  if (path.length === 1) return { db: null, table: path[0]! };
  return { db: path[path.length - 2]!, table: path[path.length - 1]! };
}

function findKeywordIndex(
  text: string,
  children: SyntaxNode[],
  start: number,
  words: ReadonlySet<string>,
): number {
  for (let i = start; i < children.length; i++) {
    const c = children[i]!;
    if (c.name === "Keyword" && words.has(textOf(text, c).toLowerCase())) return i;
  }
  return -1;
}

function hasErrorDescendant(node: SyntaxNode): boolean {
  const cursor = node.cursor();
  do {
    if (cursor.type.isError) return true;
  } while (cursor.next());
  return false;
}
