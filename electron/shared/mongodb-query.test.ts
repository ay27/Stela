import assert from "node:assert/strict";

import {
  MONGO_AGGREGATION_MAX_STAGES,
  validateMongoAggregationPipeline,
} from "./mongodb-query";

assert.equal(validateMongoAggregationPipeline([
  { $match: { status: "active" } },
  { $set: { titleLength: { $strLenCP: "$title" } } },
  { $group: { _id: "$category", total: { $sum: 1 }, longest: { $max: "$titleLength" } } },
  { $sort: { total: -1 } },
]), null);

for (const pipeline of [
  [{ $out: "copy" }],
  [{ $merge: { into: "copy" } }],
  [{ $lookup: { from: "other", as: "rows" } }],
  [{ $facet: { rows: [{ $limit: 1 }] } }],
  [{ $project: { value: { $function: { body: "return 1", args: [], lang: "js" } } } }],
]) {
  assert.ok(validateMongoAggregationPipeline(pipeline), JSON.stringify(pipeline));
}

assert.match(
  validateMongoAggregationPipeline(Array.from(
    { length: MONGO_AGGREGATION_MAX_STAGES + 1 },
    () => ({ $match: {} }),
  )) ?? "",
  /at most/,
);
assert.match(
  validateMongoAggregationPipeline([{ $project: { value: "x".repeat(70_000) } }]) ?? "",
  /exceeds/,
);

console.log("mongodb query safety tests passed.");
