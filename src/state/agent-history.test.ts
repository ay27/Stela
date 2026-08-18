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
import { agentComposerStateToMessage } from "@/lib/agent-composer";
import { canvasRefreshTaskInput } from "@/components/ai/agent-quick-actions";

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
          type: "strategy_review",
          runId: "run_1",
          status: "completed",
          trigger: "query_churn",
          checkpoint: {
            runId: "run_1",
            version: 1,
            trigger: "query_churn",
            createdAt: 1,
            metrics: {
              queryFamilyPeak: 2,
              strategyHints: 0,
              reviewTriggered: true,
              reviewTrigger: "query_churn",
              runQueryCallsAtReview: 20,
              postReviewRunQueryCalls: 0,
              reviewStatus: "completed",
            },
            advice: {
              assessment: "change",
              diagnosis: "Too many probes.",
              nextActions: ["Use one aggregate."],
              avoid: "More probes.",
              successCondition: "One exact result.",
            },
          },
        },
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
assert.equal(timeline[1]?.kind, "strategy");
assert.equal(timeline[2]?.kind, "canvas");
assert.equal(timeline[3]?.kind, "proposal");
assert.equal(timeline[3]?.kind === "proposal" && timeline[3].resolution, "expired");
assert.equal(timeline[4]?.kind, "interrupted");

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
const addToChatMessage = addToChatTab ? agentComposerStateToMessage(addToChatTab.draft.editorState) : null;
assert.equal(addToChatState.vaultPath, "/vault");
assert.equal(addToChatMessage?.resources.length, 1);
assert.equal(addToChatMessage?.resources[0]?.kind, "runsql");

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
const quickTaskMessage = quickTaskTab ? agentComposerStateToMessage(quickTaskTab.draft.editorState) : null;
assert.equal(quickTaskState.vaultPath, "/vault");
assert.equal(quickTaskTab?.entryPoint, "runsql-rewrite");
assert.equal(quickTaskMessage?.segments[0]?.kind, "text");
assert.equal(quickTaskMessage?.resources.length, 1);
assert.equal(quickTaskMessage?.resources.some((resource) => resource.kind === "note"), false);
assert.equal(
  quickTaskMessage?.resources[0]?.kind === "runsql"
    ? quickTaskMessage.resources[0].rewriteTargetId
    : null,
  "target_closed_panel",
);

const fullCanvasRefresh = canvasRefreshTaskInput({
  canvasPath: "/vault/reports/live.stela.canvas",
  canvasTitle: "Live report",
});
assert.equal(fullCanvasRefresh.entryPoint, "canvas-refresh");
assert.equal(fullCanvasRefresh.autoSend, true);
assert.deepEqual(fullCanvasRefresh.canvasRefresh, { path: "reports/live.stela.canvas" });
assert.equal(fullCanvasRefresh.message.resources[0]?.kind, "canvas");
assert.equal(
  fullCanvasRefresh.message.resources[0]?.kind === "canvas"
    ? fullCanvasRefresh.message.resources[0].path
    : null,
  "reports/live.stela.canvas",
);

const sourceCanvasRefresh = canvasRefreshTaskInput({
  canvasPath: "/vault/reports/live.stela.canvas",
  canvasTitle: "Live report",
  source: { id: "revenue_daily", title: "Daily revenue" },
});
assert.deepEqual(sourceCanvasRefresh.canvasRefresh, {
  path: "reports/live.stela.canvas",
  sourceId: "revenue_daily",
});
assert.match(sourceCanvasRefresh.message.segments[0]?.kind === "text" ? sourceCanvasRefresh.message.segments[0].text : "", /revenue_daily/);

console.log("agent history replay tests passed.");
