/**
 * result-diff 单测（纯 Node，tsx 直跑）：
 *
 *     npx tsx src/services/result-diff.test.ts
 *
 * 覆盖：单行聚合（行号对齐）、多行有 key、无 key 退化、schema 漂移。
 */

import type { ColumnDef } from "@/contracts";
import { computeResultDiff } from "./result-diff";

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

const checks: Check[] = [];
function expect(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, detail });
}

function cols(...names: string[]): ColumnDef[] {
  return names.map((name) => ({ name, typeName: "TEXT" }));
}

// 1) 单行聚合监控 SQL：按行号对齐，列级值比对
{
  const left = { columns: cols("total", "done"), rows: [[300, 141]] };
  const right = { columns: cols("total", "done"), rows: [[300, 142]] };
  const diff = computeResultDiff(left, right);
  expect("单行: keyColumns 为空（行号对齐）", diff.keyColumns.length === 0);
  expect("单行: 1 个 matched 行", diff.rows.length === 1 && diff.rows[0].kind === "matched");
  expect(
    "单行: done 变更被标 changed",
    diff.rows[0].cells[0] === "same" && diff.rows[0].cells[1] === "changed",
    diff.rows[0].cells.join(","),
  );
  expect("单行: changedCells=1", diff.stats.changedCells === 1, `${diff.stats.changedCells}`);
  expect("单行: changed=1", diff.stats.changed === 1);
}

// 2) 多行有唯一 key 列：按 key 对齐，含增删改
{
  const left = {
    columns: cols("id", "val"),
    rows: [
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ],
  };
  const right = {
    columns: cols("id", "val"),
    rows: [
      ["a", 1], // same
      ["b", 20], // changed
      ["d", 4], // added
    ],
  };
  const diff = computeResultDiff(left, right);
  expect("多行: 推断出 key=id", diff.keyColumns.join(",") === "id", diff.keyColumns.join(","));
  expect("多行: added=1", diff.stats.added === 1, `${diff.stats.added}`);
  expect("多行: removed=1（c 消失）", diff.stats.removed === 1, `${diff.stats.removed}`);
  expect("多行: changed=1（b 变）", diff.stats.changed === 1, `${diff.stats.changed}`);
  // 顺序：right 顺序 matched/added 在前，removed 追加末尾
  const kinds = diff.rows.map((r) => r.kind).join(",");
  expect("多行: 顺序 matched,matched,added,removed", kinds === "matched,matched,added,removed", kinds);
}

// 3) 用户指定 key 列覆盖推断
{
  const left = {
    columns: cols("region", "cnt"),
    rows: [
      ["us", 10],
      ["eu", 20],
    ],
  };
  const right = {
    columns: cols("region", "cnt"),
    rows: [
      ["eu", 25],
      ["us", 10],
    ],
  };
  const diff = computeResultDiff(left, right, { keyColumns: ["region"] });
  expect("指定key: 无增删", diff.stats.added === 0 && diff.stats.removed === 0);
  expect("指定key: eu 变更", diff.stats.changed === 1, `${diff.stats.changed}`);
}

// 4) schema 漂移：右侧多一列
{
  const left = { columns: cols("id", "a"), rows: [["x", 1]] };
  const right = { columns: cols("id", "a", "b"), rows: [["x", 1, 9]] };
  const diff = computeResultDiff(left, right);
  expect("漂移: schemaMatch=false", diff.schemaMatch === false);
  expect("漂移: 并集 3 列", diff.columns.length === 3, `${diff.columns.length}`);
  const bCol = diff.columns.find((c) => c.name === "b");
  expect("漂移: b 列 inLeft=false inRight=true", !!bCol && !bCol.inLeft && bCol.inRight);
  // matched 行里 b 单元格标 added
  const row = diff.rows[0];
  expect("漂移: b 单元格 added", row.cells[2] === "added", row.cells.join(","));
}

// 5) rowCap 截断
{
  const mk = (n: number, base: number) =>
    Array.from({ length: n }, (_, i) => [`k${i}`, base + i]);
  const left = { columns: cols("id", "v"), rows: mk(10, 0) };
  const right = { columns: cols("id", "v"), rows: mk(10, 0) };
  const diff = computeResultDiff(left, right, { rowCap: 3 });
  expect("rowCap: 仅比对前 3 行", diff.rows.length === 3, `${diff.rows.length}`);
}

const passed = checks.filter((c) => c.ok).length;
const failed = checks.length - passed;
for (const c of checks) {
  console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
