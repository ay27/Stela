import assert from "node:assert/strict";

import type { AgentHistoryRef, AgentHistorySession } from "@shared/types";

import { useWorkspace, type Tab } from "./workspace";
import {
  currentWorkspaceContext,
  isCurrentHistoryTab,
  refreshCanvasTabIfOpen,
  replayAgentHistory,
  useAgentPanel,
} from "./agent-panel";
import { composeAgentMessage } from "@/lib/agent-message";

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
        attachments: [{
          kind: "runsql",
          label: "Revenue SQL",
          sql: "SELECT revenue FROM orders",
          errorMessage: "Unknown column 'revenue'",
        }],
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
assert.equal(
  timeline[0]?.kind === "user" && timeline[0].message.resources.some((resource) => resource.kind === "runsql"),
  true,
);
assert.equal(
  timeline[0]?.kind === "user" && timeline[0].message.segments.some((segment) =>
    segment.kind === "text" && segment.text.includes("Unknown column 'revenue'")),
  true,
);
assert.equal(
  timeline[0]?.kind === "user" && timeline[0].message.resources.some((resource) =>
    resource.kind === "canvas" && resource.path === "reports/revenue.stela.canvas"),
  true,
);
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
assert.deepEqual(currentWorkspaceContext(), { kind: "note", path: "current.md" });
refreshCanvasTabIfOpen("reports/new.stela.canvas");
assert.equal(useWorkspace.getState().tabs.length, 1);
assert.equal(useWorkspace.getState().activeTabId, note.id);

const canvas: Tab = { id: "file:/vault/reports/live.stela.canvas", kind: "analysis", title: "live.stela.canvas", path: "/vault/reports/live.stela.canvas" };
useWorkspace.setState({ tabs: [note, canvas], activeTabId: note.id, mruTabIds: [note.id, canvas.id] });
refreshCanvasTabIfOpen("reports/live.stela.canvas");
assert.equal(useWorkspace.getState().activeTabId, note.id);
assert.equal(useWorkspace.getState().tabs[1]?.reloadToken, 1);
useWorkspace.setState({ activeTabId: canvas.id });
assert.deepEqual(currentWorkspaceContext(), { kind: "canvas", path: "reports/live.stela.canvas" });
useWorkspace.setState({ activeTabId: note.id });

// Agent 事件使用 Vault-relative POSIX path；已打开 tab 可能来自平台路径或
// 含规范化片段。两者仍必须命中同一个 Canvas，且不能切换 active tab。
const normalizedCanvas: Tab = {
  id: "file:/vault/reports/nested/live.stela.canvas",
  kind: "analysis",
  title: "live.stela.canvas",
  path: "/vault/reports/nested/live.stela.canvas",
};
useWorkspace.setState({ tabs: [note, normalizedCanvas], activeTabId: note.id, mruTabIds: [note.id, normalizedCanvas.id] });
refreshCanvasTabIfOpen("reports\\nested\\.\\live.stela.canvas");
assert.equal(useWorkspace.getState().activeTabId, note.id);
assert.equal(useWorkspace.getState().tabs[1]?.reloadToken, 1);

// Add to Chat shares the same first-mount ordering requirement as quick tasks:
// bind the Agent store before inserting so the panel's mount effect cannot
// replace the draft that Cmd+I just created.
useAgentPanel.setState({ vaultPath: null, historyLoaded: false });
useAgentPanel.getState().addToChat({
  kind: "runsql",
  label: "Cmd+I RunSQL block",
  sql: "SELECT 1",
});
const addToChatState = useAgentPanel.getState();
const addToChatTab = addToChatState.tabs.find((tab) => tab.id === addToChatState.activeTabId);
assert.equal(addToChatState.vaultPath, "/vault");
assert.equal(addToChatTab?.draft.message.resources.length, 1);
assert.equal(addToChatTab?.draft.message.resources[0]?.kind, "runsql");

// Panel 尚未挂载/绑定 Vault 时，快捷任务必须先完成 store 绑定，不能被随后
// 的 AgentPanel bindVault effect 重置掉。
useAgentPanel.setState({ vaultPath: null, historyLoaded: false });
useAgentPanel.getState().openQuickTask({
  entryPoint: "runsql-rewrite",
  title: "Rewrite SQL",
  message: composeAgentMessage("Rewrite this query: ", {
    kind: "runsql",
    label: "RunSQL block",
    sql: "SELECT broken FROM orders",
    rewriteTargetId: "target_closed_panel",
  }),
  connectionName: "warehouse",
  locale: "en",
  autoSend: false,
});
const quickTaskState = useAgentPanel.getState();
const quickTaskTab = quickTaskState.tabs.find((tab) => tab.id === quickTaskState.activeTabId);
assert.equal(quickTaskState.vaultPath, "/vault");
assert.equal(quickTaskTab?.entryPoint, "runsql-rewrite");
assert.equal(quickTaskTab?.draft.message.segments[0]?.kind, "text");
assert.equal(quickTaskTab?.draft.message.resources.length, 1);
assert.equal(quickTaskTab?.draft.message.resources.some((resource) => resource.kind === "note"), false);
assert.equal(
  quickTaskTab?.draft.message.resources[0]?.kind === "runsql"
    ? quickTaskTab.draft.message.resources[0].rewriteTargetId
    : null,
  "target_closed_panel",
);

console.log("agent history replay tests passed.");
