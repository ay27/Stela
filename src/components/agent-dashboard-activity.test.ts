import assert from "node:assert/strict";

import { agentActivityLevel, buildAgentActivityGrid } from "./agent-dashboard-activity";

const generatedAt = new Date(2026, 7, 7, 12, 0, 0).getTime();
const grid = buildAgentActivityGrid("7d", generatedAt, [
  { day: "2026-08-03", total: 3, completed: 2, errors: 1, cancelled: 0, durationMs: 200 },
]);

assert.equal(grid.startDay, "2026-08-01");
assert.equal(grid.endDay, "2026-08-07");
assert.equal(grid.weekCount, 2);
assert.equal(grid.cells.filter((cell) => cell.inRange).length, 7);
assert.equal(grid.cells.find((cell) => cell.day === "2026-08-03")?.total, 3);
assert.equal(grid.cells.find((cell) => cell.day === "2026-08-04")?.total, 0);

const rollingBoundaryGrid = buildAgentActivityGrid("7d", generatedAt, [
  { day: "2026-07-31", total: 1, completed: 1, errors: 0, cancelled: 0, durationMs: 10 },
]);
assert.equal(rollingBoundaryGrid.startDay, "2026-07-31");
assert.equal(rollingBoundaryGrid.cells.find((cell) => cell.day === "2026-07-31")?.total, 1);

assert.equal(agentActivityLevel(0, 8), 0);
assert.equal(agentActivityLevel(1, 8), 1);
assert.equal(agentActivityLevel(4, 8), 2);
assert.equal(agentActivityLevel(8, 8), 4);

console.log("agent dashboard activity grid tests passed.");
