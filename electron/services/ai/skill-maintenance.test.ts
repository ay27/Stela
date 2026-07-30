import assert from "node:assert/strict";

import {
  buildSkillMaintenanceEvidence,
  formatSkillMaintenanceEvidence,
  hasSkillMaintenanceEvidence,
} from "./skill-maintenance";

const schema = buildSkillMaintenanceEvidence(
  "get_table_schema",
  { tables: ["threed.render_task"] },
  { columns: [] },
  false,
);
const syntaxFailure = buildSkillMaintenanceEvidence(
  "run_sql",
  { sql: "SELECT broken" },
  "Unknown column 'broken'",
  true,
);
const timeout = buildSkillMaintenanceEvidence(
  "run_sql",
  { sql: "SELECT 1" },
  "Connection timed out",
  true,
);
const sqlRun = buildSkillMaintenanceEvidence(
  "run_sql",
  { sql: "INSERT INTO threed.render_task SELECT * FROM threed.source_candidates" },
  { kind: "mutation" },
  false,
);

assert.deepEqual(schema, {
  tool: "get_table_schema",
  kind: "success",
  source: ["threed.render_task"],
});
assert.equal(syntaxFailure.kind, "failed_attempt");
assert.equal(timeout.kind, "transient_failure");
assert.deepEqual(sqlRun.source, ["threed.source_candidates", "threed.render_task"]);
assert.deepEqual(sqlRun.tables, ["threed.source_candidates", "threed.render_task"]);
assert.equal(hasSkillMaintenanceEvidence([syntaxFailure]), false);
assert.equal(hasSkillMaintenanceEvidence([syntaxFailure, schema]), true);
assert.doesNotMatch(formatSkillMaintenanceEvidence([schema, syntaxFailure]), /SELECT broken/);
