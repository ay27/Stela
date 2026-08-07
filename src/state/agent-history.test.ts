import assert from "node:assert/strict";

import type { AgentHistoryRef, AgentHistorySession } from "@shared/types";

import { useWorkspace, type Tab } from "./workspace";
import { isCurrentHistoryTab, refreshCanvasTabIfOpen, replayAgentHistory } from "./agent-panel";

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
      request: {
        runId: "run_1",
        sessionId: "sess_1",
        prompt: "Inspect revenue",
        canvasPath: "reports/revenue.stela.canvas",
        attachments: [{ kind: "runsql", label: "Revenue SQL", sql: "SELECT revenue FROM orders" }],
      },
      startedAt: 1,
      finishedAt: null,
      events: [
        {
          type: "canvas_updated",
          runId: "run_1",
          path: "revenue.stela.canvas",
          title: "Revenue",
          action: "created",
        },
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
assert.equal(timeline[0]?.kind === "user" && timeline[0].attachments?.[0]?.kind, "runsql");
assert.equal(timeline[0]?.kind === "user" && timeline[0].canvasPath, "reports/revenue.stela.canvas");
assert.equal(timeline[1]?.kind, "canvas");
assert.equal(timeline[2]?.kind, "proposal");
assert.equal(timeline[2]?.kind === "proposal" && timeline[2].resolution, "expired");
assert.equal(timeline[3]?.kind, "interrupted");

const localRef: AgentHistoryRef = { sessionId: "sess_1", deviceSlug: "laptop" };
assert.equal(
  isCurrentHistoryTab({ sessionId: "sess_1", historyRef: null }, localRef, true),
  true,
);
assert.equal(
  isCurrentHistoryTab({ sessionId: "sess_1", historyRef: null }, localRef, false),
  false,
);

const note: Tab = { id: "file:/vault/current.md", kind: "file", title: "current.md", path: "/vault/current.md" };
useWorkspace.setState({ vaultPath: "/vault", tabs: [note], activeTabId: note.id, mruTabIds: [note.id] });
refreshCanvasTabIfOpen("reports/new.stela.canvas");
assert.equal(useWorkspace.getState().tabs.length, 1);
assert.equal(useWorkspace.getState().activeTabId, note.id);

const canvas: Tab = { id: "file:/vault/reports/live.stela.canvas", kind: "analysis", title: "live.stela.canvas", path: "/vault/reports/live.stela.canvas" };
useWorkspace.setState({ tabs: [note, canvas], activeTabId: note.id, mruTabIds: [note.id, canvas.id] });
refreshCanvasTabIfOpen("reports/live.stela.canvas");
assert.equal(useWorkspace.getState().activeTabId, note.id);
assert.equal(useWorkspace.getState().tabs[1]?.reloadToken, 1);

console.log("agent history replay tests passed.");
