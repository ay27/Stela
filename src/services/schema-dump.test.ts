/**
 * schema-dump 自运行测试。
 *
 * 本项目暂未接入 vitest（`npm test` 是 `tsx scripts/roundtrip-check.ts`），
 * 这里沿用 roundtrip-check.ts 的轻量 `expect()` 风格 —— 直接 `tsx` 跑：
 *
 *     npx tsx src/services/schema-dump.test.ts
 *
 * 覆盖三条路径（对齐 plan 2.5）：
 *   - 正常：2 db × 2 table → 4 次 SHOW CREATE TABLE → 4 次 writeFile
 *   - 单表失败：3 张表第 2 张抛错 → 剩下 2 张继续写，failed 列表含那张
 *   - 空库：listDatabases 全部是系统库 → ok=0，且不触发 writeFile
 */

import type { ConnectionEntry } from "@/services/connections";
import type { QueryResult } from "@/contracts";
import {
  dumpSchemaToMarkdown,
  renderMarkdown,
  pMap,
  type DumpOptions,
} from "./schema-dump";

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

function expect(name: string, ok: boolean, detail?: string): Check {
  return { name, ok, detail };
}

/** 生成一个 MySQL 风格的 SHOW CREATE TABLE query result。 */
function showCreateResult(table: string, ddl: string): QueryResult {
  return {
    kind: "query",
    columns: [
      { name: "Table", typeName: "VARCHAR" },
      { name: "Create Table", typeName: "VARCHAR" },
    ],
    rows: [[table, ddl]],
    elapsedMs: 1,
  };
}

interface MockRegistry {
  listDatabases: jest_like<[string, unknown], string[]>;
  listTables: jest_like<[string, unknown, string | undefined], string[]>;
  execute: jest_like<[string, unknown, string], QueryResult>;
}

/** 最小的 spy/mock：记录调用并按预设返回。 */
interface jest_like<Args extends unknown[], Ret> {
  calls: Args[];
  (...args: Args): Promise<Ret>;
}

function mockFn<Args extends unknown[], Ret>(
  impl: (...args: Args) => Ret | Promise<Ret>,
): jest_like<Args, Ret> {
  const calls: Args[] = [];
  const fn = async (...args: Args): Promise<Ret> => {
    calls.push(args);
    return Promise.resolve(impl(...args));
  };
  (fn as unknown as jest_like<Args, Ret>).calls = calls;
  return fn as unknown as jest_like<Args, Ret>;
}

/** 构造一个可控的 MockRegistry + writeFile 采集器 + 基础 entry。 */
function makeEnv(overrides: {
  dbs: string[];
  tables: Record<string, string[]>;
  // 若返回 null → 抛错；否则返回 ddl
  ddl?: (db: string, table: string) => string | null;
}) {
  const writes: Array<{ path: string; contents: string }> = [];
  const registry: MockRegistry = {
    listDatabases: mockFn<[string, unknown], string[]>(() => overrides.dbs),
    listTables: mockFn<[string, unknown, string | undefined], string[]>(
      (_k, _c, db) => overrides.tables[db ?? ""] ?? [],
    ),
    execute: mockFn<[string, unknown, string], QueryResult>((_k, _c, sql) => {
      // sql: SHOW CREATE TABLE `db`.`table`
      const m = /SHOW CREATE TABLE\s+`([^`]+)`\.`([^`]+)`/i.exec(sql);
      if (!m) throw new Error(`unexpected sql: ${sql}`);
      const db = m[1].replace(/``/g, "`");
      const table = m[2].replace(/``/g, "`");
      const ddl = overrides.ddl
        ? overrides.ddl(db, table)
        : `CREATE TABLE \`${table}\` (id INT)`;
      if (ddl === null) {
        throw new Error(`SHOW CREATE TABLE failed for ${db}.${table}`);
      }
      return showCreateResult(table, ddl);
    }),
  };
  const write = mockFn(async (path: string, contents: string) => {
    writes.push({ path, contents });
  });
  const entry: ConnectionEntry = { kind: "mysql", config: {} };
  const opts: DumpOptions = {
    connectionName: "test-conn",
    entry,
    schemaDir: "/tmp/stela-schemas",
    deps: {
      registry,
      writeFile: write,
      now: () => new Date(Date.UTC(2026, 3, 20, 12, 0, 0)),
    },
  };
  return { registry, write, writes, opts };
}

async function runPathA_happy(): Promise<Check[]> {
  const { registry, writes, opts } = makeEnv({
    dbs: ["information_schema", "prod", "analytics"],
    tables: {
      prod: ["users", "orders"],
      analytics: ["events", "funnels"],
    },
  });
  const report = await dumpSchemaToMarkdown(opts);

  const checks: Check[] = [];
  checks.push(expect("system schema 被过滤", !registry.listTables.calls.some(([, , db]) => db === "information_schema")));
  checks.push(expect("listTables 被调用 2 次（prod / analytics）", registry.listTables.calls.length === 2));
  checks.push(expect("execute 被调用 4 次", registry.execute.calls.length === 4));
  checks.push(expect("writeFile 被调用 4 次", writes.length === 4));
  checks.push(expect("report.ok == 4", report.ok === 4, `got ${report.ok}`));
  checks.push(expect("report.failed 为空", report.failed.length === 0));
  checks.push(expect("report.total == 4", report.total === 4));

  // 文件名按 db.table.md，且出现 DDL
  const paths = writes.map((w) => w.path).sort();
  const expectedPaths = [
    "/tmp/stela-schemas/analytics.events.md",
    "/tmp/stela-schemas/analytics.funnels.md",
    "/tmp/stela-schemas/prod.orders.md",
    "/tmp/stela-schemas/prod.users.md",
  ];
  checks.push(
    expect(
      "写入路径按 db.table.md 命名",
      JSON.stringify(paths) === JSON.stringify(expectedPaths),
      `got ${JSON.stringify(paths)}`,
    ),
  );
  const usersFile = writes.find((w) => w.path.endsWith("prod.users.md"));
  checks.push(expect("users 文件存在", !!usersFile));
  if (usersFile) {
    checks.push(
      expect(
        "users 文件内含标题 `prod`.`users`",
        usersFile.contents.includes("# `prod`.`users`"),
        usersFile.contents.slice(0, 200),
      ),
    );
    checks.push(
      expect(
        "users 文件内含 connection 名称",
        usersFile.contents.includes("test-conn"),
      ),
    );
    checks.push(
      expect(
        "users 文件内含 DDL",
        usersFile.contents.includes("CREATE TABLE `users`"),
      ),
    );
  }
  return checks;
}

async function runPathB_singleFailure(): Promise<Check[]> {
  const { writes, opts } = makeEnv({
    dbs: ["app"],
    tables: { app: ["users", "broken_view", "orders"] },
    ddl: (_db, table) =>
      table === "broken_view" ? null : `CREATE TABLE \`${table}\` (id INT)`,
  });
  const report = await dumpSchemaToMarkdown(opts);

  const checks: Check[] = [];
  checks.push(expect("成功写入 2 张表", writes.length === 2, `writes=${writes.length}`));
  checks.push(expect("report.ok == 2", report.ok === 2, `got ${report.ok}`));
  checks.push(expect("report.failed 有且仅有 1 条", report.failed.length === 1, JSON.stringify(report.failed)));
  if (report.failed[0]) {
    checks.push(expect("失败表名 = broken_view", report.failed[0].table === "broken_view"));
    checks.push(expect("失败 error message 非空", !!report.failed[0].error));
  }
  checks.push(
    expect(
      "失败的表不会产生 md 文件",
      !writes.some((w) => w.path.includes("broken_view")),
    ),
  );
  return checks;
}

async function runPathC_emptyDatabases(): Promise<Check[]> {
  const { registry, writes, opts } = makeEnv({
    // 全部是系统库；没有业务 schema
    dbs: ["information_schema", "performance_schema", "mysql", "sys"],
    tables: {},
  });
  const report = await dumpSchemaToMarkdown(opts);

  return [
    expect("不调用 listTables（无业务库）", registry.listTables.calls.length === 0),
    expect("不调用 execute（无业务库）", registry.execute.calls.length === 0),
    expect("不触发 writeFile", writes.length === 0),
    expect("report.ok == 0", report.ok === 0),
    expect("report.failed 为空", report.failed.length === 0),
    expect("report.total == 0", report.total === 0),
  ];
}

async function runPathD_unitHelpers(): Promise<Check[]> {
  const checks: Check[] = [];

  // renderMarkdown 输出结构稳定
  const md = renderMarkdown({
    db: "prod",
    table: "users",
    connectionName: "conn",
    ddl: "CREATE TABLE `users` (id INT)",
    now: new Date(Date.UTC(2026, 3, 20, 0, 0, 0)),
  });
  checks.push(expect("renderMarkdown 首行是标题", md.split("\n")[0] === "# `prod`.`users`"));
  checks.push(expect("renderMarkdown 包含 ```sql fence", md.includes("```sql\n")));

  // pMap 并发度不会超上限；全部任务都跑
  let running = 0;
  let peak = 0;
  const N = 10;
  await pMap(Array.from({ length: N }, (_, i) => i), 3, async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running -= 1;
  });
  checks.push(expect("pMap 并发峰值 <= concurrency", peak <= 3, `peak=${peak}`));

  // 空 items
  let touched = 0;
  await pMap([] as number[], 4, async () => {
    touched += 1;
  });
  checks.push(expect("pMap 空 items 不调用 fn", touched === 0));

  return checks;
}

async function main() {
  const sections: Array<[string, Promise<Check[]>]> = [
    ["path A: 2 db × 2 table happy path", runPathA_happy()],
    ["path B: single-table failure keeps going", runPathB_singleFailure()],
    ["path C: only system schemas (empty)", runPathC_emptyDatabases()],
    ["path D: render/pMap unit helpers", runPathD_unitHelpers()],
  ];

  let fails = 0;
  for (const [title, promise] of sections) {
    const results = await promise;
    console.log(`\n▶ ${title}`);
    for (const r of results) {
      if (r.ok) {
        console.log(`  ✓ ${r.name}`);
      } else {
        fails += 1;
        console.log(`  ✗ ${r.name}`);
        if (r.detail) console.log(`      ${r.detail}`);
      }
    }
  }
  if (fails > 0) {
    console.error(`\n${fails} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll schema-dump checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
