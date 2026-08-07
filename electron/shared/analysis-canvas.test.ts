import assert from "node:assert/strict";
import { analysisCanvasSchema, parseAnalysisCanvas, stringifyAnalysisCanvas } from "./analysis-canvas";

const now = Date.now();
const canvas = analysisCanvasSchema.parse({
  kind: "stela-analysis-canvas", version: 1, id: "canvas_1", title: "Revenue", status: "working",
  createdAt: now, updatedAt: now, createdBySessionId: "sess_1",
  sources: [{ id: "sales", title: "Sales", connectionName: "prod", sql: "select month, revenue from sales", lastRunId: "run_1", lastRunAt: now, lastError: null }],
  sections: [{ id: "summary", title: "Summary", cards: [
    { id: "intro", type: "markdown", markdown: "Revenue trend", width: "full" },
    { id: "trend", type: "chart", sourceId: "sales", width: "full", chart: { type: "line", x: "month", value: "revenue", area: false } },
  ] }],
});
assert.deepEqual(parseAnalysisCanvas(stringifyAnalysisCanvas(canvas)), canvas);
assert.throws(() => analysisCanvasSchema.parse({ ...canvas, sections: [{ id: "x", title: "x", cards: [{ id: "bad", type: "table", sourceId: "missing", maxRows: 10, width: "full" }] }] }), /Unknown source id/);
