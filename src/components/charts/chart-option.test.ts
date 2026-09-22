import assert from "node:assert/strict";
import { init } from "echarts";

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

// Horizontal rankings must preserve category names rather than converting them
// to null and collapsing all bars onto a single category.
const ranking: StelaChartSpec = {
  version: 2,
  source: { kind: "run", runId: "run_channels" },
  preset: "ranking",
  fields: {
    channel: { field: "channel", type: "nominal" },
    profit: { field: "profit", type: "quantitative", title: "Contribution profit", format: { kind: "currency", currency: "USD" } },
  },
  layers: [{ mark: "bar", encoding: { x: "profit", y: "channel" }, yAxis: "left", stack: "none" }],
};
const rankingOption = buildStelaChartOption(ranking, [
  { name: "channel", typeName: "VARCHAR" },
  { name: "profit", typeName: "DECIMAL" },
], [["paid_social", -4972.75], ["organic_search", 6653.11]], false, "en-US");
const rankingSeries = (rankingOption.series as Array<{
  name: string;
  data: unknown[][];
  tooltip: { valueFormatter: (value: unknown) => string };
}>)[0]!;
assert.deepEqual(rankingSeries.data, [[-4972.75, "paid_social"], [6653.11, "organic_search"]]);
assert.equal(rankingSeries.name, "Contribution profit");
assert.equal(rankingSeries.tooltip.valueFormatter([-4972.75, "paid_social"]), "-$4,972.75");

// Exercise ECharts itself: the categories must occupy separate rows, with
// negative and positive values on opposite sides of zero.
const renderedRanking = init(null, undefined, { renderer: "svg", ssr: true, width: 800, height: 400 });
try {
  renderedRanking.setOption({ ...rankingOption, animation: false });
  const svg = renderedRanking.renderToSVGString();
  assert.ok(svg.includes("paid_social"));
  assert.ok(svg.includes("organic_search"));
  const negative = renderedRanking.convertToPixel({ seriesIndex: 0 }, [-4972.75, "paid_social"]);
  const positive = renderedRanking.convertToPixel({ seriesIndex: 0 }, [6653.11, "organic_search"]);
  const zero = renderedRanking.convertToPixel({ seriesIndex: 0 }, [0, "paid_social"]);
  assert.notEqual(negative[1], positive[1]);
  assert.ok(negative[0] < zero[0] && positive[0] > zero[0]);
} finally {
  renderedRanking.dispose();
}

console.log("chart-option tests passed.");
