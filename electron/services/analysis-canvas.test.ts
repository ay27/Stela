import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseAnalysisCanvas, stringifyAnalysisCanvas } from "@shared/analysis-canvas";
import { analysisCanvasSqlIssue, createAnalysisCanvas, readAnalysisCanvas, refreshAnalysisCanvasSource, updateAnalysisCanvas, updateAnalysisCanvasFlowLayout } from "./analysis-canvas";

assert.match(
  analysisCanvasSqlIssue("SELECT 'Stage A' AS stage, 10 AS count UNION ALL SELECT 'Stage B', 5") ?? "",
  /real table/,
);
assert.match(
  analysisCanvasSqlIssue("WITH totals AS (SELECT 10 AS count) SELECT * FROM totals") ?? "",
  /real table/,
);
assert.equal(
  analysisCanvasSqlIssue("WITH totals AS (SELECT COUNT(*) AS count FROM sales) SELECT * FROM totals"),
  null,
);

const root = await mkdtemp(join(tmpdir(), "stela-canvas-"));
try {
  const created = await createAnalysisCanvas(root, root, "Revenue", "sess_1");
  assert.match(created.path, /Revenue\.stela\.canvas$/);
  const base = parseAnalysisCanvas(created.content);
  const withSource = await updateAnalysisCanvas(root, created.path, created.etag, (canvas) => ({ ...canvas, sources: [{ id: "sales", title: "Sales", connectionName: "prod", sql: "select amount from sales", lastRunId: null, lastRunAt: null, lastError: null }] }));
  await assert.rejects(() => updateAnalysisCanvas(root, created.path, created.etag, (canvas) => canvas), /changed on disk/);
  const records: string[] = [];
  const refreshed = await refreshAnalysisCanvasSource(root, created.path, withSource.etag, "sales", {
    execute: async () => ({ kind: "query", columns: [{ name: "amount", typeName: "INT" }], rows: [[10]], elapsedMs: 2 }),
    record: async (record) => { records.push(record.runId); },
  });
  assert.equal(refreshed.ok, true);
  assert.equal(parseAnalysisCanvas(refreshed.content).sources[0]?.lastRunId, refreshed.runId);
  assert.equal(records.length, 1);
  const failed = await refreshAnalysisCanvasSource(root, created.path, refreshed.etag, "sales", {
    execute: async () => { throw new Error("warehouse unavailable"); },
    record: async () => {},
  });
  assert.equal(failed.ok, false);
  assert.equal(parseAnalysisCanvas(failed.content).sources[0]?.lastRunId, refreshed.runId);
  assert.match(parseAnalysisCanvas(failed.content).sources[0]?.lastError?.message ?? "", /warehouse unavailable/);
  const mutation = { ...parseAnalysisCanvas(failed.content), sources: [{ ...parseAnalysisCanvas(failed.content).sources[0]!, sql: "delete from sales" }] };
  const mutated = await updateAnalysisCanvas(root, created.path, failed.etag, () => mutation);
  await assert.rejects(() => refreshAnalysisCanvasSource(root, created.path, mutated.etag, "sales", { execute: async () => ({ kind: "query", columns: [], rows: [], elapsedMs: 1 }), record: async () => {} }), /blocked/);
  const withFlow = await updateAnalysisCanvas(root, created.path, mutated.etag, (value) => ({
    ...value,
    sections: [{ id: "flow_section", title: "Flow", cards: [{ id: "pipeline", type: "flow", width: "full", direction: "TB", nodes: [{ id: "a", kind: "source", label: "A" }, { id: "b", kind: "result", label: "B" }], edges: [{ id: "a_b", source: "a", target: "b" }] }] }],
  }));
  const laidOut = await updateAnalysisCanvasFlowLayout(root, created.path, withFlow.etag, "pipeline", { direction: "LR", positions: [{ nodeId: "a", position: { x: 12, y: 34 } }] });
  const flow = parseAnalysisCanvas(laidOut.content).sections[0]?.cards[0];
  assert.equal(flow?.type, "flow");
  assert.equal(flow?.type === "flow" ? flow.direction : null, "LR");
  assert.deepEqual(flow?.type === "flow" ? flow.nodes[0]?.position : null, { x: 12, y: 34 });
  await assert.rejects(() => updateAnalysisCanvasFlowLayout(root, created.path, withFlow.etag, "pipeline", { positions: [] }), /changed on disk/);
  await assert.rejects(() => updateAnalysisCanvasFlowLayout(root, created.path, laidOut.etag, "pipeline", { positions: [{ nodeId: "missing", position: { x: 0, y: 0 } }] }), /Unknown Flow node/);
  assert.deepEqual(parseAnalysisCanvas(stringifyAnalysisCanvas(base)), base);
  assert.equal((await readAnalysisCanvas(root, created.path)).path, created.path);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("analysis-canvas tests passed.");
