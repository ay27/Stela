import assert from "node:assert/strict";

import {
  presentRunsqlRewriteProposal,
  registerRunsqlRewriteTarget,
  resolveRunsqlRewriteProposal,
  unregisterRunsqlRewriteTarget,
} from "./agent-rewrite-targets";

let sql = "select old_value";
const targetId = registerRunsqlRewriteTarget({
  getSql: () => sql,
  preview: (_original, proposed) => { sql = proposed; },
  accept: () => {},
  discard: () => { sql = "select old_value"; },
});

assert.equal(presentRunsqlRewriteProposal({
  targetId,
  runId: "run-1",
  callId: "call-1",
  originalSql: "select old_value",
  proposedSql: "select new_value",
  onApprove: () => {},
  onReject: () => {},
}), true);
assert.equal(sql, "select new_value");
assert.equal(resolveRunsqlRewriteProposal({ targetId, runId: "run-1", callId: "call-1", approve: false }), true);
assert.equal(sql, "select old_value");

sql = "select user_edit";
assert.equal(presentRunsqlRewriteProposal({
  targetId,
  runId: "run-2",
  callId: "call-2",
  originalSql: "select old_value",
  proposedSql: "select overwritten",
  onApprove: () => {},
  onReject: () => {},
}), false);
assert.equal(sql, "select user_edit");

unregisterRunsqlRewriteTarget(targetId);

let activeTarget = "first";
const firstTarget = {
  getSql: () => "select stable",
  preview: () => { activeTarget = "first-preview"; },
  accept: () => {},
  discard: () => {},
};
const stableId = registerRunsqlRewriteTarget(firstTarget, "note.md\nposition:10");
const replacementTarget = {
  getSql: () => "select stable",
  preview: () => { activeTarget = "replacement-preview"; },
  accept: () => {},
  discard: () => {},
};
assert.equal(registerRunsqlRewriteTarget(replacementTarget, "note.md\nposition:10"), stableId);
unregisterRunsqlRewriteTarget(stableId, firstTarget);
assert.equal(presentRunsqlRewriteProposal({
  targetId: stableId,
  runId: "run-stable",
  callId: "call-stable",
  originalSql: "select stable",
  proposedSql: "select remounted",
  onApprove: () => {},
  onReject: () => {},
}), true);
assert.equal(activeTarget, "replacement-preview");
unregisterRunsqlRewriteTarget(stableId, replacementTarget);
console.log("RunSQL Agent rewrite target tests passed.");
