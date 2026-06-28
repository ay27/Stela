/**
 * RunSQL 补全的"作用域 / 上下文"解析。
 *
 * 改写自 `@codemirror/lang-sql` 的 [`src/complete.ts`](https://github.com/codemirror/lang-sql/blob/main/src/complete.ts)
 * （MIT），只保留 Stela 真正用到的两块：
 *
 *   1. `getCompletionPath(state, pos)`：定位光标处的 `parents` 标识符路径与
 *      `prefix` 当前 token —— 用来区分 "顶层 / 表名" vs "alias.col / db.table.col"。
 *   2. `extractAliasMap(state, pos)`：扫光标所在 Statement 的 FROM / JOIN 子句，
 *      建立 `alias -> identifier path` 映射 —— 用来把 `SELECT o.id FROM orders o`
 *      中的 `o` 解析回 `orders`。
 *
 * 几点边界与已知限制（写在 plan 的"已知限制"里）：
 *   - 子查询 / CTE：lang-sql 的 statement 扫描只覆盖最外层 Statement 的 FROM 链；
 *     `WITH x AS (...)` 内层 alias 解析不保证。
 *   - 标识符引号：与侧栏一致，仅做最基础的 `\`""[\` 去引号；MSSQL `[name]`
 *     可识别为标识符。
 *   - JOIN 后 ON / USING 子句出现的 `alias.col` 不会被错收成表，靠
 *     `expectTable` 状态机维持。
 */
import { syntaxTree } from "@codemirror/language";
import type { EditorState, Text } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";

export interface CompletionPath {
  /** 光标前已敲的标识符路径，自顶向下；空数组表示在顶层（没有 `xxx.` 前缀）。 */
  parents: string[];
  /** 当前位置的待补全 token 文本（可能为空字符串）。 */
  prefix: string;
  /** 替换起点（CompletionResult.from）。 */
  from: number;
}

export interface SqlScope {
  /** alias 名 → 真实标识符路径（["db","table"] 或 ["table"]）。 */
  aliases: Record<string, string[]>;
  /** 当前 Statement 的 FROM / JOIN 子句中实际出现的表（去重前，按出现顺序）。 */
  tables: string[][];
}

const END_FROM = new Set(
  "where group having order union intersect except all distinct limit offset fetch for"
    .split(" "),
);

function isPlainID(node: SyntaxNode | null | undefined): boolean {
  return (
    !!node &&
    (node.name === "Identifier" || node.name === "QuotedIdentifier")
  );
}

function isAnyID(name: string): boolean {
  return /Identifier$/.test(name);
}

function idName(doc: Text, node: SyntaxNode): string {
  const text = doc.sliceString(node.from, node.to);
  const quoted = /^([`'"\[])(.*)([`'"\]])$/.exec(text);
  return quoted ? quoted[2] : text;
}

function pathFor(doc: Text, id: SyntaxNode): string[] {
  if (id.name === "CompositeIdentifier") {
    const path: string[] = [];
    for (let ch = id.firstChild; ch; ch = ch.nextSibling) {
      if (isPlainID(ch)) path.push(idName(doc, ch));
    }
    return path;
  }
  return [idName(doc, id)];
}

function tokenBefore(tree: SyntaxNode): SyntaxNode {
  let cursor = tree.cursor().moveTo(tree.from, -1);
  while (/Comment/.test(cursor.name)) cursor.moveTo(cursor.from, -1);
  return cursor.node;
}

/** 沿"."向左收集 `a.b.c` 的前缀路径 `[a, b]`。node 是一个 "." 节点。 */
function parentsFor(doc: Text, node: SyntaxNode | null): string[] {
  const path: string[] = [];
  let cur: SyntaxNode | null = node;
  while (cur && cur.name === ".") {
    const name = tokenBefore(cur);
    if (!isPlainID(name)) return path;
    path.unshift(idName(doc, name));
    cur = tokenBefore(name);
  }
  return path;
}

/**
 * 计算光标位置的补全上下文路径。
 *
 *   - 光标在 `users.id|`：node = Identifier("id") → parents=["users"], prefix="id"
 *   - 光标在 `users.|`：node = "."  → parents=["users"], prefix=""
 *   - 光标在 `use|`：node = Identifier → parents=[], prefix="use"
 *   - 光标在空白处：parents=[], prefix=""
 */
export function getCompletionPath(
  state: EditorState,
  pos: number,
): CompletionPath {
  const node = syntaxTree(state).resolveInner(pos, -1);
  if (
    node.name === "Identifier" ||
    node.name === "QuotedIdentifier" ||
    node.name === "Keyword"
  ) {
    return {
      from: node.from,
      prefix: state.doc.sliceString(node.from, pos),
      parents: parentsFor(state.doc, tokenBefore(node)),
    };
  }
  if (node.name === ".") {
    return {
      from: pos,
      prefix: "",
      parents: parentsFor(state.doc, node),
    };
  }
  return { from: pos, prefix: "", parents: [] };
}

function findStatement(node: SyntaxNode | null): SyntaxNode | null {
  let cur: SyntaxNode | null = node;
  while (cur && cur.name !== "Statement") cur = cur.parent;
  return cur;
}

function nodeText(state: EditorState, node: SyntaxNode): string {
  return state.doc.sliceString(node.from, node.to);
}

/**
 * 扫光标所在 Statement 的 FROM / JOIN 部分，提取 alias→path 与表列表。
 *
 * 状态机：
 *   - `sawFrom`：遇到第一个 `FROM` 后置 true；之后进入"FROM 段"。
 *   - `expectTable`：下一个标识符应该被识别为"表"。
 *       FROM / JOIN / "," 之后置 true；
 *       识别出表之后置 false（下一个标识符会被识别为 alias）；
 *       ON / USING 之后置 false（其中的 ident 是列引用而非表）。
 *   - `prevID`：紧邻的上一个标识符节点。下一个标识符若进 alias 分支，
 *     就是 prevID 的 alias。
 *
 * END_FROM 集合里的关键字（WHERE / GROUP / ORDER 等）直接结束本次扫描。
 */
export function extractScope(state: EditorState, pos: number): SqlScope {
  const innermost = syntaxTree(state).resolveInner(pos, -1);
  const statement = findStatement(innermost);
  const result: SqlScope = { aliases: {}, tables: [] };
  if (!statement) return result;

  let sawFrom = false;
  let expectTable = false;
  let prevID: SyntaxNode | null = null;
  const aliasSources = new Set<SyntaxNode>();

  for (
    let scan: SyntaxNode | null = statement.firstChild;
    scan;
    scan = scan.nextSibling
  ) {
    const kw =
      scan.name === "Keyword" ? nodeText(state, scan).toLowerCase() : null;
    let aliasNode: SyntaxNode | null = null;

    if (!sawFrom) {
      if (kw === "from") {
        sawFrom = true;
        expectTable = true;
      }
    } else if (kw === "as" && prevID && isPlainID(scan.nextSibling)) {
      aliasNode = scan.nextSibling;
    } else if (kw && END_FROM.has(kw)) {
      break;
    } else if (kw === "join" || (kw && kw.endsWith("join"))) {
      expectTable = true;
    } else if (kw === "on" || kw === "using") {
      expectTable = false;
    } else if (kw) {
      // 其它 FROM 段内关键字（如 OUTER / NATURAL 单独成 token）：不变更状态
    } else if (
      scan.name !== "Identifier" &&
      scan.name !== "QuotedIdentifier" &&
      scan.name !== "CompositeIdentifier" &&
      nodeText(state, scan) === ","
    ) {
      // `,` 分隔的下一张表
      expectTable = true;
    } else if (prevID && isPlainID(scan)) {
      aliasNode = scan;
    }

    if (aliasNode && prevID) {
      result.aliases[idName(state.doc, aliasNode)] = pathFor(
        state.doc,
        prevID,
      );
      aliasSources.add(aliasNode);
    }

    if (
      sawFrom &&
      expectTable &&
      isAnyID(scan.name) &&
      !aliasSources.has(scan)
    ) {
      result.tables.push(pathFor(state.doc, scan));
      // 收完一张表后，下一个紧邻 ident 是它的 alias，不再是新表
      expectTable = false;
    }

    prevID = isAnyID(scan.name) ? scan : null;
  }

  return result;
}

/** 仅返回 alias→path 映射，等价于 `extractScope(...).aliases`，调用方更短。 */
export function extractAliasMap(
  state: EditorState,
  pos: number,
): Record<string, string[]> {
  return extractScope(state, pos).aliases;
}

/**
 * 把 `parents` 与 alias 表合并，解析为"目标表"（用来取列）。
 *
 *   - `parents = ["o"]` + alias `o → ["threed","orders"]` → `{db:"threed", table:"orders"}`
 *   - `parents = ["users"]`（无 alias 命中） → `{db:null, table:"users"}`
 *   - `parents = ["threed", "orders"]` → `{db:"threed", table:"orders"}`
 *   - `parents = ["a", "b", "c"]` → 取末尾两段 `{db:"b", table:"c"}`
 *
 * 返回 null 表示无法解析（空 parents 或异常路径）。
 */
export function resolveTargetTable(
  parents: string[],
  aliases: Record<string, string[]>,
): { db: string | null; table: string } | null {
  if (parents.length === 0) return null;

  if (parents.length === 1) {
    const aliasPath = aliases[parents[0]];
    if (aliasPath && aliasPath.length > 0) {
      if (aliasPath.length === 1) return { db: null, table: aliasPath[0] };
      return {
        db: aliasPath[aliasPath.length - 2],
        table: aliasPath[aliasPath.length - 1],
      };
    }
    return { db: null, table: parents[0] };
  }

  return {
    db: parents[parents.length - 2],
    table: parents[parents.length - 1],
  };
}
