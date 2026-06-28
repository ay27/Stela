/**
 * sql-scope 单测（光标作用域 / alias 解析）。
 *
 *     npx tsx src/editor/runsql/sql-scope.test.ts
 *
 * 覆盖：
 *   - getCompletionPath：顶层、`alias.`、`alias.col` 三种光标位置的 parents / prefix
 *   - extractScope：单表别名 / 多表 JOIN / 隐式 alias / db.table.alias / ON 子句
 *     不污染表集合
 *   - resolveTargetTable：alias 命中 / 直接 db.table / 单段表名兜底
 *   - buildTopLevelOptions：legacy fuzzy 表名 + 关键字 + sibling 行为回归
 */
import { sql } from "@codemirror/lang-sql";
import { EditorState } from "@codemirror/state";

import {
  extractScope,
  getCompletionPath,
  resolveTargetTable,
} from "./sql-scope";
import { buildTopLevelOptions, topLevelValidFor } from "./sql-language";
import { columnsFromDescribeResult } from "./fetch-columns";

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

function expect(name: string, ok: boolean, detail?: string): Check {
  return { name, ok, detail };
}

function makeState(text: string): EditorState {
  return EditorState.create({ doc: text, extensions: [sql()] });
}

/**
 * 用 `|` 标光标位置，返回去掉 `|` 后的 doc 与光标 offset。
 * 例： `"SELECT o.|"` → { doc: "SELECT o.", pos: 9 }
 */
function withCursor(template: string): { doc: string; pos: number } {
  const pos = template.indexOf("|");
  if (pos < 0) throw new Error(`template missing cursor marker: ${template}`);
  const doc = template.slice(0, pos) + template.slice(pos + 1);
  return { doc, pos };
}

const results: Check[] = [];

// ----- getCompletionPath -----

{
  const { doc, pos } = withCursor("SELECT id FROM use|");
  const state = makeState(doc);
  const p = getCompletionPath(state, pos);
  results.push(
    expect(
      "getCompletionPath: 顶层 token 不带前缀",
      p.parents.length === 0 && p.prefix === "use",
      JSON.stringify(p),
    ),
  );
}

{
  const { doc, pos } = withCursor("SELECT o.| FROM orders o");
  const state = makeState(doc);
  const p = getCompletionPath(state, pos);
  results.push(
    expect(
      "getCompletionPath: alias. 后 parents=[o]、prefix 空",
      p.parents.length === 1 && p.parents[0] === "o" && p.prefix === "",
      JSON.stringify(p),
    ),
  );
}

{
  const { doc, pos } = withCursor("SELECT o.na| FROM orders o");
  const state = makeState(doc);
  const p = getCompletionPath(state, pos);
  results.push(
    expect(
      "getCompletionPath: alias.col 部分 prefix",
      p.parents.length === 1 && p.parents[0] === "o" && p.prefix === "na",
      JSON.stringify(p),
    ),
  );
}

{
  const { doc, pos } = withCursor("SELECT threed.orders.| FROM threed.orders");
  const state = makeState(doc);
  const p = getCompletionPath(state, pos);
  results.push(
    expect(
      "getCompletionPath: db.table. 后 parents=[db,table]",
      p.parents.length === 2 &&
        p.parents[0] === "threed" &&
        p.parents[1] === "orders" &&
        p.prefix === "",
      JSON.stringify(p),
    ),
  );
}

// ----- extractScope: alias 解析 -----

{
  const state = makeState("SELECT id FROM orders o WHERE o.id = 1");
  const scope = extractScope(state, state.doc.length);
  results.push(
    expect(
      "extractScope: 单表隐式 alias",
      scope.aliases.o?.length === 1 &&
        scope.aliases.o[0] === "orders" &&
        scope.tables.length === 1 &&
        scope.tables[0].join(".") === "orders",
      JSON.stringify(scope),
    ),
  );
}

{
  const state = makeState(
    "SELECT * FROM threed.orders o JOIN threed.users AS u ON o.user_id = u.id",
  );
  const scope = extractScope(state, state.doc.length);
  results.push(
    expect(
      "extractScope: JOIN + 显式 AS + 隐式 alias + db.table",
      scope.aliases.o?.join(".") === "threed.orders" &&
        scope.aliases.u?.join(".") === "threed.users" &&
        scope.tables.length === 2 &&
        scope.tables[0].join(".") === "threed.orders" &&
        scope.tables[1].join(".") === "threed.users",
      JSON.stringify(scope),
    ),
  );
}

{
  const state = makeState("SELECT * FROM users, orders o WHERE o.id = 1");
  const scope = extractScope(state, state.doc.length);
  results.push(
    expect(
      "extractScope: 逗号分隔多表 + 部分 alias",
      scope.tables.length === 2 &&
        scope.tables[0][0] === "users" &&
        scope.tables[1][0] === "orders" &&
        scope.aliases.o?.[0] === "orders" &&
        !scope.aliases.users,
      JSON.stringify(scope),
    ),
  );
}

{
  const state = makeState(
    "SELECT * FROM orders o JOIN line_items li ON o.id = li.order_id WHERE o.total > 100",
  );
  const scope = extractScope(state, state.doc.length);
  results.push(
    expect(
      "extractScope: ON 子句里的 alias.col 不被误收成表",
      scope.tables.length === 2 &&
        scope.tables.map((t) => t.join(".")).join("|") ===
          "orders|line_items",
      JSON.stringify(scope.tables),
    ),
  );
}

// ----- resolveTargetTable -----

{
  const r = resolveTargetTable(["o"], { o: ["threed", "orders"] });
  results.push(
    expect(
      "resolveTargetTable: alias → db.table",
      r?.db === "threed" && r?.table === "orders",
      JSON.stringify(r),
    ),
  );
}

{
  const r = resolveTargetTable(["o"], { o: ["users"] });
  results.push(
    expect(
      "resolveTargetTable: alias → 单段表（db 为 null）",
      r?.db === null && r?.table === "users",
      JSON.stringify(r),
    ),
  );
}

{
  const r = resolveTargetTable(["threed", "orders"], {});
  results.push(
    expect(
      "resolveTargetTable: 直接 db.table",
      r?.db === "threed" && r?.table === "orders",
      JSON.stringify(r),
    ),
  );
}

{
  const r = resolveTargetTable(["users"], {});
  results.push(
    expect(
      "resolveTargetTable: 无 alias 单段 fallback 当作 table",
      r?.db === null && r?.table === "users",
      JSON.stringify(r),
    ),
  );
}

{
  const r = resolveTargetTable([], {});
  results.push(
    expect("resolveTargetTable: 空 parents → null", r === null),
  );
}

// ----- buildTopLevelOptions: legacy fuzzy 行为回归 -----

{
  const opts = buildTopLevelOptions("wh", [], []);
  results.push(
    expect(
      "buildTopLevelOptions: 前缀大写匹配关键字 WHERE",
      opts.some((o) => o.label === "WHERE"),
    ),
  );
}

{
  const opts = buildTopLevelOptions(
    "threed.ta",
    ["threed.task_table", "threed.asset_table", "other.task_table"],
    [],
  );
  results.push(
    expect(
      "buildTopLevelOptions: 带点的 prefix 只命中前缀匹配",
      opts.some((o) => o.label === "threed.task_table") &&
        !opts.some((o) => o.label === "other.task_table"),
      JSON.stringify(opts.map((o) => o.label)),
    ),
  );
}

{
  const opts = buildTopLevelOptions(
    "external",
    [
      "threed.external_game_assets_mobile_v3",
      "threed.asset_mapping",
    ],
    [],
  );
  results.push(
    expect(
      "buildTopLevelOptions: substring 模糊匹配",
      opts.some(
        (o) => o.label === "threed.external_game_assets_mobile_v3",
      ),
      JSON.stringify(opts.map((o) => o.label)),
    ),
  );
}

{
  const opts = buildTopLevelOptions(
    "gamv3",
    [
      "threed.external_game_assets_mobile_v3",
      "threed.graph_meta_v1",
    ],
    [],
  );
  results.push(
    expect(
      "buildTopLevelOptions: 子序列 fuzzy 匹配",
      opts.some(
        (o) => o.label === "threed.external_game_assets_mobile_v3",
      ),
    ),
  );
}

{
  // sibling word：从 SELECT col1, col2 抽 ident，要求 prefix 起始字母匹配
  const opts = buildTopLevelOptions(
    "col",
    [],
    ["SELECT col_alpha, col_beta FROM t"],
  );
  const labels = opts.map((o) => o.label);
  results.push(
    expect(
      "buildTopLevelOptions: sibling word-based 提取 identifier",
      labels.includes("col_alpha") && labels.includes("col_beta"),
      JSON.stringify(labels),
    ),
  );
}

{
  results.push(
    expect(
      "topLevelValidFor: 裸顶层 token 遇到点号应失效以重算字段上下文",
      !topLevelValidFor([]).test("o.") && topLevelValidFor([]).test("orders"),
    ),
  );
}

{
  results.push(
    expect(
      "topLevelValidFor: 点号上下文 fallback 仍允许 db.table 表名前缀",
      topLevelValidFor(["db"]).test("db.ta"),
    ),
  );
}

{
  const cols = columnsFromDescribeResult({
    kind: "query",
    columns: [
      { name: "Field", typeName: "VARCHAR" },
      { name: "Type", typeName: "VARCHAR" },
      { name: "Null", typeName: "VARCHAR" },
    ],
    rows: [
      ["task_id", "bigint", "NO"],
      ["task_name", "varchar(255)", "YES"],
    ],
    elapsedMs: 1,
  });
  results.push(
    expect(
      "columnsFromDescribeResult: 从 DESCRIBE 结果解析字段名和类型",
      cols.length === 2 &&
        cols[0].name === "task_id" &&
        cols[0].typeName === "bigint" &&
        cols[1].name === "task_name",
      JSON.stringify(cols),
    ),
  );
}

// ----- 汇总 -----

let failed = 0;
for (const r of results) {
  if (r.ok) {
    console.log(`  ok  ${r.name}`);
  } else {
    failed += 1;
    console.log(`  !!! ${r.name}${r.detail ? `   → ${r.detail}` : ""}`);
  }
}
console.log(
  `\nsql-scope.test.ts: ${results.length - failed}/${results.length} passed`,
);
if (failed > 0) process.exit(1);
