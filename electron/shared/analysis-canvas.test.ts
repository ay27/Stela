import assert from "node:assert/strict";
import { analysisCanvasSchema, parseAnalysisCanvas, stringifyAnalysisCanvas } from "./analysis-canvas";

const now = Date.now();
const canvas = analysisCanvasSchema.parse({
  kind: "stela-analysis-canvas", version: 1, id: "canvas_1", title: "Revenue", status: "working",
  createdAt: now, updatedAt: now, createdBySessionId: "sess_1",
  sources: [{ id: "sales", title: "Sales", connectionName: "prod", sql: "select month, revenue from sales", lastRunId: "run_1", lastRunAt: now, lastError: null }],
  sections: [{ id: "summary", title: "Summary", cards: [
    { id: "intro", type: "markdown", markdown: "Revenue trend", width: "full" },
    { id: "total", type: "kpi", sourceId: "sales", width: "third", value: { field: "revenue", format: { kind: "currency", currency: "CNY" } } },
    { id: "trend", type: "chart", sourceId: "sales", width: "full", chart: {
      preset: "trend",
      fields: { month: { field: "month", type: "temporal" }, revenue: { field: "revenue", type: "quantitative" } },
      layers: [{ mark: "line", encoding: { x: "month", y: "revenue" } }],
    } },
    { id: "pipeline", type: "flow", width: "full", direction: "LR", nodes: [
      { id: "source", kind: "source", label: "Raw" },
      { id: "result", kind: "result", label: "Metric" },
    ], edges: [{ id: "source_result", source: "source", target: "result" }] },
  ] }],
});
assert.deepEqual(parseAnalysisCanvas(stringifyAnalysisCanvas(canvas)), canvas);
assert.throws(() => analysisCanvasSchema.parse({ ...canvas, sections: [{ id: "x", title: "x", cards: [{ id: "bad", type: "table", sourceId: "missing", maxRows: 10, width: "full" }] }] }), /Unknown source id/);
assert.throws(() => analysisCanvasSchema.parse({ ...canvas, sections: [{ id: "x", title: "x", cards: [{ id: "flow", type: "flow", width: "full", direction: "TB", nodes: [{ id: "a", kind: "step", label: "A" }], edges: [{ id: "bad", source: "a", target: "missing" }] }] }] }), /Unknown flow target node/);

console.log("analysis-canvas tests passed.");
