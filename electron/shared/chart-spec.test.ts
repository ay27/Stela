import assert from "node:assert/strict";
import { parseStelaChartSpec, stringifyStelaChartSpec, validateStelaChartData } from "./chart-spec";

const ranking = parseStelaChartSpec(JSON.stringify({
  version: 2,
  source: { kind: "run", runId: "run-1" },
  preset: "ranking",
  fields: {
    category: { field: "category", type: "nominal" },
    count: { field: "count", type: "quantitative", format: { kind: "compact" } },
  },
  layers: [{ mark: "bar", encoding: { x: "count", y: "category" } }],
}));
assert.equal(ranking.version, 2);
assert.equal(ranking.layers[0]?.mark, "bar");
assert.equal(JSON.parse(stringifyStelaChartSpec(ranking)).layers[0].stack, "none");
validateStelaChartData(ranking, [{ name: "category", typeName: "VARCHAR" }, { name: "count", typeName: "BIGINT" }], [["A", "12"], ["B", 8]]);

assert.throws(() => validateStelaChartData(ranking, [{ name: "category", typeName: "VARCHAR" }], [["A"]]), /count.*does not exist/);
assert.throws(() => validateStelaChartData(ranking, [{ name: "category", typeName: "VARCHAR" }, { name: "count", typeName: "VARCHAR" }], [["A", "many"]]), /non-numeric/);
assert.throws(() => validateStelaChartData(ranking, [{ name: "category", typeName: "VARCHAR" }, { name: "count", typeName: "BIGINT" }], [["A", 1], ["A", 2]]), /not unique/);

assert.throws(() => parseStelaChartSpec(JSON.stringify({
  version: 2, source: { kind: "run", runId: "x" }, preset: "trend",
  fields: { month: { field: "month", type: "temporal" }, value: { field: "value", type: "quantitative" } },
  layers: [{ mark: "bar", encoding: { x: "month", y: "value" } }],
})), /not valid for preset trend/);

assert.throws(() => parseStelaChartSpec(JSON.stringify({
  version: 2, source: { kind: "run", runId: "x" }, preset: "comparison",
  fields: { month: { field: "month", type: "temporal" }, other: { field: "other", type: "temporal" }, value: { field: "value", type: "quantitative" } },
  layers: [
    { mark: "bar", encoding: { x: "month", y: "value" } },
    { mark: "line", encoding: { x: "other", y: "value" }, yAxis: "right" },
  ],
})), /share the same x field/);

assert.throws(() => parseStelaChartSpec(JSON.stringify({ ...ranking, script: "alert(1)" })), /Unrecognized key/);
assert.throws(() => parseStelaChartSpec(JSON.stringify({ ...ranking, version: 1 })), /Invalid literal value/);
assert.throws(() => parseStelaChartSpec(JSON.stringify({
  version: 2, source: { kind: "run", runId: "x" }, preset: "correlation",
  fields: { category: { field: "category", type: "nominal" }, value: { field: "value", type: "quantitative" } },
  layers: [{ mark: "point", encoding: { x: "category", y: "value" } }],
})), /Correlation x must be quantitative/);

console.log("chart-spec tests passed.");
