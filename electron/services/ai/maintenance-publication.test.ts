import assert from "node:assert/strict";
import { reviewMaintenancePublication } from "./maintenance-publication";
import { ToolRepairBudget } from "./tool-repair";
import { buildSkillMaintenanceEvidence } from "./skill-maintenance";

const note = { path: "definitions.md", content: "Source scope is game_engine = aaa.\nPBR has no game_engine column.", sha256: "fixture", updatedAt: "" };
assert.equal(reviewMaintenancePublication("rule", undefined, [note]).ok, false);
assert.equal(reviewMaintenancePublication("rule", [{ sourcePath: "generated.md", quote: "Source scope is game_engine = aaa." }], [note]).ok, false);
const conflicting = reviewMaintenancePublication("rule", [{ sourcePath: note.path, quote: "PBR has no game_engine column." }], [note], ["game_engine"]);
assert.equal(conflicting.ok, false);
if (!conflicting.ok) assert.ok(conflicting.reasons.includes("possible_conflict_with_observed_column"));
const accepted = reviewMaintenancePublication("rule", [{ sourcePath: note.path, quote: "Source scope is game_engine = aaa." }], [note]);
assert.equal(accepted.ok, true);
if (accepted.ok) {
  assert.match(accepted.content, /> Source scope is game_engine = aaa/);
  assert.doesNotMatch(accepted.content, /PBR has no/);
}
const sql = buildSkillMaintenanceEvidence("run_query", { query: "WITH src AS (SELECT id FROM demo.assets) SELECT src.id FROM src JOIN demo.pbr pbr ON src.id=pbr.id CROSS JOIN dual" }, {}, false);
assert.ok(sql.tables?.every(table => table.includes(".") && table !== "dual"));
const budget = new ToolRepairBudget();
assert.match(budget.validation("canvas", "shape"), /5 attempts remaining/);
assert.match(budget.validation("canvas", "shape"), /change the source/);
for (let i = 0; i < 4; i++) budget.validation("canvas", `different-${i}`);
assert.match(budget.blocked("canvas")!, /exhausted/);
assert.equal(budget.blocked("query"), null);
console.log("maintenance publication and repair budget tests passed");
