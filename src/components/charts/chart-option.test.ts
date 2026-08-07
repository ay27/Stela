import assert from "node:assert/strict";

import type { StelaChartSpec } from "@shared/chart-spec";
import { buildStelaChartOption } from "./chart-option";

const columns = [
  { name: "month", typeName: "DATE" },
  { name: "revenue", typeName: "DECIMAL" },
  { name: "orders", typeName: "BIGINT" },
];
const comparison: StelaChartSpec = {
  version: 2,
  source: { kind: "run", runId: "run_1" },
  preset: "comparison",
  fields: {
    month: { field: "month", type: "temporal", temporalInput: "iso", format: { kind: "date", input: "epoch-ms", style: "short", timeZone: "UTC" } },
    revenue: { field: "revenue", type: "quantitative", format: { kind: "currency", currency: "CNY" } },
    orders: { field: "orders", type: "quantitative", format: { kind: "compact" } },
  },
  layers: [
    { mark: "bar", encoding: { x: "month", y: "revenue" }, yAxis: "left", stack: "none" },
    { mark: "line", encoding: { x: "month", y: "orders" }, yAxis: "right", stack: "none" },
  ],
};
const option = buildStelaChartOption(comparison, columns, [["2026-01-01", 1200, 12], ["2026-02-01", 1800, 20]], false, "en-US") as Record<string, unknown>;
assert.equal((option.series as Array<{ type: string }>).length, 2);
assert.deepEqual((option.series as Array<{ type: string }>).map((series) => series.type), ["bar", "line"]);
assert.equal((option.yAxis as unknown[]).length, 2);

const heatmap: StelaChartSpec = {
  version: 2,
  source: { kind: "run", runId: "run_2" },
  preset: "retention",
  fields: {
    cohort: { field: "cohort", type: "ordinal" },
    period: { field: "period", type: "ordinal" },
    rate: { field: "rate", type: "quantitative", format: { kind: "percent", input: "ratio" } },
  },
  layers: [{ mark: "rect", encoding: { x: "period", y: "cohort", color: "rate" }, yAxis: "left", stack: "none" }],
};
const heatmapOption = buildStelaChartOption(heatmap, [
  { name: "cohort", typeName: "VARCHAR" },
  { name: "period", typeName: "VARCHAR" },
  { name: "rate", typeName: "DOUBLE" },
], [["Jan", "M0", 1], ["Jan", "M1", 0.7]], false, "en-US") as Record<string, unknown>;
assert.equal((heatmapOption.series as Array<{ type: string }>)[0]?.type, "heatmap");
assert.ok(heatmapOption.visualMap);

console.log("chart-option tests passed.");
