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
