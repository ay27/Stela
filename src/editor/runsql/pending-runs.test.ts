import {
  beginPendingRun,
  clearPendingRunsForTab,
  endPendingRun,
  isRunsqlBlockPending,
} from "./pending-runs";

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

function expect(name: string, ok: boolean, detail?: string): Check {
  return { name, ok, detail };
}

const results: Check[] = [];

{
  clearPendingRunsForTab("tab-a");
  const runKey = beginPendingRun({
    tabId: "tab-a",
    blockId: "blk_a",
    blockIndex: 0,
    sql: "SELECT 1",
  });
  results.push(
    expect(
      "pending: blockId match survives remount",
      isRunsqlBlockPending({
        tabId: "tab-a",
        blockId: "blk_a",
        blockIndex: 9,
        sql: "SELECT changed",
      }),
    ),
  );
  endPendingRun(runKey);
}

{
  clearPendingRunsForTab("tab-b");
  const runKey = beginPendingRun({
    tabId: "tab-b",
    blockId: null,
    blockIndex: 1,
    sql: "SELECT 2",
  });
  results.push(
    expect(
      "pending: no blockId falls back to blockIndex + SQL",
      isRunsqlBlockPending({
        tabId: "tab-b",
        blockId: null,
        blockIndex: 1,
        sql: "  SELECT 2\n",
      }) &&
        !isRunsqlBlockPending({
          tabId: "tab-b",
          blockId: null,
          blockIndex: 0,
          sql: "SELECT 2",
        }),
    ),
  );
  endPendingRun(runKey);
}

{
  clearPendingRunsForTab("tab-c");
  const runKey = beginPendingRun({
    tabId: "tab-c",
    blockId: "blk_c",
    blockIndex: 0,
    sql: "SELECT 3",
  });
  endPendingRun(runKey);
  results.push(
    expect(
      "pending: end removes running state",
      !isRunsqlBlockPending({
        tabId: "tab-c",
        blockId: "blk_c",
        blockIndex: 0,
        sql: "SELECT 3",
      }),
    ),
  );
}

let failed = 0;
for (const r of results) {
  if (r.ok) {
    console.log(`  ok  ${r.name}`);
  } else {
    failed += 1;
    console.log(`  !!! ${r.name}${r.detail ? `   -> ${r.detail}` : ""}`);
  }
}
console.log(
  `\npending-runs.test.ts: ${results.length - failed}/${results.length} passed`,
);
if (failed > 0) process.exit(1);
