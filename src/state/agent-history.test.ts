import assert from "node:assert/strict";

import type { AgentHistoryRef, AgentHistorySession } from "@shared/types";

import { isCurrentHistoryTab, replayAgentHistory } from "./agent-panel";

const history: AgentHistorySession = {
  summary: {
    sessionId: "sess_1",
    deviceSlug: "laptop",
    title: "Inspect revenue",
    createdAt: 1,
    updatedAt: 2,
    isLocal: true,
  },
  runs: [
    {
      request: { runId: "run_1", sessionId: "sess_1", prompt: "Inspect revenue" },
      startedAt: 1,
      finishedAt: null,
      events: [
        {
          type: "proposal",
          runId: "run_1",
          callId: "proposal_1",
          kind: "question",
          payload: { description: "Which region?", question: "Which region?" },
        },
      ],
      proposalResponses: [],
    },
  ],
};

const timeline = replayAgentHistory(history);
assert.equal(timeline[0]?.kind, "user");
assert.equal(timeline[1]?.kind, "proposal");
assert.equal(timeline[1]?.kind === "proposal" && timeline[1].resolution, "expired");
assert.equal(timeline[2]?.kind, "interrupted");

const localRef: AgentHistoryRef = { sessionId: "sess_1", deviceSlug: "laptop" };
assert.equal(
  isCurrentHistoryTab({ sessionId: "sess_1", historyRef: null }, localRef, true),
  true,
);
assert.equal(
  isCurrentHistoryTab({ sessionId: "sess_1", historyRef: null }, localRef, false),
  false,
);

console.log("agent history replay tests passed.");
