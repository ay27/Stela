import assert from "node:assert/strict";

import { EditorSelection, EditorState } from "@codemirror/state";

import {
  createFimAcceptSpec,
  getFimContext,
  normalizeFimSuggestion,
  shouldClearGhostForSelection,
} from "./sql-fim-completion";

const state = EditorState.create({
  doc: "SELECT  FROM orders",
  selection: EditorSelection.cursor(7),
});

assert.deepEqual(getFimContext(state), {
  pos: 7,
  prompt: "SELECT ",
  suffix: " FROM orders",
});

const selected = EditorState.create({
  doc: "SELECT * FROM orders",
  selection: EditorSelection.range(0, 6),
});
assert.equal(getFimContext(selected), null);

const shortPrefix = EditorState.create({
  doc: "  a",
  selection: EditorSelection.cursor(3),
});
assert.equal(getFimContext(shortPrefix), null);

const accepted = state.update(
  createFimAcceptSpec({ pos: 7, text: "customer_id" }),
).state;
assert.equal(accepted.doc.toString(), "SELECT customer_id FROM orders");
assert.equal(accepted.selection.main.head, "SELECT customer_id".length);

assert.equal(
  shouldClearGhostForSelection(
    { pos: 7, text: "customer_id" },
    EditorSelection.cursor(7),
  ),
  false,
);
assert.equal(
  shouldClearGhostForSelection(
    { pos: 7, text: "customer_id" },
    EditorSelection.cursor(8),
  ),
  true,
);
assert.equal(
  shouldClearGhostForSelection(
    { pos: 7, text: "customer_id" },
    EditorSelection.range(7, 10),
  ),
  true,
);

assert.equal(
  normalizeFimSuggestion("customer_id FROM orders", " FROM orders"),
  "customer_id",
);

assert.equal(
  normalizeFimSuggestion("```sql\ncustomer_id\n```", ""),
  "customer_id",
);

assert.equal(
  normalizeFimSuggestion(
    Array.from({ length: 12 }, (_, idx) => `line_${idx}`).join("\n"),
    "",
  ).split("\n").length,
  8,
);

console.log("sql-fim-completion tests passed.");
