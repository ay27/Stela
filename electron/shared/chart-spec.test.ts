import assert from "node:assert/strict";

import {
  parseStelaChartSpec,
  stringifyStelaChartSpec,
  validateStelaChartData,
} from "./chart-spec";

const bar = parseStelaChartSpec(JSON.stringify({
  version: 1,
  type: "bar",
  source: { kind: "run", runId: "run-1" },
  category: "category",
  value: "count",
}));
assert.equal(bar.type, "bar");
assert.equal(bar.orientation, "horizontal");
assert.equal(JSON.parse(stringifyStelaChartSpec(bar)).sort, "desc");

validateStelaChartData(
  bar,
  [{ name: "category", typeName: "VARCHAR" }, { name: "count", typeName: "BIGINT" }],
  [["A", "12"], ["B", 8]],
);
assert.throws(
  () => validateStelaChartData(bar, [{ name: "category", typeName: "VARCHAR" }], [["A"]]),
  /count.*does not exist/,
);
assert.throws(
  () => validateStelaChartData(
    bar,
    [{ name: "category", typeName: "VARCHAR" }, { name: "count", typeName: "VARCHAR" }],
    [["A", "many"]],
  ),
  /non-numeric/,
);
assert.throws(
  () => validateStelaChartData(
    bar,
    [{ name: "category", typeName: "VARCHAR" }, { name: "count", typeName: "BIGINT" }],
    [["A", 1], ["A", 2]],
  ),
  /not unique/,
);
assert.throws(
  () => parseStelaChartSpec('{"version":1,"type":"line","source":{"kind":"run","runId":"x"}}'),
  /Required/,
);
assert.throws(
  () => parseStelaChartSpec('{"version":1,"type":"bar","source":{"kind":"run","runId":"x"},"category":"c","value":"v","script":"alert(1)"}'),
  /Unrecognized key/,
);

console.log("chart-spec tests passed.");
