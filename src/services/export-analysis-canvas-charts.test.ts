import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";

import type { StelaChartSpec } from "@shared/chart-spec";

import { buildInteractiveChartExport, renderInteractiveChartScripts } from "./export-analysis-canvas-charts";

const spec: StelaChartSpec = {
  version: 2,
  source: { kind: "run", runId: "run_export" },
  preset: "comparison",
  fields: {
    month: { field: "month", type: "ordinal" },
    revenue: { field: "revenue", type: "quantitative", format: { kind: "currency", currency: "USD", maximumFractionDigits: 0 } },
    margin: { field: "margin", type: "quantitative", format: { kind: "percent", input: "ratio", maximumFractionDigits: 1 } },
  },
  layers: [
    { mark: "line", encoding: { x: "month", y: "revenue" }, yAxis: "left", stack: "none" },
    { mark: "line", encoding: { x: "month", y: "margin" }, yAxis: "right", stack: "none" },
  ],
};

const exported = buildInteractiveChartExport("chart-1", spec, {
  columns: [{ name: "month", typeName: "VARCHAR" }, { name: "revenue", typeName: "DECIMAL" }, { name: "margin", typeName: "DECIMAL" }],
  rows: [["2026-05", 45412.2, 0.4224], ["2026-06", 54016.8, 0.1683]],
  total: 2,
  runId: "run_export",
}, "en-US");

assert.equal(exported.callbacks.kind, "cartesian");
assert.equal(JSON.stringify(exported.option).includes("valueFormatter"), false, "portable option must not depend on unserializable callbacks");

interface HydratedOption {
  series: Array<{ tooltip: { valueFormatter: (value: unknown) => string } }>;
  xAxis: { axisLabel: { formatter: (value: unknown) => string } };
  yAxis: Array<{ axisLabel: { formatter: (value: unknown) => string } }>;
}

const captured: { option?: HydratedOption } = {};
const host = { classList: { add: () => undefined }, textContent: "" };
const html = renderInteractiveChartScripts(
  [exported],
  "globalThis.echarts={init:()=>({setOption:(option)=>capture(option),resize:()=>undefined})};",
);
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]!);
assert.equal(scripts.length, 2);
runInNewContext(scripts.join("\n"), {
  capture: (option: HydratedOption) => { captured.option = option; },
  document: { getElementById: (id: string) => id === "chart-1" ? host : null },
  window: { addEventListener: () => undefined },
  Intl,
});

assert.ok(captured.option);
const hydrated = captured.option;
assert.equal(hydrated.xAxis.axisLabel.formatter("2026-06"), "2026-06");
assert.match(hydrated.series[0]!.tooltip.valueFormatter(["2026-06", 54016.8]), /\$54,017/);
assert.match(hydrated.yAxis[1]!.axisLabel.formatter(0.1683), /16\.8%/);

console.log("interactive Canvas chart export tests passed.");
