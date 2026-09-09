import assert from "node:assert/strict";
import type { AgentHistorySession } from "@shared/types";
import { replayAgentHistory } from "./agent-panel";

const history: AgentHistorySession = {
  summary: { sessionId: "fixture", deviceSlug: "offline", title: "fixture", createdAt: 1, updatedAt: 2, isLocal: true },
  runs: [{ request: { runId: "fixture", prompt: "Calculate a value" }, startedAt: 1, finishedAt: 2, proposalResponses: [],
    events: [{ type: "error", runId: "fixture", message: "terminated", partialAnswer: "Incomplete: the committed value is 42." }],
  }],
};
const timeline = replayAgentHistory(history);
assert.equal(timeline.at(-1)?.kind, "error", "partial delivery does not change terminal failure");
assert.ok(timeline.some(entry => entry.kind === "final" && entry.content.includes("42")));
history.runs[0].events = [{ type: "error", runId: "fixture", message: "terminated" }];
assert.equal(replayAgentHistory(history).filter(entry => entry.kind === "final").length, 0, "legacy errors do not fabricate an answer");
history.runs[0].events = [{ type: "cancelled", runId: "fixture" }];
assert.equal(replayAgentHistory(history).at(-1)?.kind, "cancelled");
console.log("agent panel lifecycle: partial answer and original error survive history replay");

const diagnostic = { stage: "initialization", message: "missing function", metricRunId: "maintenance-fixture" };
const outcomes = [
  ["error", "error"], ["timeout", "timeout"], ["turn_limit", "timeout"],
  ["cancelled", "cancelled"], ["no_source", "skipped"], ["input_too_large", "skipped"],
  ["dropped", "skipped"], ["no_change", "none"], [undefined, "unknown"],
] as const;
for (const [outcome, expected] of outcomes) {
  history.runs[0].events = [
    { type: "final", runId: "fixture", content: "Answer remains valid." },
    { type: "skill_maintenance", runId: "fixture", actions: [], summary: "details", outcome, diagnostic },
  ];
  const final = replayAgentHistory(history).find(e => e.kind === "final");
  assert.ok(final?.kind === "final");
  assert.equal(final.maintenance?.status, expected);
  assert.deepEqual(final.maintenance?.diagnostic, diagnostic);
}
// An action saved before a later error must not turn the failure indicator green.
history.runs[0].events = [
  { type: "final", runId: "fixture", content: "Answer" },
  { type: "skill_maintenance", runId: "fixture", outcome: "error", summary: "partial save then failure",
    actions: [{ action: "saved", name: "example", path: "example", category: null, reason: "verified" }] },
];
const partial = replayAgentHistory(history).find(e => e.kind === "final");
assert.ok(partial?.kind === "final");
assert.equal(partial.maintenance?.status, "error");
assert.equal(partial.maintenance?.actions.length, 1);
console.log("maintenance outcomes: errors, limits, skips and legacy unknowns are not shown as success");
