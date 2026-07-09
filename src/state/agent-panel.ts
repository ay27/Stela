/**
 * Harness agent 面板状态。
 *
 * main 端一次 run 会连续推送多条 [AgentEvent](../../electron/shared/types.ts)；
 * 这里把它们叠成每个 tab 独立的 `timeline`，UI 只管渲染当前 tab。
 */

import { create } from "zustand";

import type { AgentEvent, AgentProposalPayload, AgentToolCallInfo } from "@shared/types";
import { cancelAgent, onAgentEvent, respondAgentProposal, runAgent } from "@/services/agent";
import { useLayout } from "@/state/layout";

export type AgentRunStatus = "idle" | "running" | "done" | "error" | "cancelled";

export interface AgentDraft {
  text: string;
  mentionedTables: string[];
  isEmpty: boolean;
}

export type AgentTimelineEntry =
  | { kind: "user"; id: string; content: string }
  | { kind: "assistant"; id: string; content: string }
  | {
      kind: "tool";
      id: string;
      callId: string;
      name: string;
      args: unknown;
      result?: { ok: boolean; summary: string };
    }
  | {
      kind: "proposal";
      id: string;
      runId: string;
      callId: string;
      proposalKind: "edit_note" | "mutation_sql";
      payload: AgentProposalPayload;
      resolution: "pending" | "approved" | "rejected";
    }
  | { kind: "final"; id: string; content: string }
  | { kind: "error"; id: string; message: string }
  | { kind: "cancelled"; id: string };

export interface AgentTab {
  id: string;
  title: string;
  runId: string | null;
  /** 同一 tab 下的多次 start() 在 main 进程里共享对话历史，实现多轮对话。 */
  sessionId: string;
  status: AgentRunStatus;
  timeline: AgentTimelineEntry[];
  draft: AgentDraft;
  connectionName: string | null;
  resetToken: number;
}

interface AgentPanelState {
  tabs: AgentTab[];
  activeTabId: string;
  switchTab: (tabId: string) => void;
  newConversation: () => void;
  closeTab: (tabId: string) => void;
  setConnectionName: (connectionName: string | null) => void;
  updateDraft: (draft: AgentDraft) => void;
  start: (input: {
    prompt: string;
    mentionedTables?: string[];
    connectionName?: string | null;
    notePath?: string | null;
    locale?: "zh" | "en";
  }) => Promise<void>;
  cancel: () => Promise<void>;
  respondProposal: (runId: string, callId: string, approve: boolean) => Promise<void>;
}

let entrySeq = 0;
function nextId(): string {
  entrySeq += 1;
  return `entry_${entrySeq}`;
}

function newSessionId(): string {
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function newTab(): AgentTab {
  return {
    id: `tab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title: "New",
    runId: null,
    sessionId: newSessionId(),
    status: "idle",
    timeline: [],
    draft: { text: "", mentionedTables: [], isEmpty: true },
    connectionName: null,
    resetToken: 0,
  };
}

const initialTab = newTab();

function toolCallEntry(call: AgentToolCallInfo): AgentTimelineEntry {
  return { kind: "tool", id: nextId(), callId: call.callId, name: call.name, args: call.arguments };
}

function applyEvent(timeline: AgentTimelineEntry[], event: AgentEvent): AgentTimelineEntry[] {
  switch (event.type) {
    case "started":
      return timeline;
    case "assistant_message":
      return [...timeline, { kind: "assistant", id: nextId(), content: event.content }];
    case "tool_call":
      return [...timeline, toolCallEntry(event.call)];
    case "tool_result":
      return timeline.map((entry) =>
        entry.kind === "tool" && entry.callId === event.callId
          ? { ...entry, result: { ok: event.ok, summary: event.summary } }
          : entry,
      );
    case "proposal":
      return [
        ...timeline,
        {
          kind: "proposal",
          id: nextId(),
          runId: event.runId,
          callId: event.callId,
          proposalKind: event.kind,
          payload: event.payload,
          resolution: "pending",
        },
      ];
    case "final":
      return [...timeline, { kind: "final", id: nextId(), content: event.content }];
    case "error":
      return [...timeline, { kind: "error", id: nextId(), message: event.message }];
    case "cancelled":
      return [...timeline, { kind: "cancelled", id: nextId() }];
  }
}

function statusAfter(event: AgentEvent, current: AgentRunStatus): AgentRunStatus {
  switch (event.type) {
    case "final":
      return "done";
    case "error":
      return "error";
    case "cancelled":
      return "cancelled";
    default:
      return current;
  }
}

function updateActiveTab(state: AgentPanelState, patch: (tab: AgentTab) => AgentTab): Pick<AgentPanelState, "tabs"> {
  return {
    tabs: state.tabs.map((tab) => (tab.id === state.activeTabId ? patch(tab) : tab)),
  };
}

function titleFromPrompt(prompt: string): string {
  return prompt.trim().replace(/\s+/g, " ").slice(0, 28) || "New";
}

export const useAgentPanel = create<AgentPanelState>((set, get) => ({
  tabs: [initialTab],
  activeTabId: initialTab.id,
  switchTab(tabId) {
    if (!get().tabs.some((tab) => tab.id === tabId)) return;
    set({ activeTabId: tabId });
  },
  newConversation() {
    const tab = newTab();
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
    useLayout.getState().focusAgentPanel();
  },
  closeTab(tabId) {
    const state = get();
    const tab = state.tabs.find((item) => item.id === tabId);
    if (!tab || state.tabs.length <= 1) return;
    if (tab.status === "running" && tab.runId) void cancelAgent(tab.runId).catch(() => {});
    const index = state.tabs.findIndex((item) => item.id === tabId);
    const tabs = state.tabs.filter((item) => item.id !== tabId);
    const activeTabId =
      state.activeTabId === tabId ? tabs[Math.max(0, index - 1)]?.id ?? tabs[0].id : state.activeTabId;
    set({ tabs, activeTabId });
  },
  setConnectionName(connectionName) {
    set((s) => updateActiveTab(s, (tab) => ({ ...tab, connectionName })));
  },
  updateDraft(draft) {
    set((s) => updateActiveTab(s, (tab) => ({ ...tab, draft })));
  },
  async start({ prompt, mentionedTables, connectionName, notePath, locale }) {
    const state = get();
    const tab = state.tabs.find((item) => item.id === state.activeTabId);
    if (!tab || tab.status === "running") return;
    const runId = `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    useLayout.getState().focusAgentPanel();
    set((s) =>
      updateActiveTab(s, (current) => ({
        ...current,
        runId,
        status: "running",
        title: current.timeline.length === 0 ? titleFromPrompt(prompt) : current.title,
        timeline: [...current.timeline, { kind: "user", id: nextId(), content: prompt }],
        draft: { text: "", mentionedTables: [], isEmpty: true },
        resetToken: current.resetToken + 1,
      })),
    );
    try {
      await runAgent({
        runId,
        sessionId: tab.sessionId,
        prompt,
        mentionedTables,
        connectionName,
        notePath,
        locale,
      });
    } catch (err) {
      set((s) => ({
        tabs: s.tabs.map((current) =>
          current.runId === runId
            ? {
                ...current,
                status: "error",
                timeline: [
                  ...current.timeline,
                  {
                    kind: "error",
                    id: nextId(),
                    message: err instanceof Error ? err.message : String(err),
                  },
                ],
              }
            : current,
        ),
      }));
    }
  },
  async cancel() {
    const tab = get().tabs.find((item) => item.id === get().activeTabId);
    if (!tab?.runId || tab.status !== "running") return;
    await cancelAgent(tab.runId).catch(() => {});
  },
  async respondProposal(runId, callId, approve) {
    const resolution: "approved" | "rejected" = approve ? "approved" : "rejected";
    set((s) => ({
      tabs: s.tabs.map((tab) =>
        tab.runId === runId
          ? {
              ...tab,
              timeline: tab.timeline.map((entry) =>
                entry.kind === "proposal" && entry.callId === callId
                  ? { ...entry, resolution }
                  : entry,
              ),
            }
          : tab,
      ),
    }));
    const response = await respondAgentProposal({ runId, callId, approve }).catch(() => ({ ok: false }));
    if (response.ok) return;
    set((s) => ({
      tabs: s.tabs.map((tab) =>
        tab.runId === runId
          ? (() => {
              const timeline: AgentTimelineEntry[] = tab.timeline.map((entry) =>
                entry.kind === "proposal" && entry.callId === callId
                  ? { ...entry, resolution: "pending" }
                  : entry,
              );
              timeline.push({
                kind: "error",
                id: nextId(),
                message: "Proposal response failed or expired. Please run the edit again.",
              });
              return { ...tab, timeline };
            })()
          : tab,
      ),
    }));
  },
}));

// 全局只订阅一次事件流；按 event.runId 路由到所属 tab，避免多个 tab 同时运行时串线。
onAgentEvent((event) => {
  useAgentPanel.setState((s) => ({
    tabs: s.tabs.map((tab) =>
      event.runId === tab.runId
        ? {
            ...tab,
            timeline: applyEvent(tab.timeline, event),
            status: statusAfter(event, tab.status),
          }
        : tab,
    ),
  }));
});
