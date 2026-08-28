import assert from "node:assert/strict";

import { MySQL, sql } from "@codemirror/lang-sql";
import { EditorState } from "@codemirror/state";

import { sqlCompletionContextBlockReason } from "./sql-inline-completion-context";

function reason(
  doc: string,
  marker = "|",
  options: { allowCompleteStatement?: boolean } = {},
): string | null {
  const pos = doc.indexOf(marker);
  assert.notEqual(pos, -1);
  const text = doc.replace(marker, "");
  const state = EditorState.create({ doc: text, extensions: [sql({ dialect: MySQL })] });
  return sqlCompletionContextBlockReason(state, pos, options);
}

assert.equal(reason("sel|ect id from users"), null);
assert.equal(reason("select id fr|om users"), null);
assert.equal(reason("|select id from users"), null);
assert.equal(reason("select '|secret' from users"), "cursor is inside a comment or string");
assert.equal(reason("select id -- comm|ent"), "cursor is inside a comment or string");
assert.equal(reason("se|"), "SQL context is too short");
assert.equal(reason("select 1;|"), "cursor follows a completed statement");

const completedAggregate = `SELECT
  COUNT(1) as \`总量\`,
  COUNT_IF(err_code=0) as \`pending\`,
  COUNT_IF(err_code=1) as \`done\`,
  COUNT_IF(err_code<0) as \`failed\`
FROM threed.pseudo_high_mesh_20260827|`;
assert.equal(reason(completedAggregate), "SQL statement is already complete");
assert.equal(reason(completedAggregate, "|", { allowCompleteStatement: true }), null);
assert.equal(reason("SELECT * FROM users WHERE |"), null);
assert.equal(reason("SELECT * FROM users JOIN |"), null);
assert.equal(reason("SELECT * FR|OM users"), null);
assert.equal(reason("WITH recent AS (SELECT * FROM users)|"), null);
assert.equal(
  reason("WITH recent AS (SELECT * FROM users) SELECT * FROM recent|"),
  "SQL statement is already complete",
);

console.log("SQL inline completion context tests passed.");
