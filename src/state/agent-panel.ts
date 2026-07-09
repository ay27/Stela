/**
 * Harness agent 面板状态。
 *
 * main 端一次 run 会连续推送多条 [AgentEvent](../../electron/shared/types.ts)；
 * 这里把它们叠成一条 `timeline`，UI 只管渲染 timeline，不用关心事件到达顺序的
 * 细节（tool_call 和随后的 tool_result 会合并进同一条 timeline entry）。
 */

import { create } from "zustand";

import type { AgentEvent, AgentToolCallInfo } from "@shared/types";
import { cancelAgent, onAgentEvent, respondAgentProposal, runAgent } from "@/services/agent";
import { useLayout } from "@/state/layout";

export type AgentRunStatus = "idle" | "running" | "done" | "error" | "cancelled";

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
      callId: string;
      proposalKind: "edit_note" | "mutation_sql";
      payload: { notePath?: string; sql?: string; description: string };
      resolution: "pending" | "approved" | "rejected";
    }
  | { kind: "final"; id: string; content: string }
  | { kind: "error"; id: string; message: string }
  | { kind: "cancelled"; id: string };

interface AgentPanelState {
  runId: string | null;
  /** 本次对话的会话 id；同一 id 下的多次 start() 在 main 进程里共享对话历史，实现多轮对话。 */
  sessionId: string | null;
  status: AgentRunStatus;
  timeline: AgentTimelineEntry[];
  start: (input: {
    prompt: string;
    connectionName?: string | null;
    notePath?: string | null;
    locale?: "zh" | "en";
  }) => Promise<void>;
  cancel: () => Promise<void>;
  respondProposal: (callId: string, approve: boolean) => Promise<void>;
  /** 清空 timeline 并断开会话，下一次 start() 会开启一段全新的对话。 */
  newConversation: () => void;
}

let entrySeq = 0;
function nextId(): string {
  entrySeq += 1;
  return `entry_${entrySeq}`;
}

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

function newSessionId(): string {
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export const useAgentPanel = create<AgentPanelState>((set, get) => ({
  runId: null,
  sessionId: null,
  status: "idle",
  timeline: [],
  async start({ prompt, connectionName, notePath, locale }) {
    const runId = `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const sessionId = get().sessionId ?? newSessionId();
    useLayout.getState().focusAgentPanel();
    set((s) => ({
      runId,
      sessionId,
      status: "running",
      timeline: [...s.timeline, { kind: "user", id: nextId(), content: prompt }],
    }));
    try {
      await runAgent({ runId, sessionId, prompt, connectionName, notePath, locale });
    } catch (err) {
      set((s) => ({
        status: "error",
        timeline: [
          ...s.timeline,
          { kind: "error", id: nextId(), message: err instanceof Error ? err.message : String(err) },
        ],
      }));
    }
  },
  newConversation() {
    if (get().status === "running") void get().cancel();
    set({ runId: null, sessionId: null, status: "idle", timeline: [] });
  },
  async cancel() {
    const runId = get().runId;
    if (!runId || get().status !== "running") return;
    await cancelAgent(runId).catch(() => {});
  },
  async respondProposal(callId, approve) {
    const runId = get().runId;
    if (!runId) return;
    set((s) => ({
      timeline: s.timeline.map((entry) =>
        entry.kind === "proposal" && entry.callId === callId
          ? { ...entry, resolution: approve ? "approved" : "rejected" }
          : entry,
      ),
    }));
    await respondAgentProposal({ runId, callId, approve }).catch(() => {});
  },
}));

// 全局只订阅一次事件流；按 event.runId 过滤，忽略不属于当前 run 的旧事件
// （用户可能在上一次 run 还没收尾时就取消 + 开新的一轮）。
onAgentEvent((event) => {
  const state = useAgentPanel.getState();
  if (event.runId !== state.runId) return;
  useAgentPanel.setState((s) => ({
    timeline: applyEvent(s.timeline, event),
    status: statusAfter(event, s.status),
  }));
});
