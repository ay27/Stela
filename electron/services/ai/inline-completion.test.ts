import assert from "node:assert/strict";

import type { AiInlineCompletionRequest, AiSchemaTargetContext } from "@shared/types";

import {
  buildInlineFimInput,
  hasSchemasForReferencedTables,
  isCompletionCandidateSafe,
  mergeCompletionSchemas,
  prepareInlineCompletionContext,
  sanitizeCompletionCandidate,
} from "./inline-completion";

const live: AiSchemaTargetContext = {
  database: "dw",
  table: "orders",
  columns: [
    { name: "id", typeName: "bigint" },
    { name: "amount", typeName: "decimal(18,2)" },
    { name: "err_code", typeName: "int" },
  ],
};
const documented: AiSchemaTargetContext = {
  database: "dw",
  table: "orders",
  columns: [
    { name: "id", typeName: "varchar", comment: "订单 ID" },
    { name: "stale_column", typeName: "varchar", comment: "过期列" },
  ],
  ddlSnippet: "CREATE TABLE dw.orders (...) ENGINE=OLAP",
};

const merged = mergeCompletionSchemas([live], [documented]);
assert.deepEqual(merged[0]?.columns, [
  { name: "id", typeName: "bigint", comment: "订单 ID" },
  { name: "amount", typeName: "decimal(18,2)" },
  { name: "err_code", typeName: "int" },
]);
assert.equal(merged[0]?.ddlSnippet, null);
assert.equal(hasSchemasForReferencedTables(["dw.orders"], merged), true);
assert.equal(hasSchemasForReferencedTables(["dw.missing"], merged), false);
assert.equal(hasSchemasForReferencedTables([], []), true);

const request: AiInlineCompletionRequest = {
  requestId: "request",
  prefix: `${"x".repeat(5_000)}\nselect o.`,
  suffix: ` from dw.orders o${"y".repeat(3_000)}`,
  siblingSqls: [
    "select amount from dw.orders",
    "select id from unrelated.users",
    "select id from dw.orders where amount > 0",
  ],
  connectionName: "warehouse",
  tableSchemas: [live],
  heading: "订单成本",
  prose: "api_key=must-not-leak",
};
const prepared = prepareInlineCompletionContext({
  request,
  dialect: "StarRocks",
  tables: ["dw.orders"],
  schemas: [documented],
});
assert.ok(prepared.prefix.length <= 4_000);
assert.ok(prepared.suffix.length <= 2_000);
assert.ok(prepared.auxiliary.length <= 2_000);
assert.match(prepared.auxiliary, /订单 ID/);
assert.doesNotMatch(prepared.auxiliary, /stale_column|ENGINE=OLAP|must-not-leak/);
assert.match(prepared.auxiliary, /\*\*\*redacted\*\*\*/);

const fim = buildInlineFimInput({
  request,
  dialect: "StarRocks",
  tables: ["dw.orders"],
  schemas: [documented],
});
assert.ok(fim.prompt.endsWith(prepared.prefix));
assert.equal(fim.suffix, prepared.suffix);

assert.equal(sanitizeCompletionCandidate("```sql\no.amount\nFROM dw.orders o\nWHERE o.id > 0\nextra\n```"), "o.amount\nFROM dw.orders o\nWHERE o.id > 0");
assert.equal(
  isCompletionCandidateSafe({
    text: "amount",
    prefix: "select ",
    suffix: " from dw.orders",
    dialect: "StarRocks",
    schemas: [live],
    averageLogprob: -0.5,
  }),
  true,
);
assert.equal(
  isCompletionCandidateSafe({
    text: "o.missing",
    prefix: "select ",
    suffix: " from dw.orders o",
    dialect: "StarRocks",
    schemas: [live],
    averageLogprob: -0.5,
  }),
  false,
);
const pseudoHighSchema: AiSchemaTargetContext = {
  database: "threed",
  table: "pseudo_high_mesh_20260827",
  columns: [{ name: "err_code", typeName: "int" }],
};
const completedAggregatePrefix = `SELECT
  COUNT(1) as \`总量\`,
  COUNT_IF(err_code=0) as \`pending\`,
  COUNT_IF(err_code=1) as \`done\`,
  COUNT_IF(err_code<0) as \`failed\`
FROM threed.pseudo_high_mesh_20260827`;
assert.equal(
  isCompletionCandidateSafe({
    text: " WHERE dt = '2026-08-27'",
    prefix: completedAggregatePrefix,
    suffix: "",
    dialect: "StarRocks",
    schemas: [pseudoHighSchema],
    averageLogprob: -0.5,
  }),
  false,
);
assert.equal(
  isCompletionCandidateSafe({
    text: " WHERE err_code < 0",
    prefix: completedAggregatePrefix,
    suffix: "",
    dialect: "StarRocks",
    schemas: [pseudoHighSchema],
    averageLogprob: -0.5,
  }),
  true,
);
assert.equal(
  isCompletionCandidateSafe({
    text: " ORDER BY done DESC",
    prefix: completedAggregatePrefix,
    suffix: "",
    dialect: "StarRocks",
    schemas: [pseudoHighSchema],
    averageLogprob: -0.5,
  }),
  true,
);
assert.equal(
  isCompletionCandidateSafe({
    text: "amount",
    prefix: "select ",
    suffix: " from dw.orders",
    dialect: "StarRocks",
    schemas: [live],
    averageLogprob: -3,
  }),
  false,
);

console.log("inline completion tests passed.");
