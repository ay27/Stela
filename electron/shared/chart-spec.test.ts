import assert from "node:assert/strict";
import { parseDetail, serializeDetail } from "./detail-meta";

import {
  parseEmbeddedStelaChartSpec,
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
assert.equal(
  parseEmbeddedStelaChartSpec(JSON.stringify({
    ...bar,
    source: { kind: "block", blockId: "blk-1" },
  })).source.blockId,
  "blk-1",
);
assert.throws(() => parseEmbeddedStelaChartSpec(stringifyStelaChartSpec(bar)), /RunSQL block/);
const pendingRaw = serializeDetail({
  blockId: "blk-1",
  runDate: "",
  elapsed: "",
  rowCount: 0,
  firstRow: null,
  resultRefId: "",
  chart: parseEmbeddedStelaChartSpec(JSON.stringify({
    ...bar,
    title: "A < B & C",
    source: { kind: "block", blockId: "blk-1" },
  })),
});
assert.doesNotMatch(pendingRaw, /<run-date>/);
assert.match(pendingRaw, /<chart>/);
assert.doesNotMatch(pendingRaw, /A < B/);
const pending = parseDetail(pendingRaw.slice("<detail>".length, -"</detail>".length));
assert.equal(pending.chart?.title, "A < B & C");
assert.equal(pending.chartError, undefined);
const mismatch = parseDetail(pendingRaw.replaceAll("blk-1", "blk-2").replace("<block-id>blk-2", "<block-id>blk-1").slice("<detail>".length, -"</detail>".length));
assert.match(mismatch.chartError ?? "", /does not match/);

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
