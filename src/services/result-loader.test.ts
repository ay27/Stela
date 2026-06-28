/**
 * result-loader 单元测试。
 *
 * 跑：
 *
 *     npx tsx src/services/result-loader.test.ts
 *
 * 守住执行历史结果集恢复链路：本测试证明"前端在本地缓存缺数据时会调一次
 * journal.importRun 并重读"。
 *
 * 不引入 jsdom / vitest；通过依赖注入 fake storage / fake journal，纯 Node 即可跑。
 */

import { fileURLToPath } from "node:url";

import type { ColumnDef } from "@/contracts";
import { loadResultPage, type ResultLoaderDeps } from "./result-loader";

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

function expect(name: string, ok: boolean, detail?: string): Check {
  return { name, ok, detail };
}

const SAMPLE_COLUMNS: ColumnDef[] = [
  { name: "id", typeName: "INT" },
  { name: "name", typeName: "VARCHAR" },
];

const SAMPLE_ROWS: unknown[][] = [
  [1, "alice"],
  [2, "bob"],
  [3, "carol"],
];

interface FakeStorageState {
  schema: ColumnDef[];
  rows: unknown[][];
}

interface FakeStorageCalls {
  getSchema: number;
  queryPage: number;
}

interface FakeStorage {
  storage: ResultLoaderDeps["storage"];
  calls: FakeStorageCalls;
  state: FakeStorageState;
}

/** 内存版 storage：getSchema / queryPage 都按当前 state 返回。 */
function makeStorage(initial: FakeStorageState): FakeStorage {
  const state: FakeStorageState = {
    schema: [...initial.schema],
    rows: initial.rows.map((r) => [...r]),
  };
  const calls: FakeStorageCalls = { getSchema: 0, queryPage: 0 };
  return {
    state,
    calls,
    storage: {
      async getSchema() {
        calls.getSchema += 1;
        return state.schema;
      },
      async queryPage(_runId, offset, limit) {
        calls.queryPage += 1;
        const total = state.rows.length;
        return {
          offset,
          limit,
          total,
          rows: state.rows.slice(offset, offset + limit),
        };
      },
    },
  };
}

interface FakeJournal {
  journal: ResultLoaderDeps["journal"];
  calls: { importRun: string[] };
}

/**
 * 内存版 journal。`onImport` 在每次调用时被触发：
 *   - 返回 boolean 表示是否找到并导入（同时副作用写到 storage 模拟回写效果）
 *   - 抛错表示导入过程错误
 */
function makeJournal(
  onImport: (runId: string) => Promise<boolean>,
): FakeJournal {
  const calls = { importRun: [] as string[] };
  return {
    calls,
    journal: {
      async importRun(runId) {
        calls.importRun.push(runId);
        return onImport(runId);
      },
    },
  };
}

async function runFastPath(): Promise<Check[]> {
  // 本地已有 schema + rows → 不应触发远端恢复。
  const out: Check[] = [];
  const fs = makeStorage({ schema: SAMPLE_COLUMNS, rows: SAMPLE_ROWS });
  const journal = makeJournal(async () => {
    throw new Error("should not be called");
  });
  const result = await loadResultPage(
    {
      runId: "r1",
      detailRowCount: 3,
      pageIndex: 0,
      pageSize: 10,
    },
    { storage: fs.storage, journal: journal.journal },
  );
  out.push(expect("fast path: recovered === false", result.recovered === false));
  out.push(expect("fast path: total === 3", result.total === 3));
  out.push(
    expect(
      "fast path: rows match original",
      JSON.stringify(result.rows) === JSON.stringify(SAMPLE_ROWS),
    ),
  );
  out.push(
    expect(
      "fast path: schema match original",
      JSON.stringify(result.schema) === JSON.stringify(SAMPLE_COLUMNS),
    ),
  );
  out.push(
    expect(
      "fast path: importRun not called",
      journal.calls.importRun.length === 0,
    ),
  );
  return out;
}

async function runRecoveryWhenEmpty(): Promise<Check[]> {
  // 本地空 + detail.rowCount > 0 → 应当触发一次 importRun，
  // pull 后再读，第二次 storage.* 必须返回新数据。
  const out: Check[] = [];
  const fs = makeStorage({ schema: [], rows: [] });
  const journal = makeJournal(async () => {
    // 模拟 main 端 importRun 写回 SQLite 的副作用
    fs.state.schema = SAMPLE_COLUMNS;
    fs.state.rows = SAMPLE_ROWS;
    return true;
  });
  const result = await loadResultPage(
    {
      runId: "r2",
      detailRowCount: 3,
      pageIndex: 0,
      pageSize: 10,
    },
    { storage: fs.storage, journal: journal.journal },
  );
  out.push(
    expect(
      "recovery: importRun called exactly once with runId",
      journal.calls.importRun.length === 1 &&
        journal.calls.importRun[0] === "r2",
      `actual=${JSON.stringify(journal.calls.importRun)}`,
    ),
  );
  out.push(
    expect("recovery: recovered === true", result.recovered === true),
  );
  out.push(expect("recovery: total === 3", result.total === 3));
  out.push(
    expect(
      "recovery: rows match restored",
      JSON.stringify(result.rows) === JSON.stringify(SAMPLE_ROWS),
    ),
  );
  // 第一次本地读 + pull 之后第二次本地读 → 至少 2 次 getSchema / 2 次 queryPage
  out.push(
    expect(
      "recovery: storage.getSchema called twice (before + after pull)",
      fs.calls.getSchema === 2,
      `actual=${fs.calls.getSchema}`,
    ),
  );
  out.push(
    expect(
      "recovery: storage.queryPage called twice (before + after pull)",
      fs.calls.queryPage === 2,
      `actual=${fs.calls.queryPage}`,
    ),
  );
  return out;
}

async function runNoRecoveryWhenZeroRows(): Promise<Check[]> {
  // mutation 或者真就 0 行的查询：detailRowCount === 0 时**不能**调远端，
  // 否则每次打开一个 mutation block 都会无谓地拉一次远端。
  const out: Check[] = [];
  const fs = makeStorage({ schema: [], rows: [] });
  const journal = makeJournal(async () => {
    throw new Error("must not pull when rowCount=0");
  });
  const result = await loadResultPage(
    {
      runId: "r3",
      detailRowCount: 0,
      pageIndex: 0,
      pageSize: 10,
    },
    { storage: fs.storage, journal: journal.journal },
  );
  out.push(
    expect(
      "no-pull: importRun not called",
      journal.calls.importRun.length === 0,
    ),
  );
  out.push(expect("no-pull: recovered === false", result.recovered === false));
  out.push(expect("no-pull: total === 0", result.total === 0));
  out.push(expect("no-pull: schema empty", result.schema.length === 0));
  return out;
}

async function runNoRecoveryWhenDetailMissing(): Promise<Check[]> {
  // detailRowCount === null（笔记里没有 detail / 还没运行过）→ 同样不拉。
  const out: Check[] = [];
  const fs = makeStorage({ schema: [], rows: [] });
  const journal = makeJournal(async () => {
    throw new Error("must not pull when rowCount is null");
  });
  const result = await loadResultPage(
    {
      runId: "r4",
      detailRowCount: null,
      pageIndex: 0,
      pageSize: 10,
    },
    { storage: fs.storage, journal: journal.journal },
  );
  out.push(
    expect(
      "no-pull-null: importRun not called",
      journal.calls.importRun.length === 0,
    ),
  );
  out.push(
    expect("no-pull-null: recovered === false", result.recovered === false),
  );
  return out;
}

async function runRecoveryWhenSchemaPresentButRowsEmpty(): Promise<Check[]> {
  // 半残状态：schema 存在但 rows 表被清空（例如手动改 sqlite 或 cleanup 触发了
  // FK CASCADE 异常）。detailRowCount > 0 时仍需要恢复。
  const out: Check[] = [];
  const fs = makeStorage({ schema: SAMPLE_COLUMNS, rows: [] });
  const journal = makeJournal(async () => {
    fs.state.rows = SAMPLE_ROWS;
    return true;
  });
  const result = await loadResultPage(
    {
      runId: "r5",
      detailRowCount: 3,
      pageIndex: 0,
      pageSize: 10,
    },
    { storage: fs.storage, journal: journal.journal },
  );
  out.push(
    expect(
      "half-empty: importRun called once",
      journal.calls.importRun.length === 1,
    ),
  );
  out.push(expect("half-empty: recovered === true", result.recovered === true));
  out.push(expect("half-empty: total === 3", result.total === 3));
  return out;
}

async function runPullErrorPropagates(): Promise<Check[]> {
  // 远端 importRun 抛错时，loader 应当把错误抛出去，让上层显示
  // "无法恢复"，而不是吞掉返回空表。
  const out: Check[] = [];
  const fs = makeStorage({ schema: [], rows: [] });
  const journal = makeJournal(async () => {
    throw Object.assign(new Error("not_found: result missing"), {
      code: "not_found",
    });
  });
  let captured: { code?: string; message?: string } | null = null;
  try {
    await loadResultPage(
      {
        runId: "r6",
        detailRowCount: 3,
        pageIndex: 0,
        pageSize: 10,
      },
      { storage: fs.storage, journal: journal.journal },
    );
  } catch (err) {
    const e = err as { code?: string; message?: string };
    captured = { code: e.code, message: e.message };
  }
  out.push(
    expect(
      "error: importRun was attempted",
      journal.calls.importRun.length === 1,
    ),
  );
  out.push(
    expect(
      "error: error propagated with code=not_found",
      captured !== null && captured.code === "not_found",
      `captured=${JSON.stringify(captured)}`,
    ),
  );
  return out;
}

async function runOnlyOneRecoveryAttemptPerCall(): Promise<Check[]> {
  // 防止"远端拉回来后 storage 仍然空"导致死循环：loader 必须保证一次 load 调用
  // 最多只触发一次 pull，即使第二次读还是空。
  const out: Check[] = [];
  const fs = makeStorage({ schema: [], rows: [] });
  const journal = makeJournal(async () => false); // 导入但 JSONL 里没有该 run
  const result = await loadResultPage(
    {
      runId: "r7",
      detailRowCount: 3,
      pageIndex: 0,
      pageSize: 10,
    },
    { storage: fs.storage, journal: journal.journal },
  );
  out.push(
    expect(
      "single-attempt: importRun called exactly once",
      journal.calls.importRun.length === 1,
    ),
  );
  out.push(
    expect("single-attempt: recovered flag true", result.recovered === true),
  );
  out.push(expect("single-attempt: total still 0", result.total === 0));
  return out;
}

async function main(): Promise<void> {
  const sections: Array<[string, () => Promise<Check[]>]> = [
    ["fast path: local schema + rows", runFastPath],
    ["recovery: empty local + detail rowCount > 0", runRecoveryWhenEmpty],
    ["no-pull: rowCount === 0", runNoRecoveryWhenZeroRows],
    ["no-pull: detail missing (rowCount null)", runNoRecoveryWhenDetailMissing],
    [
      "recovery: schema present but rows empty",
      runRecoveryWhenSchemaPresentButRowsEmpty,
    ],
    ["error: importRun throws", runPullErrorPropagates],
    [
      "single attempt: pull called at most once per load",
      runOnlyOneRecoveryAttemptPerCall,
    ],
  ];
  let failed = 0;
  for (const [title, fn] of sections) {
    const checks = await fn();
    console.log(`\n▶ ${title}`);
    for (const c of checks) {
      if (c.ok) {
        console.log(`  ✓ ${c.name}`);
      } else {
        failed += 1;
        console.log(`  ✗ ${c.name}`);
        if (c.detail) console.log(`      ${c.detail}`);
      }
    }
  }
  if (failed > 0) {
    console.error(`\nresult-loader tests FAILED (${failed}).`);
    process.exit(1);
  }
  console.log("\nAll result-loader checks passed.");
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  fileURLToPath(import.meta.url) === process.argv[1]
) {
  void main();
}
