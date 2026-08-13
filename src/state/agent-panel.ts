/**
 * Harness agent 面板状态。
 *
 * main 端一次 run 会连续推送多条 [AgentEvent](../../electron/shared/types.ts)；
 * 这里把它们叠成每个 tab 独立的 `timeline`，UI 只管渲染当前 tab。
 */

import { create } from "zustand";
import type { EditorState } from "@milkdown/prose/state";

import type {
  AgentEntryPoint,
  AgentEvent,
  AgentHistoryRef,
  AgentHistorySession,
  AgentHistorySummary,
  AgentMessageResourceInput,
  AgentPlanSnapshot,
  AgentProposalKind,
  AgentProposalPayload,
  AgentToolCallInfo,
  AgentMessageContent,
  AgentWorkspaceContext,
} from "@shared/types";
import { agentMessagePlainText, requestAgentMessage } from "@shared/agent-message";
import {
  presentRunsqlRewriteProposal,
  hasRunsqlRewriteProposal,
  resolveRunsqlRewriteProposal,
} from "@/editor/runsql/agent-rewrite-targets";
import {
  cancelAgent,
  listAgentHistory,
  loadAgentHistory,
  onAgentEvent,
  respondAgentProposal,
  runAgent,
} from "@/services/agent";
import { useLayout } from "@/state/layout";
import { useWorkspace } from "@/state/workspace";
import { scheduleAutoGit } from "@/services/auto-git";
import {
  createAgentComposerState,
  emptyAgentComposerState,
  insertAgentComposerResource,
  isAgentComposerEmpty,
} from "@/lib/agent-composer";

export type AgentRunStatus = "idle" | "running" | "done" | "error" | "cancelled";

export type AgentDraftAttachmentInput = AgentMessageResourceInput;

export interface AgentDraft {
  editorState: EditorState;
  isEmpty: boolean;
}

export type AgentTimelineEntry =
  | {
      kind: "user";
      id: string;
      message: AgentMessageContent;
    }
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
      proposalKind: AgentProposalKind;
      payload: AgentProposalPayload;
      resolution: "pending" | "approved" | "rejected" | "expired";
      /** `question` kind：用户实际给出的答案，供 timeline 回看。 */
      answer?: string;
    }
  | {
      kind: "final";
      id: string;
      runId: string;
      content: string;
      maintenance?: {
        status: "working" | "updated" | "none";
        actions: Array<{ action: "saved" | "archived"; name: string; path: string; reason: string }>;
        summary?: string;
      };
    }
  | { kind: "error"; id: string; message: string }
  | { kind: "cancelled"; id: string }
  | { kind: "interrupted"; id: string }
  | { kind: "canvas"; id: string; path: string; title: string; action: "created" | "updated" }
  | { kind: "plan"; id: string; runId: string; plan: AgentPlanSnapshot };

export interface AgentTab {
  id: string;
  title: string;
  runId: string | null;
  historyRef: AgentHistoryRef | null;
  /** 同一 tab 下的多次 start() 在 main 进程里共享对话历史，实现多轮对话。 */
  sessionId: string;
  entryPoint: AgentEntryPoint;
  status: AgentRunStatus;
  timeline: AgentTimelineEntry[];
  draft: AgentDraft;
  connectionName: string | null;
  contextUsage: {
    usedTokens: number;
    contextWindow: number;
    estimated: boolean;
  } | null;
  compacting: boolean;
}

interface AgentPanelState {
  tabs: AgentTab[];
  activeTabId: string;
  history: AgentHistorySummary[];
  historyLoaded: boolean;
  vaultPath: string | null;
  bindVault: (vaultPath: string | null) => Promise<void>;
  refreshHistory: () => Promise<void>;
  openHistory: (ref: AgentHistoryRef) => Promise<void>;
  switchTab: (tabId: string) => void;
  newConversation: () => void;
  openQuickTask: (input: {
    entryPoint: AgentEntryPoint;
    title: string;
    message: AgentMessageContent;
    connectionName?: string | null;
    locale?: "zh" | "en";
    autoSend: boolean;
  }) => void;
  closeTab: (tabId: string) => void;
  setConnectionName: (connectionName: string | null) => void;
  updateDraft: (draft: AgentDraft) => void;
  addToChat: (attachment: AgentDraftAttachmentInput) => void;
  start: (input: {
    message: AgentMessageContent;
    connectionName?: string | null;
    notePath?: string | null;
    locale?: "zh" | "en";
    entryPoint?: AgentEntryPoint;
  }) => Promise<void>;
  cancel: () => Promise<void>;
  respondProposal: (
    runId: string,
    callId: string,
    approve: boolean,
    answer?: string,
  ) => Promise<void>;
}

let entrySeq = 0;
function nextId(): string {
  entrySeq += 1;
  return `entry_${entrySeq}`;
}

function newSessionId(): string {
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function emptyDraft(): AgentDraft {
  return {
    editorState: emptyAgentComposerState(),
    isEmpty: true,
  };
}

function newTab(): AgentTab {
  return {
    id: `tab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title: "New",
    runId: null,
    historyRef: null,
    sessionId: newSessionId(),
    entryPoint: "chat",
    status: "idle",
    timeline: [],
    draft: emptyDraft(),
    connectionName: null,
    contextUsage: null,
    compacting: false,
  };
}

const initialTab = newTab();

function normalizedCanvasPath(value: string): string {
  const slashPath = value.replace(/\\/g, "/").normalize("NFC");
  const root = slashPath.startsWith("/") ? "/" : slashPath.match(/^[A-Za-z]:\//)?.[0] ?? "";
  const segments: string[] = [];
  for (const segment of slashPath.split("/")) {
    if (!segment || segment === ".") continue;
    if (root && segment === root.replace(/\/$/, "")) continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `${root}${segments.join("/")}`;
}

export function resolveCanvasArtifactPath(canvasPath: string): string {
  const normalizedPath = normalizedCanvasPath(canvasPath);
  if (normalizedPath.startsWith("/") || /^[A-Za-z]:\//.test(normalizedPath)) return normalizedPath;
  const vaultPath = useWorkspace.getState().vaultPath;
  if (!vaultPath) return normalizedPath;
  return `${normalizedCanvasPath(vaultPath).replace(/\/$/, "")}/${normalizedPath.replace(/^\//, "")}`;
}

export function currentWorkspaceContext(): AgentWorkspaceContext | undefined {
  const workspace = useWorkspace.getState();
  const tab = workspace.tabs.find((candidate) => candidate.id === workspace.activeTabId);
  if (!tab?.path) return undefined;
  const normalizedPath = normalizedCanvasPath(tab.path);
  const normalizedVault = workspace.vaultPath ? normalizedCanvasPath(workspace.vaultPath).replace(/\/$/, "") : "";
  const path = normalizedVault && normalizedPath.startsWith(`${normalizedVault}/`)
    ? normalizedPath.slice(normalizedVault.length + 1)
    : normalizedPath;
  return { kind: tab.kind === "analysis" ? "canvas" : "note", path };
}

export function refreshCanvasTabIfOpen(canvasPath: string): void {
  const workspace = useWorkspace.getState();
  const absolutePath = normalizedCanvasPath(resolveCanvasArtifactPath(canvasPath));
  const relativePath = normalizedCanvasPath(canvasPath).replace(/^\//, "");
  const tabId = workspace.getTabIdByPath(absolutePath) ?? workspace.tabs.find((tab) => {
    if (tab.kind !== "analysis" || !tab.path) return false;
    const tabPath = normalizedCanvasPath(tab.path);
    return tabPath === absolutePath || (relativePath.length > 0 && tabPath.endsWith(`/${relativePath}`));
  })?.id ?? null;
  if (tabId) workspace.reloadTabFromBuffer(tabId);
}

function toolCallEntry(call: AgentToolCallInfo): AgentTimelineEntry {
  return { kind: "tool", id: nextId(), callId: call.callId, name: call.name, args: call.arguments };
}

function applyEvent(timeline: AgentTimelineEntry[], event: AgentEvent): AgentTimelineEntry[] {
  switch (event.type) {
    case "started":
    case "context_usage":
    case "compaction":
    case "history_updated":
      return timeline;
    case "canvas_updated":
      if (timeline.some((entry) => entry.kind === "canvas" && entry.path === event.path)) {
        return timeline.map((entry) => entry.kind === "canvas" && entry.path === event.path
          ? { ...entry, title: event.title, action: entry.action === "created" ? "created" : event.action }
          : entry);
      }
      return [...timeline, { kind: "canvas", id: nextId(), path: event.path, title: event.title, action: event.action }];
    case "plan_updated": {
      // 同一 run 的计划快照只保留一条 entry：原地更新，位置固定在首次创建处。
      const index = timeline.findIndex(
        (entry) => entry.kind === "plan" && entry.runId === event.plan.runId,
      );
      if (index === -1) {
        return [...timeline, { kind: "plan", id: nextId(), runId: event.plan.runId, plan: event.plan }];
      }
      return timeline.map((entry, i) =>
        i === index && entry.kind === "plan" ? { ...entry, plan: event.plan } : entry,
      );
    }
    case "skill_maintenance_started":
      return timeline.map((entry) =>
        entry.kind === "final" && entry.runId === event.runId
          ? { ...entry, maintenance: { status: "working", actions: [] } }
          : entry,
      );
    case "skill_maintenance":
      return timeline.map((entry) =>
        entry.kind === "final" && entry.runId === event.runId
          ? {
              ...entry,
              maintenance: {
                status: event.actions.length > 0 ? "updated" : "none",
                actions: event.actions,
                summary: event.summary,
              },
            }
          : entry,
      );
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
      return [...timeline, { kind: "final", id: nextId(), runId: event.runId, content: event.content }];
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

function applyProposalResponse(
  timeline: AgentTimelineEntry[],
  response: { runId: string; callId: string; approve: boolean; answer?: string },
): AgentTimelineEntry[] {
  return timeline.map((entry) =>
    entry.kind === "proposal" && entry.runId === response.runId && entry.callId === response.callId
      ? {
          ...entry,
          resolution: response.approve ? "approved" : "rejected",
          ...(response.answer !== undefined ? { answer: response.answer } : {}),
        }
      : entry,
  );
}

export function replayAgentHistory(history: AgentHistorySession): AgentTimelineEntry[] {
  let timeline: AgentTimelineEntry[] = [];
  for (const run of history.runs) {
    timeline = [
      ...timeline,
      {
        kind: "user",
        id: `history_${run.request.runId}_user`,
        message: requestAgentMessage(run.request),
      },
    ];
    for (const event of run.events) timeline = applyEvent(timeline, event);
    for (const response of run.proposalResponses) timeline = applyProposalResponse(timeline, response);
    if (run.finishedAt === null) {
      timeline = timeline.map((entry) =>
        entry.kind === "proposal" && entry.runId === run.request.runId && entry.resolution === "pending"
          ? { ...entry, resolution: "expired" }
          : entry,
      );
      timeline = [...timeline, { kind: "interrupted", id: `history_${run.request.runId}_interrupted` }];
    }
  }
  return timeline;
}

function tabFromHistory(history: AgentHistorySession): AgentTab {
  const timeline = replayAgentHistory(history);
  const lastEvent = history.runs.at(-1)?.events.at(-1);
  return {
    ...newTab(),
    title: history.summary.title,
    sessionId: history.summary.sessionId,
    historyRef: {
      sessionId: history.summary.sessionId,
      deviceSlug: history.summary.deviceSlug,
    },
    status: history.runs.at(-1)?.finishedAt === null
      ? "cancelled"
      : lastEvent
        ? statusAfter(lastEvent, "idle")
        : "idle",
    timeline,
  };
}

export function isCurrentHistoryTab(
  tab: Pick<AgentTab, "sessionId" | "historyRef">,
  ref: AgentHistoryRef,
  isLocal: boolean,
): boolean {
  return (
    (tab.historyRef?.sessionId === ref.sessionId && tab.historyRef.deviceSlug === ref.deviceSlug) ||
    (isLocal && tab.sessionId === ref.sessionId)
  );
}

export const useAgentPanel = create<AgentPanelState>((set, get) => ({
  tabs: [initialTab],
  activeTabId: initialTab.id,
  history: [],
  historyLoaded: false,
  vaultPath: null,
  async bindVault(vaultPath) {
    if (!vaultPath) {
      const tab = newTab();
      set({ vaultPath: null, history: [], historyLoaded: false, tabs: [tab], activeTabId: tab.id });
      return;
    }
    if (get().vaultPath === vaultPath && get().historyLoaded) return;
    const changedVault = get().vaultPath !== vaultPath;
    const tab = newTab();
    set({
      vaultPath,
      historyLoaded: false,
      ...(changedVault ? { tabs: [tab], activeTabId: tab.id } : {}),
    });
    try {
      const history = await listAgentHistory();
      if (get().vaultPath !== vaultPath) return;
      // 启动/切换 vault 只刷新历史列表，不自动打开最近会话。空白 tab 是明确的
      // 新对话入口；需要续聊时由用户从 History 主动选择。
      set({ history, historyLoaded: true });
    } catch {
      if (get().vaultPath === vaultPath) set({ history: [], historyLoaded: true });
    }
  },
  async refreshHistory() {
    const vaultPath = get().vaultPath;
    if (!vaultPath) return;
    try {
      const history = await listAgentHistory();
      if (get().vaultPath === vaultPath) set({ history, historyLoaded: true });
    } catch {
      // 历史目录暂时不可读时保留已加载列表，避免把可用历史闪成空白。
    }
  },
  async openHistory(ref) {
    const summary = get().history.find(
      (item) => item.sessionId === ref.sessionId && item.deviceSlug === ref.deviceSlug,
    );
    const existing = get().tabs.find(
      (tab) => isCurrentHistoryTab(tab, ref, summary?.isLocal === true),
    );
    if (existing) {
      set((state) => ({
        activeTabId: existing.id,
        tabs: state.tabs.map((tab) =>
          tab.id === existing.id ? { ...tab, historyRef: ref } : tab,
        ),
      }));
      return;
    }
    const history = await loadAgentHistory(ref);
    const tab = tabFromHistory(history);
    set((state) => {
      const active = state.tabs.find((item) => item.id === state.activeTabId);
      const replaceEmpty = state.tabs.length === 1 && active?.timeline.length === 0;
      return {
        tabs: replaceEmpty ? [tab] : [...state.tabs, tab],
        activeTabId: tab.id,
      };
    });
  },
  switchTab(tabId) {
    if (!get().tabs.some((tab) => tab.id === tabId)) return;
    set({ activeTabId: tabId });
  },
  newConversation() {
    const tab = newTab();
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
    useLayout.getState().focusAgentPanel();
  },
  openQuickTask(input) {
    // Agent Panel 未打开过时，它的 React effect 还没有机会 bindVault。
    // 如果先写快捷任务、再由首次挂载触发 bindVault，后者会把 tabs 重置掉，
    // 表现为「只展开面板，草稿/自动发送都消失」。bindVault 在第一个 await
    // 之前同步完成 vault 切换和 tab 初始化，因此这里先触发绑定，再创建任务。
    const workspaceVaultPath = useWorkspace.getState().vaultPath;
    if (workspaceVaultPath && get().vaultPath !== workspaceVaultPath) {
      void get().bindVault(workspaceVaultPath);
    }
    const tab = newTab();
    tab.title = input.title;
    tab.entryPoint = input.entryPoint;
    tab.connectionName = input.connectionName ?? null;
    const editorState = createAgentComposerState(input.message);
    tab.draft = {
      editorState,
      isEmpty: isAgentComposerEmpty(editorState),
    };
    set((state) => ({ tabs: [...state.tabs, tab], activeTabId: tab.id }));
    useLayout.getState().focusAgentPanel();
    if (input.autoSend) {
      void get().start({
        message: input.message,
        connectionName: input.connectionName,
        locale: input.locale,
        entryPoint: input.entryPoint,
      });
    }
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
  addToChat(attachment) {
    // Add to Chat can be invoked before the collapsed Agent Panel has ever
    // mounted. Bind synchronously before inserting, otherwise the mount-time
    // bindVault call replaces the temporary tab and silently drops the pill.
    const workspaceVaultPath = useWorkspace.getState().vaultPath;
    if (workspaceVaultPath && get().vaultPath !== workspaceVaultPath) {
      void get().bindVault(workspaceVaultPath);
    }
    set((s) => updateActiveTab(s, (tab) => {
      const editorState = insertAgentComposerResource(tab.draft.editorState, attachment, {
        collapseSelectionToHead: true,
      });
      return {
        ...tab,
        draft: {
          editorState,
          isEmpty: isAgentComposerEmpty(editorState),
        },
      };
    }));
    useLayout.getState().focusAgentPanel();
  },
  async start({ message, connectionName, notePath, locale, entryPoint }) {
    const state = get();
    const tab = state.tabs.find((item) => item.id === state.activeTabId);
    if (!tab || tab.status === "running") return;
    const prompt = agentMessagePlainText(message).trim().slice(0, 20_000);
    if (!prompt) return;
    const runId = `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    useLayout.getState().focusAgentPanel();
    set((s) =>
      updateActiveTab(s, (current) => ({
        ...current,
        runId,
        status: "running",
        title: current.timeline.length === 0 ? titleFromPrompt(prompt) : current.title,
        timeline: [
          ...current.timeline,
          {
            kind: "user",
            id: nextId(),
            message,
          },
        ],
        draft: emptyDraft(),
      })),
    );
    try {
      const response = await runAgent({
        runId,
        sessionId: tab.sessionId,
        prompt,
        message,
        workspaceContext: currentWorkspaceContext(),
        entryPoint: entryPoint ?? tab.entryPoint,
        connectionName,
        notePath,
        locale,
      });
      if (response.sessionId !== tab.sessionId) {
        set((s) => ({
          tabs: s.tabs.map((current) =>
            current.runId === runId
              ? { ...current, sessionId: response.sessionId, historyRef: null }
              : current,
          ),
        }));
      }
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
  async respondProposal(runId, callId, approve, answer) {
    const proposal = get().tabs
      .flatMap((tab) => tab.timeline)
      .find((entry) => entry.kind === "proposal" && entry.runId === runId && entry.callId === callId);
    if (proposal?.kind === "proposal" && proposal.proposalKind === "runsql_rewrite") {
      const targetId = proposal.payload.targetId;
      if (!targetId || (approve && !hasRunsqlRewriteProposal(targetId, runId, callId))) {
        set((state) => ({
          tabs: state.tabs.map((tab) => tab.runId === runId
            ? { ...tab, timeline: [...tab.timeline, { kind: "error", id: nextId(), message: "The RunSQL block changed or is no longer available." }] }
            : tab),
        }));
        return;
      }
    }
    const resolution: "approved" | "rejected" = approve ? "approved" : "rejected";
    set((s) => ({
      tabs: s.tabs.map((tab) =>
        tab.runId === runId
          ? {
              ...tab,
              timeline: tab.timeline.map((entry) =>
                entry.kind === "proposal" && entry.callId === callId
                  ? { ...entry, resolution, answer }
                  : entry,
              ),
            }
          : tab,
      ),
    }));
    const response = await respondAgentProposal({
      runId,
      callId,
      approve,
      ...(answer !== undefined ? { answer } : {}),
    }).catch(() => ({ ok: false }));
    if (response.ok) {
      if (proposal?.kind === "proposal" && proposal.proposalKind === "runsql_rewrite" && proposal.payload.targetId) {
        resolveRunsqlRewriteProposal({
          targetId: proposal.payload.targetId,
          runId,
          callId,
          approve,
        });
      }
      return;
    }
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
if (typeof window !== "undefined") {
  onAgentEvent((event) => {
    useAgentPanel.setState((s) => ({
      tabs: s.tabs.map((tab) => {
        const currentRun = event.runId === tab.runId;
        const historicalMaintenance =
          (event.type === "skill_maintenance_started" || event.type === "skill_maintenance") &&
          tab.timeline.some((entry) => entry.kind === "final" && entry.runId === event.runId);
        if (!currentRun && !historicalMaintenance) return tab;
        const next: AgentTab = {
          ...tab,
          timeline: applyEvent(tab.timeline, event),
          status: currentRun ? statusAfter(event, tab.status) : tab.status,
        };
        if (event.type === "context_usage") {
          next.contextUsage = {
            usedTokens: event.usedTokens,
            contextWindow: event.contextWindow,
            estimated: event.estimated,
          };
        }
        if (event.type === "compaction") {
          next.compacting = event.phase === "started";
        }
        if (event.type === "final" || event.type === "error" || event.type === "cancelled") {
          next.compacting = false;
        }
        return next;
      }),
    }));
    if (event.type === "history_updated") {
      void useAgentPanel.getState().refreshHistory();
    }
    if (event.type === "canvas_updated") {
      scheduleAutoGit("canvas-agent-update");
      refreshCanvasTabIfOpen(event.path);
    }
    if (event.type === "proposal" && event.kind === "runsql_rewrite") {
      const { targetId, oldContent, newContent } = event.payload;
      const showProposal = () => Boolean(targetId && oldContent !== undefined && newContent !== undefined) &&
        presentRunsqlRewriteProposal({
          targetId: targetId!,
          runId: event.runId,
          callId: event.callId,
          originalSql: oldContent!,
          proposedSql: newContent!,
          onApprove: () => void useAgentPanel.getState().respondProposal(event.runId, event.callId, true),
          onReject: () => void useAgentPanel.getState().respondProposal(event.runId, event.callId, false),
        });
      if (!showProposal()) {
        window.setTimeout(() => {
          if (!showProposal()) {
            void useAgentPanel.getState().respondProposal(event.runId, event.callId, false);
          }
        }, 100);
      }
    }
  });
}
