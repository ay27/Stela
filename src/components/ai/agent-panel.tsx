import { useCallback, useEffect, useMemo, useRef, useState, type WheelEvent } from "react";
import {
  Bot,
  Brain,
  ChartNoAxesCombined,
  CheckCircle2,
  ChevronDown,
  Circle,
  Database,
  FileText,
  HelpCircle,
  History,
  Loader2,
  MessageSquareQuote,
  MinusCircle,
  Plus,
  Send,
  ShieldAlert,
  StopCircle,
  X,
  XCircle,
} from "lucide-react";
import type { AgentMessageContent, AgentMessageResource, AgentPlanSnapshot } from "@shared/types";
import { withAgentResourceId } from "@shared/agent-message";

import { ProposalLineDiff } from "./proposal-diff";
import { i18n } from "@/i18n";
import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";
import { fuzzyFilter } from "@/lib/fuzzy";
import { getRunContext } from "@/editor/runsql/run-context";
import {
  ensureAutocompleteFor,
  peekAutocompleteFor,
} from "@/editor/runsql/fetch-schema";
import {
  resolveCanvasArtifactPath,
  useAgentPanel,
  type AgentTimelineEntry,
} from "@/state/agent-panel";
import { useLayout } from "@/state/layout";
import { useConnections } from "@/state/connections";
import { useWorkspace } from "@/state/workspace";
import { useSettings } from "@/state/settings";
import { firstConnectionName } from "@/services/connections";
import { ConnectionPicker } from "@/components/connection-picker";

import {
  AiPromptInput,
  type AiPromptInputHandle,
  type AiPromptSubmitPayload,
} from "./ai-prompt-input";
import { renderMarkdown } from "./markdown-renderer";
import { isAgentMessageEmpty } from "@/lib/agent-message";

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function isCanvasPath(path: string): boolean {
  return path.toLowerCase().endsWith(".stela.canvas");
}

function relativeToVault(path: string | null | undefined, vaultPath: string | null): string | null {
  if (!path) return null;
  if (!vaultPath) return path;
  const normalizedVault = vaultPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = path.replace(/\\/g, "/");
  if (normalizedPath.startsWith(`${normalizedVault}/`)) {
    return normalizedPath.slice(normalizedVault.length + 1);
  }
  return normalizedPath;
}

/** Compact SVG ring for approximate context-window usage. */
function ContextUsageRing({
  usedTokens,
  contextWindow,
  estimated,
}: {
  usedTokens: number;
  contextWindow: number;
  estimated: boolean;
}) {
  const percent = Math.min(100, Math.max(0, Math.round((usedTokens / contextWindow) * 100)));
  const size = 16;
  const stroke = 2;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - percent / 100);
  const tone =
    percent >= 90 ? "text-destructive" : percent >= 70 ? "text-amber-500" : "text-primary";

  return (
    <span
      className={cn("relative flex h-4 w-4 flex-none items-center justify-center", tone)}
      title={
        estimated
          ? `Context ~${percent}% · ${usedTokens} / ${contextWindow} (estimated)`
          : `Context ~${percent}% · ${usedTokens} / ${contextWindow}`
      }
      aria-label={`Context ~${percent}%`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          className="opacity-20"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>
    </span>
  );
}

/**
 * 应用级全局 Agent 面板主体，嵌在 [AgentSidebar](../../layout/AgentSidebar.tsx)
 * 里——一条独立于左侧文件树 / 文档目录的常驻右侧栏，视觉上用边框跟文档区分开，
 * 强调它是"全局"而非"当前文档"范畴的工具。
 */
export function AgentPanel() {
  const t = useT();
  const tabs = useAgentPanel((s) => s.tabs);
  const activeTabId = useAgentPanel((s) => s.activeTabId);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  const status = activeTab.status;
  const timeline = activeTab.timeline;
  const draft = activeTab.draft;
  const resetToken = activeTab.resetToken;
  const connectionName = activeTab.connectionName;
  const contextUsage = activeTab.contextUsage;
  const compacting = activeTab.compacting;
  const history = useAgentPanel((s) => s.history);
  const historyLoaded = useAgentPanel((s) => s.historyLoaded);
  const vaultPath = useWorkspace((s) => s.vaultPath);
  const focusToken = useLayout((s) => s.agentFocusToken);
  const aiSettings = useSettings((s) => s.settings.ai);
  const patchSettings = useSettings((s) => s.patch);
  const switchTab = useAgentPanel((s) => s.switchTab);
  const start = useAgentPanel((s) => s.start);
  const cancel = useAgentPanel((s) => s.cancel);
  const respondProposal = useAgentPanel((s) => s.respondProposal);
  const newConversation = useAgentPanel((s) => s.newConversation);
  const bindVault = useAgentPanel((s) => s.bindVault);
  const refreshHistory = useAgentPanel((s) => s.refreshHistory);
  const openHistory = useAgentPanel((s) => s.openHistory);
  const closeTab = useAgentPanel((s) => s.closeTab);
  const setConnectionName = useAgentPanel((s) => s.setConnectionName);
  const updateDraft = useAgentPanel((s) => s.updateDraft);
  const scrollRef = useRef<HTMLDivElement>(null);
  const historyMenuRef = useRef<HTMLDetailsElement>(null);
  const promptInputRef = useRef<AiPromptInputHandle>(null);
  const canvasMentionPathsRef = useRef<string[]>([]);
  const busy = status === "running";
  // 连续的 tool entries 就地合成一条 ToolActivity：执行记录跟随产生它的那一轮，
  // 不再跨轮次汇总到最底部。pending 的 question 从 timeline 摘出，固定到输入框上方。
  const timelineItems = useMemo(() => groupTimeline(timeline), [timeline]);
  const pendingQuestion = timeline.find(
    (entry): entry is Extract<AgentTimelineEntry, { kind: "proposal" }> =>
      entry.kind === "proposal" && entry.proposalKind === "question" && entry.resolution === "pending",
  );

  const connectionEntries = useConnections((s) => s.entries);
  const connectionsLoaded = useConnections((s) => s.loaded);
  const reloadConnections = useConnections((s) => s.reload);

  useEffect(() => {
    if (!connectionsLoaded) void reloadConnections();
  }, [connectionsLoaded, reloadConnections]);

  useEffect(() => {
    void bindVault(vaultPath);
  }, [vaultPath, bindVault]);

  // 当前文档的连接 > 默认连接（isDefault 标记 / 名称首个）> 空。与
  // EditorView 的 frontmatter 兜底规则保持一致，避免多连接时每次都要手选。
  useEffect(() => {
    if (connectionName !== null) return;
    const ctx = getRunContext();
    if (ctx?.connectionName) {
      setConnectionName(ctx.connectionName);
      return;
    }
    if (!connectionsLoaded) return;
    const fallback = firstConnectionName(connectionEntries);
    if (fallback) setConnectionName(fallback);
  }, [activeTabId, connectionName, connectionsLoaded, connectionEntries, setConnectionName]);

  useEffect(() => {
    if (focusToken > 0) promptInputRef.current?.focus();
  }, [focusToken]);

  useEffect(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!historyMenuRef.current?.contains(event.target as Node)) historyMenuRef.current?.removeAttribute("open");
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") historyMenuRef.current?.removeAttribute("open");
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  useEffect(() => {
    let active = true;
    canvasMentionPathsRef.current = [];
    const unsubscribe = window.stela.vault.onExternalChange((payload) => {
      if (!active || payload.vaultPath !== vaultPath) return;
      for (const event of payload.events) {
        if (event.isDir || !isCanvasPath(event.path)) continue;
        const relative = relativeToVault(event.path, vaultPath);
        if (!relative) continue;
        canvasMentionPathsRef.current = event.type === "removed"
          ? canvasMentionPathsRef.current.filter((path) => path !== relative)
          : uniqueStrings([...canvasMentionPathsRef.current, relative]);
      }
    });
    if (vaultPath) {
      void window.stela.search.listFiles(vaultPath, [".stela.canvas"])
        .then((files) => {
          if (!active) return;
          canvasMentionPathsRef.current = files.flatMap((file) => {
            const relative = relativeToVault(file, vaultPath);
            return relative ? [relative] : [];
          });
        })
        .catch(() => {});
    }
    return () => { active = false; unsubscribe(); };
  }, [vaultPath]);

  useEffect(() => {
    const createdOrUpdated = timeline.flatMap((entry) => entry.kind === "canvas" ? [entry.path] : []);
    if (createdOrUpdated.length > 0) {
      canvasMentionPathsRef.current = uniqueStrings([...canvasMentionPathsRef.current, ...createdOrUpdated]);
    }
  }, [timeline]);

  const getResourceCandidates = useCallback(async (query: string): Promise<AgentMessageResource[]> => {
    const tableNames = connectionName
      ? (peekAutocompleteFor(connectionName).length > 0
          ? peekAutocompleteFor(connectionName)
          : await ensureAutocompleteFor(connectionName).catch(() => []))
      : [];
    const indexCandidates = await window.stela.index.listCandidates(query, 24).catch(() => []);
    const notes = indexCandidates
      .filter((candidate) => candidate.kind === "file" && candidate.detail && !isCanvasPath(candidate.detail))
      .map((candidate) => withAgentResourceId({
        kind: "note" as const,
        path: candidate.detail!,
        label: candidate.detail!.split("/").pop() || candidate.detail!,
      }));
    const canvases = canvasMentionPathsRef.current.map((path) => withAgentResourceId({
      kind: "canvas" as const,
      path,
      label: path.split("/").pop() || path,
    }));
    const tables = tableNames.map((table) => withAgentResourceId({
      kind: "table" as const,
      table,
      label: table,
      connectionName,
    }));
    const sourcePath = relativeToVault(getRunContext()?.path, vaultPath);
    const runsql = Array.from(document.querySelectorAll<HTMLElement>(".stela-cb--runsql"))
      .flatMap((block, blockIndex) => {
        const sql = block.querySelector<HTMLElement>(".cm-content")?.textContent?.trim();
        if (!sql) return [];
        return [withAgentResourceId({
          kind: "runsql" as const,
          label: sql.split(/\r?\n/, 1)[0]?.slice(0, 48) || `RunSQL ${blockIndex + 1}`,
          sql,
          sourcePath: sourcePath ?? undefined,
          locator: { blockIndex, keyword: sql, nthInFile: 0 },
        })];
      });
    const combined = [...tables, ...notes, ...canvases, ...runsql];
    const needle = query.trim();
    return needle
      ? fuzzyFilter(needle, combined, (resource) => `${resource.kind} ${resource.label}`, 24)
      : combined.slice(0, 24);
  }, [connectionName, vaultPath]);
  const onWheelScroll = useCallback((ev: WheelEvent<HTMLDivElement>) => {
    if (ev.deltaX === 0 && ev.deltaY !== 0) {
      ev.currentTarget.scrollLeft += ev.deltaY;
    }
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [activeTabId, timeline]);

  const send = ({ message }: AiPromptSubmitPayload) => {
    if (isAgentMessageEmpty(message) || busy) return;
    const ctx = getRunContext();
    void start({
      message,
      connectionName,
      notePath: ctx?.path ?? null,
      locale: i18n.resolvedLanguage?.startsWith("zh") ? "zh" : "en",
    });
  };

  const updatePromptDraft = useCallback(
    (value: { message: AgentMessageContent; cursorOffset: number; isEmpty: boolean }) => {
      updateDraft({
        message: value.message,
        cursorOffset: value.cursorOffset,
        isEmpty: isAgentMessageEmpty(value.message),
      });
    },
    [draft, updateDraft],
  );

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <div className="flex h-9 flex-none items-stretch border-b border-border bg-muted/60">
        <div className="stela-tabbar-scroll flex min-w-0 flex-1 items-stretch overflow-x-auto" onWheel={onWheelScroll}>
          {tabs.map((tab, idx) => {
            const active = tab.id === activeTabId;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => switchTab(tab.id)}
                className={cn(
                  "group relative flex min-w-[104px] max-w-[180px] shrink-0 cursor-pointer select-none items-center gap-2 px-3 text-[12px] transition-colors",
                  active
                    ? "bg-background text-foreground"
                    : "text-muted-foreground hover:bg-background/50 hover:text-foreground",
                  idx > 0 && !active && "border-l border-border",
                )}
                title={tab.title}
              >
                <span
                  className={cn(
                    "pointer-events-none absolute inset-x-0 bottom-0 h-[2px]",
                    active ? "bg-primary" : "bg-transparent",
                  )}
                />
                {tab.status === "running" ? (
                  <Loader2 className="h-3 w-3 flex-none animate-spin text-primary" />
                ) : (
                  <Bot className="h-3.5 w-3.5 flex-none text-muted-foreground" />
                )}
                <span className="flex-1 truncate">{tab.title}</span>
                {tabs.length > 1 ? (
                  <span
                    role="button"
                    tabIndex={-1}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      closeTab(tab.id);
                    }}
                    className={cn(
                      "flex h-4 w-4 flex-none items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground",
                      active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                    )}
                    title={t("agent.panel.closeTab")}
                  >
                    <X className="h-3 w-3" />
                  </span>
                ) : null}
              </button>
            );
          })}
          <div className="flex-1 border-b border-border/0" />
        </div>
        <details
          ref={historyMenuRef}
          className="group relative border-l border-border"
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) {
              historyMenuRef.current?.removeAttribute("open");
            }
          }}
          onToggle={(event) => {
            if (event.currentTarget.open) void refreshHistory();
          }}
        >
          <summary
            className="flex h-full cursor-pointer list-none items-center gap-1 px-2 text-[11px] text-muted-foreground hover:bg-background/50 hover:text-foreground [&::-webkit-details-marker]:hidden"
            title={t("agent.panel.history")}
          >
            <History className="h-3.5 w-3.5" />
            {t("agent.panel.history")}
          </summary>
          <div className="absolute right-0 top-9 z-20 max-h-64 w-64 overflow-auto rounded-md border border-border bg-popover p-1 shadow-md">
            {!historyLoaded ? (
              <div className="px-2 py-1.5 text-[11px] text-muted-foreground">{t("agent.panel.historyLoading")}</div>
            ) : history.length === 0 ? (
              <div className="px-2 py-1.5 text-[11px] text-muted-foreground">{t("agent.panel.historyEmpty")}</div>
            ) : (
              history.map((item) => (
                <button
                  key={`${item.deviceSlug}:${item.sessionId}`}
                  type="button"
                  onClick={() => {
                    historyMenuRef.current?.removeAttribute("open");
                    void openHistory(item);
                  }}
                  className="flex w-full flex-col rounded px-2 py-1.5 text-left text-[11px] hover:bg-accent"
                >
                  <span className="truncate text-foreground">{item.title}</span>
                  <span className="text-muted-foreground">{item.deviceSlug}</span>
                </button>
              ))
            )}
          </div>
        </details>
        <button
          type="button"
          onClick={newConversation}
          className="flex w-8 flex-none items-center justify-center border-l border-border text-muted-foreground hover:bg-background/50 hover:text-foreground"
          title={t("agent.panel.newConversation")}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex h-8 flex-none items-center gap-2 border-b border-border bg-muted/20 px-3.5">
        <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-[12px] font-medium text-muted-foreground">
          <Bot className="h-3.5 w-3.5 flex-none text-primary" />
          {t("agent.panel.title")}
        </span>
        {contextUsage && contextUsage.contextWindow > 0 ? (
          <ContextUsageRing
            usedTokens={contextUsage.usedTokens}
            contextWindow={contextUsage.contextWindow}
            estimated={contextUsage.estimated}
          />
        ) : null}
        {compacting ? (
          <span className="flex flex-none items-center gap-1 text-[11px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t("agent.panel.compacting")}
          </span>
        ) : null}
        <ConnectionPicker value={connectionName} onChange={setConnectionName} />
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-2.5 overflow-auto px-3.5 py-2.5">
        {timeline.length === 0 ? (
          <div className="text-[12px] text-muted-foreground">{t("agent.panel.empty")}</div>
        ) : (
          timelineItems.map((item) =>
            item.kind === "tools" ? (
              <ToolActivity key={item.id} entries={item.entries} />
            ) : (
              <TimelineItem key={item.entry.id} entry={item.entry} onRespond={respondProposal} />
            ),
          )
        )}
        {busy ? (
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t("agent.panel.thinking")}
          </div>
        ) : null}
      </div>

      {pendingQuestion ? (
        <div className="border-t border-border bg-muted/20 px-2.5 pt-2">
          <QuestionCard entry={pendingQuestion} onRespond={respondProposal} />
        </div>
      ) : null}

      <div className="border-t border-border bg-muted/20 px-2.5 py-2">
        <AiPromptInput
          key={activeTabId}
          ref={promptInputRef}
          resetToken={resetToken}
          value={draft.message}
          cursorOffset={draft.cursorOffset}
          placeholder={t("agent.panel.placeholder")}
          disabled={busy}
          submitEnabled={!draft.isEmpty}
          minHeightPx={132}
          getResourceCandidates={getResourceCandidates}
          onChange={updatePromptDraft}
          onSubmit={send}
          onOpenResource={openAgentResource}
        />
        {/* 独立一行放操作按钮——左侧切 AI 配置档，Send/Stop 占最右。 */}
        <div className="mt-1.5 flex items-center justify-between gap-1.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <button
              type="button"
              disabled={busy}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => promptInputRef.current?.openResourcePicker()}
              title={t("agent.panel.addResource")}
              className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-md border border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          {aiSettings.profiles.length > 0 ? (
            <select
              value={aiSettings.activeProfileId}
              disabled={busy}
              title={t("agent.panel.provider")}
              onChange={(e) => {
                const id = e.target.value;
                void patchSettings({ ai: { activeProfileId: id } });
                void window.stela.ai.configure({ activeProfileId: id });
              }}
              className="max-w-[55%] truncate rounded-md border border-border bg-background px-1.5 py-1.5 text-[11px] text-foreground disabled:opacity-40"
            >
              {aiSettings.profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                  {profile.model ? ` · ${profile.model}` : ""}
                </option>
              ))}
            </select>
          ) : null}
          </div>
          {busy ? (
            <button
              type="button"
              onClick={() => void cancel()}
              title={t("agent.panel.cancel")}
              className="inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] font-medium text-destructive hover:bg-destructive/20"
            >
              <StopCircle className="h-3.5 w-3.5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => send({ message: draft.message })}
              disabled={draft.isEmpty}
              title={t("agent.panel.send")}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1.5 text-[11px] font-medium text-primary-foreground disabled:opacity-40"
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

type ToolEntry = Extract<AgentTimelineEntry, { kind: "tool" }>;
type TimelineRenderItem =
  | { kind: "entry"; entry: AgentTimelineEntry }
  | { kind: "tools"; id: string; entries: ToolEntry[] };

/**
 * 把连续的 tool entries 合成一个 ToolActivity 组，位置保持在它们产生的轮次里。
 * pending 的 question 摘出 timeline（固定在输入框上方），回答/跳过后自然落回成气泡。
 */
function groupTimeline(timeline: AgentTimelineEntry[]): TimelineRenderItem[] {
  const items: TimelineRenderItem[] = [];
  for (const entry of timeline) {
    if (entry.kind === "proposal" && entry.proposalKind === "question" && entry.resolution === "pending") {
      continue;
    }
    if (entry.kind === "tool") {
      const last = items[items.length - 1];
      if (last?.kind === "tools") {
        last.entries.push(entry);
      } else {
        items.push({ kind: "tools", id: entry.id, entries: [entry] });
      }
      continue;
    }
    items.push({ kind: "entry", entry });
  }
  return items;
}

function TimelineItem({
  entry,
  onRespond,
}: {
  entry: AgentTimelineEntry;
  onRespond: (runId: string, callId: string, approve: boolean, answer?: string) => Promise<void>;
}) {
  const t = useT();
  switch (entry.kind) {
    case "user":
      return (
        <div className="flex justify-end">
          <div className="max-w-[80%] rounded-lg bg-muted px-3 py-2 text-sm text-foreground">
            <AgentUserMessage message={entry.message} />
          </div>
        </div>
      );
    case "final":
      return (
        <div className="relative rounded-lg border border-border bg-card/40 p-3 pb-6">
          <AssistantMessage content={entry.content} />
          {entry.maintenance ? <SkillMaintenanceIndicator maintenance={entry.maintenance} /> : null}
        </div>
      );
    case "error":
      return (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {entry.message}
        </div>
      );
    case "cancelled":
      return <div className="text-xs italic text-muted-foreground">{t("agent.panel.cancelled")}</div>;
    case "interrupted":
      return (
        <div className="flex items-center gap-1.5 text-xs italic text-muted-foreground">
          <History className="h-3 w-3" />
          {t("agent.panel.interrupted")}
        </div>
      );
    case "canvas":
      return <button type="button" onClick={() => useWorkspace.getState().openFile(resolveCanvasArtifactPath(entry.path))} className="w-full rounded-lg border border-primary/30 bg-primary/5 p-3 text-left text-xs hover:bg-primary/10"><div className="font-medium text-foreground">{entry.title}</div><div className="mt-1 text-muted-foreground">{t(entry.action === "created" ? "agent.panel.canvasCreated" : "agent.panel.canvasUpdated")} · {t("agent.panel.openCanvas")}</div></button>;
    case "plan":
      return <ExecutionPlanCard plan={entry.plan} />;
    case "tool":
      return <ToolChip entry={entry} />;
    case "proposal":
      return <ProposalCard entry={entry} onRespond={onRespond} />;
  }
}

function openAgentResource(resource: AgentMessageResource): void {
  if (resource.kind === "table") {
    useLayout.getState().revealSchemaTable(resource.connectionName ?? null, resource.table);
    return;
  }
  if (resource.kind === "note" || resource.kind === "canvas") {
    useWorkspace.getState().openFile(resolveCanvasArtifactPath(resource.path));
    return;
  }
  if (!resource.sourcePath) return;
  const keyword = resource.locator?.keyword ?? (resource.kind === "runsql" ? resource.sql : resource.text);
  useWorkspace.getState().openFile(resolveCanvasArtifactPath(resource.sourcePath), {
    ...(resource.kind === "runsql" ? {
      runsqlBlockId: resource.locator?.blockId,
      runsqlBlockIndex: resource.locator?.blockIndex,
      runsqlSql: resource.sql,
    } : {}),
    ...(keyword ? { keyword, nthInFile: resource.locator?.nthInFile ?? 0 } : {}),
    ...(resource.locator?.line ? {
      scrollToLine: resource.locator.line,
      scrollToColumn: resource.locator.column,
    } : {}),
  });
}

function ResourceIcon({ kind }: { kind: AgentMessageResource["kind"] }) {
  if (kind === "table" || kind === "runsql") return <Database className="h-3 w-3 flex-none text-primary" />;
  if (kind === "canvas") return <ChartNoAxesCombined className="h-3 w-3 flex-none text-primary" />;
  if (kind === "selection") return <MessageSquareQuote className="h-3 w-3 flex-none text-primary" />;
  return <FileText className="h-3 w-3 flex-none text-primary" />;
}

function AgentResourcePill({ resource }: { resource: AgentMessageResource }) {
  return (
    <button
      type="button"
      onClick={() => openAgentResource(resource)}
      title={resource.label}
      className="mx-0.5 inline-flex max-w-full translate-y-[1px] items-center gap-1 rounded-md border border-primary/25 bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-primary/10 hover:text-foreground"
    >
      <ResourceIcon kind={resource.kind} />
      <span className="text-[9px] font-medium uppercase text-primary/80">{resource.kind}</span>
      <span className="max-w-[180px] truncate">{resource.label}</span>
    </button>
  );
}

function AgentUserMessage({ message }: { message: AgentMessageContent }) {
  const resources = new Map(message.resources.map((resource) => [resource.id, resource]));
  return (
    <div className="whitespace-pre-wrap break-words">
      {message.segments.map((segment, index) => {
        if (segment.kind === "text") return <span key={`text-${index}`}>{segment.text}</span>;
        const resource = resources.get(segment.resourceId);
        return resource ? <AgentResourcePill key={`resource-${index}`} resource={resource} /> : null;
      })}
    </div>
  );
}

function SkillMaintenanceIndicator({
  maintenance,
}: {
  maintenance: NonNullable<Extract<AgentTimelineEntry, { kind: "final" }>["maintenance"]>;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const working = maintenance.status === "working";
  const updated = maintenance.status === "updated";
  const names = maintenance.actions.map((action) => action.name).join("、");
  const detail = working
    ? t("agent.panel.skillWorking")
    : updated
      ? t("agent.panel.skillUpdated", { names })
      : t("agent.panel.skillAllMaintained");
  return (
    <div
      className="absolute bottom-1.5 right-2"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setExpanded(false);
      }}
    >
      <button
        type="button"
        aria-label={detail}
        title={detail}
        onClick={() => setExpanded((value) => !value)}
        className={cn(
          "flex h-4 w-4 items-center justify-center rounded-full transition-colors",
          working
            ? "text-muted-foreground"
            : updated
              ? "bg-primary/10 text-primary hover:bg-primary/20"
              : "text-muted-foreground/60 hover:bg-muted hover:text-muted-foreground",
        )}
      >
        {working ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <Brain className="h-3 w-3" />
        )}
      </button>
      {expanded ? (
        <div className="absolute bottom-6 right-0 z-10 w-64 rounded-md border border-border bg-popover p-2 text-[11px] text-popover-foreground shadow-md">
          <div className="font-medium">{t("agent.panel.skillMaintenance")}</div>
          <p className="mt-1 text-muted-foreground">{detail}</p>
          {updated ? (
            <div className="mt-2 space-y-1 border-t border-border pt-2">
              {maintenance.actions.map((action) => (
                <div key={`${action.action}-${action.path}`}>
                  {action.action === "saved" ? t("agent.panel.skillSaved") : t("agent.panel.skillArchived")} · {action.name}
                  <span className="text-muted-foreground"> — {action.reason}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function AssistantMessage({ content }: { content: string }) {
  if (!content.trim()) return null;
  return <div className="stela-ai-markdown text-sm leading-6">{renderMarkdown(content)}</div>;
}

function PlanStepIcon({ status }: { status: AgentPlanSnapshot["steps"][number]["status"] }) {
  switch (status) {
    case "completed":
      return <CheckCircle2 className="h-3.5 w-3.5 flex-none text-primary" />;
    case "running":
      return <Loader2 className="h-3.5 w-3.5 flex-none animate-spin text-primary" />;
    case "blocked":
      return <XCircle className="h-3.5 w-3.5 flex-none text-destructive" />;
    case "skipped":
      return <MinusCircle className="h-3.5 w-3.5 flex-none text-muted-foreground" />;
    default:
      return <Circle className="h-3.5 w-3.5 flex-none text-muted-foreground/50" />;
  }
}

function ExecutionPlanCard({ plan }: { plan: AgentPlanSnapshot }) {
  const t = useT();
  const [expanded, setExpanded] = useState(true);
  const completed = plan.steps.filter((step) => ["completed", "skipped"].includes(step.status)).length;
  const current = plan.steps.find((step) => step.status === "running" || step.status === "blocked");
  return (
    <div className="rounded-lg border border-primary/20 bg-primary/5 text-xs">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center justify-between gap-2 px-2.5 py-2 text-left font-medium"
      >
        <span>{t("agent.panel.planProgress", { completed, total: plan.steps.length })}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
          <span className="truncate">
            {current?.status === "blocked" ? t("agent.panel.blocked") : current?.title}
          </span>
          <ChevronDown className={cn("h-3 w-3 flex-none transition-transform", expanded && "rotate-180")} />
        </span>
      </button>
      {expanded ? (
        <ol className="space-y-1.5 border-t border-primary/10 px-2.5 py-2">
          {plan.steps.map((step) => (
            <li key={step.id} className="flex items-start gap-2">
              <span className="mt-px"><PlanStepIcon status={step.status} /></span>
              <span
                className={cn(
                  "min-w-0",
                  step.status === "pending" && "text-muted-foreground",
                  step.status === "skipped" && "text-muted-foreground line-through",
                  step.status === "blocked" && "text-destructive",
                )}
              >
                {step.title}
                {step.evidence ? (
                  <span className="block text-[11px] text-muted-foreground">{step.evidence}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function ToolActivity({ entries }: { entries: Array<Extract<AgentTimelineEntry, { kind: "tool" }>> }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-md border border-border/60 bg-muted/20 text-xs">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-muted-foreground"
      >
        <span>{t("agent.panel.activity", { count: entries.length })}</span>
        <ChevronDown className={cn("ml-auto h-3 w-3 transition-transform", expanded && "rotate-180")} />
      </button>
      {expanded ? <div className="space-y-1 border-t border-border/60 p-1.5">{entries.map((entry) => <ToolChip key={entry.id} entry={entry} />)}</div> : null}
    </div>
  );
}

function ToolChip({ entry }: { entry: Extract<AgentTimelineEntry, { kind: "tool" }> }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const pending = !entry.result;
  const failed = entry.result && !entry.result.ok;
  return (
    <div className="rounded-md border border-border/60 bg-muted/20 text-xs">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
      >
        {pending ? (
          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        ) : failed ? (
          <XCircle className="h-3 w-3 text-destructive" />
        ) : (
          <CheckCircle2 className="h-3 w-3 text-primary" />
        )}
        <span className="font-mono">{entry.name}</span>
        <ChevronDown className={cn("ml-auto h-3 w-3 transition-transform", expanded && "rotate-180")} />
      </button>
      {expanded ? (
        <div className="space-y-2 border-t border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
          <div>
            <div className="mb-1 text-foreground/70">{t("agent.panel.arguments")}</div>
            <pre className="overflow-auto whitespace-pre-wrap">{JSON.stringify(entry.args, null, 2)}</pre>
          </div>
          {entry.result ? (
            <div>
              <div className="mb-1 text-foreground/70">{t("agent.panel.result")}</div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap">{entry.result.summary}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * `question` kind：agent 停下来问一句，用户点候选或自由输入。
 * 复用 proposal 的阻塞通道（见 ADR-0027），所以这里只换外观与提交语义。
 */
function QuestionCard({
  entry,
  onRespond,
}: {
  entry: Extract<AgentTimelineEntry, { kind: "proposal" }>;
  onRespond: (runId: string, callId: string, approve: boolean, answer?: string) => Promise<void>;
}) {
  const t = useT();
  const [draft, setDraft] = useState("");
  const resolved = entry.resolution !== "pending";
  const answer = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    void onRespond(entry.runId, entry.callId, true, trimmed);
  };
  return (
    <div
      className={cn(
        "stela-agent-question rounded-lg border p-3 text-sm",
        resolved ? "border-border bg-muted/30" : "border-sky-400/50 bg-sky-400/10",
      )}
    >
      <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-sky-600">
        <HelpCircle className="h-3.5 w-3.5" />
        {t("agent.panel.proposal.question")}
      </div>
      <div className="mb-2 whitespace-pre-wrap text-foreground">
        {entry.payload.question ?? entry.payload.description}
      </div>
      {entry.payload.question && entry.payload.description !== entry.payload.question ? (
        <div className="mb-2 text-[11px] text-muted-foreground">{entry.payload.description}</div>
      ) : null}
      {resolved ? (
        <div className="text-xs text-muted-foreground">
          {entry.resolution === "expired"
            ? t("agent.panel.proposal.expired")
            : entry.answer
            ? t("agent.panel.proposal.answered", { answer: entry.answer })
            : t("agent.panel.proposal.rejected")}
        </div>
      ) : (
        <>
          {entry.payload.options && entry.payload.options.length > 0 ? (
            <div className="mb-2 flex flex-wrap gap-2">
              {entry.payload.options.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => answer(option)}
                  className="rounded-md border border-sky-400/50 bg-background px-2.5 py-1 text-xs hover:bg-accent"
                >
                  {option}
                </button>
              ))}
            </div>
          ) : null}
          <div className="flex gap-2">
            <input
              type="text"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  answer(draft);
                }
              }}
              placeholder={t("agent.panel.proposal.answerPlaceholder")}
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs"
            />
            <button
              type="button"
              onClick={() => answer(draft)}
              disabled={!draft.trim()}
              className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              {t("agent.panel.proposal.answerSend")}
            </button>
            <button
              type="button"
              onClick={() => void onRespond(entry.runId, entry.callId, false)}
              className="rounded-md border border-border px-3 py-1 text-xs hover:bg-accent"
            >
              {t("agent.panel.proposal.answerSkip")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ProposalCard({
  entry,
  onRespond,
}: {
  entry: Extract<AgentTimelineEntry, { kind: "proposal" }>;
  onRespond: (runId: string, callId: string, approve: boolean, answer?: string) => Promise<void>;
}) {
  const t = useT();
  const resolved = entry.resolution !== "pending";
  if (entry.proposalKind === "question") {
    return <QuestionCard entry={entry} onRespond={onRespond} />;
  }
  return (
    <div
      className={cn(
        "rounded-lg border p-3 text-sm",
        entry.resolution === "approved"
          ? "border-primary/40 bg-primary/5"
          : entry.resolution === "rejected"
            ? "border-border bg-muted/30"
            : "border-amber-400/50 bg-amber-400/10",
      )}
    >
      <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-amber-600">
        <ShieldAlert className="h-3.5 w-3.5" />
        {entry.proposalKind === "edit_note"
          ? t("agent.panel.proposal.edit")
          : t("agent.panel.proposal.sql")}
      </div>
      <div className="mb-2 text-foreground">{entry.payload.description}</div>
      {entry.payload.sql ? (
        <pre className="mb-2 overflow-auto rounded bg-muted p-2 font-mono text-[11px]">
          {entry.payload.sql}
        </pre>
      ) : null}
      {entry.payload.notePath ? (
        <div className="mb-2 text-[11px] text-muted-foreground">{entry.payload.notePath}</div>
      ) : null}
      {entry.payload.oldContent != null || entry.payload.newContent != null ? (
        <ProposalLineDiff
          oldContent={entry.payload.oldContent ?? ""}
          newContent={entry.payload.newContent ?? ""}
        />
      ) : null}
      {resolved ? (
        <div className="text-xs text-muted-foreground">
          {entry.resolution === "expired"
            ? t("agent.panel.proposal.expired")
            : entry.resolution === "approved"
            ? t("agent.panel.proposal.approved")
            : t("agent.panel.proposal.rejected")}
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void onRespond(entry.runId, entry.callId, true)}
            className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
          >
            {t("agent.panel.proposal.approve")}
          </button>
          <button
            type="button"
            onClick={() => void onRespond(entry.runId, entry.callId, false)}
            className="rounded-md border border-border px-3 py-1 text-xs hover:bg-accent"
          >
            {t("agent.panel.proposal.reject")}
          </button>
        </div>
      )}
    </div>
  );
}
