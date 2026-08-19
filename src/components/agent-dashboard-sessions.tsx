import {
  AlertTriangle,
  Check,
  Clipboard,
  MessageSquareText,
  RefreshCw,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { requestAgentMessage } from "@shared/agent-message";
import type {
  AgentHistoryRef,
  AgentHistorySummary,
  AgentMetricRange,
  AgentMetricSessionTrace,
  AgentMetricSessionTurn,
} from "@shared/types";

import {
  buildAgentSessionWaterfall,
  buildAgentTurnTrace,
  buildAgentTurnTraceItems,
  type AgentTraceItem,
  type AgentTraceItemKind,
} from "@/components/agent-dashboard-trace";
import { AgentUserMessage, AssistantMessage } from "@/components/ai/agent-panel";
import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";

interface AgentDashboardSessionsProps {
  range: AgentMetricRange;
  refreshToken: number;
}

type SessionView = "conversation" | "trace";
type DetailTab = "input" | "output" | "reasoning" | "raw";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function rangeStart(range: AgentMetricRange): number {
  const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
  return Date.now() - days * 24 * 60 * 60 * 1_000;
}

function formatDuration(value: number | null): string {
  if (value === null) return "—";
  if (value < 1_000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(1)} s`;
  return `${(value / 60_000).toFixed(1)} min`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatJson(value: unknown): string {
  if (value === null || value === undefined) return "—";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatCost(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function CopyDataButton({ value }: { value: unknown }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const text = typeof value === "string" ? value : formatJson(value);
  const onCopy = () => {
    window.stela.shell.writeClipboardText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };
  return (
    <button type="button" onClick={onCopy} title={copied ? t("common.copied") : t("common.copy")} className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground">
      {copied ? <Check className="h-3 w-3" /> : <Clipboard className="h-3 w-3" />}
      {copied ? t("common.copied") : t("common.copy")}
    </button>
  );
}

function DataDetails({ value }: { value: unknown }) {
  const isText = typeof value === "string";
  return (
    <div className="overflow-hidden rounded-md border border-border/60 bg-background/60">
      <div className="flex justify-end border-b border-border/60 px-2 py-1"><CopyDataButton value={value} /></div>
      <pre className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] p-3 font-mono text-[11px] leading-5 text-foreground"><code>{isText ? value : formatJson(value)}</code></pre>
    </div>
  );
}

function sessionKey(ref: AgentHistoryRef): string {
  return `${ref.deviceSlug}:${ref.sessionId}`;
}

function traceKindClass(kind: AgentTraceItemKind): string {
  switch (kind) {
    case "model": return "bg-violet-500/15 text-violet-700 dark:text-violet-300";
    case "tool": return "bg-amber-500/15 text-amber-700 dark:text-amber-300";
    case "approval": return "bg-blue-500/15 text-blue-700 dark:text-blue-300";
    case "review": return "bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300";
    case "compaction": return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
    case "maintenance": return "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300";
  }
}

function TraceKindLabel({ kind }: { kind: AgentTraceItemKind }) {
  const t = useT();
  const labels: Record<AgentTraceItemKind, string> = {
    model: t("agentDashboard.kind.model"),
    tool: t("agentDashboard.kind.tool"),
    approval: t("agentDashboard.kind.approval"),
    review: t("agentDashboard.kind.review"),
    compaction: t("agentDashboard.kind.compaction"),
    maintenance: t("agentDashboard.kind.maintenance"),
  };
  return <>{labels[kind]}</>;
}

function itemLabel(item: AgentTraceItem, modelStepLabel: (count: number) => string, compactionLabel: string): string {
  if (item.kind === "model") {
    const step = Number(item.label.match(/\d+$/)?.[0] ?? 0);
    return modelStepLabel(step);
  }
  if (item.kind === "compaction") return compactionLabel;
  return item.label;
}

function statusDotClass(item: AgentTraceItem): string {
  if (item.status === "error" || item.status === "timeout") return "bg-destructive";
  if (item.status === "running") return "bg-primary animate-pulse";
  if (item.status === "cancelled" || item.status === "dropped") return "bg-muted-foreground";
  return "bg-emerald-500";
}

function SessionSummaryMetric({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><div className="text-[9px] uppercase tracking-wide text-muted-foreground">{label}</div><div className="truncate text-[12px] font-semibold tabular-nums text-foreground">{value}</div></div>;
}

function SessionWaterfall({ session, onSelect }: { session: AgentMetricSessionTrace; onSelect: (item: AgentTraceItem) => void }) {
  const t = useT();
  const items = useMemo(() => session.turns.flatMap(buildAgentTurnTraceItems), [session]);
  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const segments = useMemo(() => buildAgentSessionWaterfall(session), [session]);
  const first = Math.min(...segments.map((segment) => segment.startedAt), session.history.summary.createdAt);
  const last = Math.max(...segments.map((segment) => segment.startedAt + segment.durationMs), session.history.summary.updatedAt, first + 1);
  const span = Math.max(1, last - first);
  const lanes = ["model", "tool", "control"] as const;
  const laneLabels = { model: t("agentDashboard.model"), tool: t("agentDashboard.tools"), control: t("agentDashboard.control") };
  return (
    <div className="border-b border-border bg-muted/10 px-4 py-3">
      <div className="mb-2 flex items-center justify-between text-[10px] text-muted-foreground"><span>{t("agentDashboard.timeline")}</span><span>{formatDuration(span)}</span></div>
      <div className="space-y-1">
        {lanes.map((lane) => (
          <div key={lane} className="grid grid-cols-[46px_1fr] items-center gap-2">
            <span className="text-[9px] text-muted-foreground">{laneLabels[lane]}</span>
            <div className="relative h-3 overflow-hidden rounded-sm bg-muted/50">
              {segments.filter((segment) => segment.kind === lane).map((segment) => {
                const left = ((segment.startedAt - first) / span) * 100;
                const width = Math.max(0.7, (segment.durationMs / span) * 100);
                const failed = segment.status === "error" || segment.status === "timeout";
                return <button key={segment.id} type="button" title={`${segment.label} · ${formatDuration(segment.durationMs)}`} onClick={() => { const item = itemById.get(segment.id); if (item) onSelect(item); }} className={cn("absolute top-0 h-3 rounded-[2px] opacity-85 hover:opacity-100", failed ? "bg-destructive" : lane === "model" ? "bg-violet-500" : lane === "tool" ? "bg-amber-500" : "bg-blue-500")} style={{ left: `${left}%`, width: `${Math.min(100 - left, width)}%` }} />;
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ConversationView({ session }: { session: AgentMetricSessionTrace }) {
  const t = useT();
  return <div className="space-y-5 p-5">{session.history.runs.map((run, index) => {
    const final = run.events.findLast((event) => event.type === "final");
    const error = run.events.findLast((event) => event.type === "error");
    const cancelled = run.events.some((event) => event.type === "cancelled");
    return <section key={run.request.runId} className="space-y-2.5">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t("agentDashboard.turn", { count: index + 1 })}</div>
      <div className="flex justify-end"><div className="max-w-[82%] rounded-lg bg-muted px-3 py-2 text-sm text-foreground"><AgentUserMessage message={requestAgentMessage(run.request)} /></div></div>
      {final?.type === "final" ? <div className="rounded-lg border border-border bg-card/40 p-3"><AssistantMessage content={final.content} /></div> : error?.type === "error" ? <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error.message}</div> : cancelled ? <div className="text-xs italic text-muted-foreground">{t("agentDashboard.cancelled")}</div> : <div className="flex items-center gap-2 text-xs text-muted-foreground"><RefreshCw className="h-3 w-3" />{run.finishedAt === null ? t("agentDashboard.running") : t("agentDashboard.traceUnavailable")}</div>}
    </section>;
  })}</div>;
}

function TurnInputDetails({ turn }: { turn: AgentMetricSessionTurn }) {
  const t = useT();
  const projection = buildAgentTurnTrace(turn);
  return (
    <details className="border-b border-border/60 bg-muted/5 px-4 py-2">
      <summary className="cursor-pointer text-[10px] font-medium text-muted-foreground">{t("agentDashboard.turnInput")}</summary>
      <div className="mt-2 grid gap-2 text-[10px]">
        <div><div className="mb-1 font-medium text-muted-foreground">{t("agentDashboard.userRequest")}</div><DataDetails value={projection.input.user} /></div>
        {projection.input.context ? <div><div className="mb-1 font-medium text-muted-foreground">{t("agentDashboard.context")}</div><DataDetails value={projection.input.context} /></div> : null}
        {projection.input.skills.length > 0 ? <div><div className="mb-1 font-medium text-muted-foreground">{t("agentDashboard.skills")}</div><DataDetails value={projection.input.skills} /></div> : null}
        {projection.input.systemPrompt ? <details><summary className="cursor-pointer font-medium text-muted-foreground">{t("agentDashboard.systemPrompt")}</summary><div className="mt-1"><DataDetails value={projection.input.systemPrompt} /></div></details> : null}
        {projection.latestPlan ? <details><summary className="cursor-pointer font-medium text-muted-foreground">{t("agentDashboard.latestPlan")}</summary><div className="mt-1"><DataDetails value={projection.latestPlan} /></div></details> : null}
        {projection.analysisEfficiency ? <details><summary className="cursor-pointer font-medium text-muted-foreground">{t("agentDashboard.diagnostics")}</summary><div className="mt-1"><DataDetails value={projection.analysisEfficiency} /></div></details> : null}
      </div>
    </details>
  );
}

function TraceItemButton({ item, selected, onSelect }: { item: AgentTraceItem; selected: boolean; onSelect: (item: AgentTraceItem) => void }) {
  const t = useT();
  const label = itemLabel(item, (count) => t("agentDashboard.modelStep", { count }), t("agentDashboard.contextCompaction"));
  return (
    <button type="button" onClick={() => onSelect(item)} className={cn("grid w-full grid-cols-[82px_1fr_82px] items-center gap-3 border-b border-border/60 px-4 py-2 text-left text-[11px] last:border-b-0 hover:bg-accent/50", selected && "bg-accent", (item.kind === "tool" || item.kind === "review") && "pl-8")}>
      <span className={cn("w-fit rounded px-1.5 py-0.5 text-[9px] font-semibold", traceKindClass(item.kind))}><TraceKindLabel kind={item.kind} /></span>
      <span className="min-w-0"><span className="block truncate font-medium text-foreground">{label}</span><span className="block truncate text-muted-foreground">{item.summary}</span></span>
      <span className="flex items-center justify-end gap-1.5 tabular-nums text-muted-foreground"><span className={cn("h-1.5 w-1.5 rounded-full", statusDotClass(item))} />{formatDuration(item.durationMs)}</span>
    </button>
  );
}

function TraceView({ session, selectedId, onSelect }: { session: AgentMetricSessionTrace; selectedId: string | null; onSelect: (item: AgentTraceItem) => void }) {
  const t = useT();
  return <div className="divide-y divide-border">{session.turns.map((turn) => {
    const projection = buildAgentTurnTrace(turn);
    return <section key={turn.history.request.runId}>
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background/95 px-4 py-2 backdrop-blur">
        <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">{t("agentDashboard.turn", { count: turn.index })}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{turn.history.request.prompt}</span>
        <span className="text-[10px] tabular-nums text-muted-foreground">{formatDuration(turn.trace?.root.run.durationMs ?? null)}</span>
      </div>
      <TurnInputDetails turn={turn} />
      {!turn.trace ? <div className="flex items-center gap-2 px-4 py-4 text-xs text-muted-foreground"><AlertTriangle className="h-3.5 w-3.5" />{t("agentDashboard.traceUnavailable")}</div> : null}
      {projection.errorMessage ? <div className="flex items-center gap-2 border-b border-destructive/20 bg-destructive/5 px-4 py-2 text-[10px] text-destructive"><AlertTriangle className="h-3.5 w-3.5" />{projection.errorMessage}</div> : null}
      <div>{projection.main.map((item) => <TraceItemButton key={item.id} item={item} selected={selectedId === item.id} onSelect={onSelect} />)}</div>
      {projection.maintenance.length > 0 ? <div className="border-t border-border bg-cyan-500/5"><div className="px-4 py-2 text-[9px] font-semibold uppercase tracking-wide text-cyan-700 dark:text-cyan-300">{t("agentDashboard.backgroundMaintenance")}</div>{projection.maintenance.map((item) => <TraceItemButton key={item.id} item={item} selected={selectedId === item.id} onSelect={onSelect} />)}</div> : null}
      {projection.diagnostics.length > 0 ? <details className="border-t border-border/60 px-4 py-2"><summary className="cursor-pointer text-[10px] text-muted-foreground">{t("agentDashboard.diagnostics")} · {projection.diagnostics.length}</summary><div className="mt-2"><DataDetails value={projection.diagnostics} /></div></details> : null}
    </section>;
  })}</div>;
}

function compactInputMessage(value: unknown): unknown {
  const message = record(value);
  if (!message || !Array.isArray(message.content)) return value;
  return {
    ...message,
    content: message.content.map((block) => {
      const item = record(block);
      if (!item) return block;
      if (item.type === "thinking" && typeof item.thinking === "string") {
        return { type: "thinking", hidden: true, characterCount: item.thinking.length };
      }
      if (item.type === "toolCall") {
        return { type: "toolCall", name: typeof item.name === "string" ? item.name : null };
      }
      return block;
    }),
  };
}

function inputMessageSummary(value: unknown): string {
  const message = record(value);
  if (!message) return "message";
  if (typeof message.content === "string") return message.content.replace(/\s+/g, " ").slice(0, 120);
  if (!Array.isArray(message.content)) return "message";
  const summaries = message.content.flatMap((block) => {
    const item = record(block);
    if (!item) return [];
    if (item.type === "text" && typeof item.text === "string") return [item.text.replace(/\s+/g, " ").slice(0, 120)];
    if (item.type === "toolCall") return [typeof item.name === "string" ? `tool · ${item.name}` : "tool call"];
    if (item.type === "toolResult") return [typeof item.toolName === "string" ? `result · ${item.toolName}` : "tool result"];
    if (item.type === "image") return ["image"];
    return [];
  });
  return summaries.join(" · ").slice(0, 160) || "context message";
}

function ModelInput({ value }: { value: unknown }) {
  const t = useT();
  if (!Array.isArray(value)) return value === null ? <div className="text-[11px] text-muted-foreground">{t("agentDashboard.noModelInput")}</div> : <DataDetails value={value} />;
  return <div className="space-y-2">
    <div className="text-[10px] text-muted-foreground">{t("agentDashboard.modelMessages", { count: value.length })}</div>
    {value.map((message, index) => {
    const role = record(message)?.role;
    return <details key={index} className="rounded-md border border-border/60 bg-background/60">
      <summary className="flex cursor-pointer items-center gap-3 px-3 py-2 text-[10px]">
        <span className="shrink-0 font-semibold uppercase tracking-wide text-muted-foreground">{typeof role === "string" ? role : "message"}</span>
        <span className="min-w-0 flex-1 truncate text-foreground">{inputMessageSummary(message)}</span>
      </summary>
      <div className="border-t border-border/60 p-3"><DataDetails value={compactInputMessage(message)} /></div>
    </details>;
  })}
  </div>;
}

function HeaderMetric({ label, value, title }: { label: string; value: string; title?: string }) {
  return <div className="min-w-[54px] text-right" title={title}><div className="text-[8px] uppercase tracking-wide text-muted-foreground">{label}</div><div className="mt-0.5 whitespace-nowrap text-[10px] font-semibold tabular-nums text-foreground">{value}</div></div>;
}

function TraceHeaderMetrics({ item }: { item: AgentTraceItem }) {
  const t = useT();
  const usage = item.usage;
  const contextUsedTokens = item.contextUsedTokens ?? usage?.promptTokens ?? null;
  const rawContextPercent = contextUsedTokens !== null && item.contextWindow && item.contextWindow > 0
    ? (contextUsedTokens / item.contextWindow) * 100
    : null;
  const contextPercent = rawContextPercent === null
    ? null
    : rawContextPercent < 10 ? rawContextPercent.toFixed(1) : Math.round(rawContextPercent).toString();
  const effectiveThinking = item.thinkingLevel === "off"
    ? t("agentDashboard.thinkingOff")
    : item.thinkingLevel ?? "—";
  const thinking = item.requestedThinkingLevel &&
    item.thinkingLevel &&
    item.requestedThinkingLevel !== item.thinkingLevel
    ? `${item.requestedThinkingLevel} → ${effectiveThinking}`
    : effectiveThinking;
  return <div className="flex max-w-[68%] flex-wrap items-start justify-end gap-x-4 gap-y-2">
    <HeaderMetric label={t("agentDashboard.started")} value={new Date(item.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })} title={new Date(item.startedAt).toLocaleString()} />
    <HeaderMetric label={t("agentDashboard.duration")} value={formatDuration(item.durationMs)} />
    {item.kind === "model" ? <HeaderMetric label={t("agentDashboard.firstToken")} value={formatDuration(item.firstTokenMs)} /> : null}
    {item.kind === "model" ? <HeaderMetric label={t("agentDashboard.thinkingMode")} value={thinking} /> : null}
    {usage ? <>
      <HeaderMetric label={t("agentDashboard.contextUsed")} value={`${formatNumber(contextUsedTokens ?? usage.promptTokens)}${item.contextWindow ? ` / ${formatNumber(item.contextWindow)}` : ""}${contextPercent === null ? "" : ` · ${contextPercent}%`}`} title={t("agentDashboard.contextUsedHelp")} />
      <HeaderMetric label={t("agentDashboard.tokensIn")} value={formatNumber(usage.inputTokens)} />
      <HeaderMetric label={t("agentDashboard.tokensOut")} value={formatNumber(usage.outputTokens)} title={t("agentDashboard.reasoningTokensHelp")} />
      <HeaderMetric label={t("agentDashboard.tokensCached")} value={formatNumber(usage.cacheReadTokens)} />
      {usage.cacheWriteTokens > 0 ? <HeaderMetric label={t("agentDashboard.tokensCacheWrite")} value={formatNumber(usage.cacheWriteTokens)} /> : null}
      {(usage.reasoningTokens ?? 0) > 0 ? <HeaderMetric label={t("agentDashboard.reasoningTokens")} value={formatNumber(usage.reasoningTokens!)} title={t("agentDashboard.reasoningTokensHelp")} /> : null}
      {(usage.cost?.total ?? 0) > 0 ? <HeaderMetric label={t("agentDashboard.cost")} value={formatCost(usage.cost!.total)} /> : null}
    </> : null}
  </div>;
}

function ModelOutput({ item }: { item: AgentTraceItem }) {
  const t = useT();
  return <div className="space-y-2">
    {item.modelOutputText ? <div className="rounded-md border border-border/60 bg-background p-3"><AssistantMessage content={item.modelOutputText} /></div> : null}
    {(item.requestedTools?.length ?? 0) > 0 ? <div className="rounded-md border border-amber-500/20 bg-amber-500/5 p-3">
      <div className="mb-2 text-[10px] font-semibold text-amber-700 dark:text-amber-300">{t("agentDashboard.requestedTools")}</div>
      <div className="flex flex-wrap gap-1.5">{item.requestedTools!.map((name, index) => <span key={`${name}:${index}`} className="rounded bg-amber-500/10 px-2 py-1 font-mono text-[10px] text-amber-800 dark:text-amber-200">{name}</span>)}</div>
    </div> : null}
    {!item.modelOutputText && (item.requestedTools?.length ?? 0) === 0 ? <div className="text-[11px] text-muted-foreground">{t("agentDashboard.noVisibleModelOutput")}</div> : null}
  </div>;
}

function ModelReasoning({ item }: { item: AgentTraceItem }) {
  const t = useT();
  if ((item.modelThinking?.length ?? 0) > 0) {
    return <div className="space-y-2">{item.modelThinking!.map((thinking, index) => <DataDetails key={index} value={thinking} />)}</div>;
  }
  const message = item.thinkingLevel === "off"
    ? t("agentDashboard.thinkingDisabledNotice")
    : t("agentDashboard.reasoningUnavailableNotice");
  return <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-[10px] text-muted-foreground">{message}</div>;
}

function TraceDetails({ item }: { item: AgentTraceItem }) {
  const t = useT();
  const defaultTab: DetailTab = item.kind === "model" ? "output" : "input";
  const [tab, setTab] = useState<DetailTab>(defaultTab);
  useEffect(() => setTab(item.kind === "model" ? "output" : "input"), [item.id, item.kind]);
  const showReasoning = item.kind === "model" && (
    item.thinkingLevel !== "off" ||
    (item.modelThinking?.length ?? 0) > 0 ||
    (item.usage?.reasoningTokens ?? 0) > 0
  );
  const tabs: Array<{ id: DetailTab; label: string }> = item.kind === "model"
    ? [
      { id: "output", label: t("agentDashboard.output") },
      ...(showReasoning ? [{ id: "reasoning" as const, label: t("agentDashboard.reasoning") }] : []),
      { id: "input", label: t("agentDashboard.input") },
      { id: "raw", label: t("agentDashboard.rawData") },
    ]
    : [
      { id: "input", label: t("agentDashboard.input") },
      { id: "output", label: t("agentDashboard.output") },
      { id: "raw", label: t("agentDashboard.rawData") },
    ];
  const label = itemLabel(item, (count) => t("agentDashboard.modelStep", { count }), t("agentDashboard.contextCompaction"));
  return (
    <aside className="flex min-w-0 flex-1 flex-col border-l border-border bg-muted/10">
      <div className="flex items-start gap-6 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2"><span className={cn("rounded px-1.5 py-0.5 text-[9px] font-semibold", traceKindClass(item.kind))}><TraceKindLabel kind={item.kind} /></span><span className="min-w-0 flex-1 truncate text-xs font-semibold">{label}</span></div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground"><span>{t("agentDashboard.turn", { count: item.turnIndex })}</span><span className="inline-flex items-center gap-1.5"><span className={cn("h-1.5 w-1.5 rounded-full", statusDotClass(item))} />{item.status}</span></div>
          {item.effects.length > 0 ? <div className="mt-2 flex flex-wrap gap-1">{item.effects.map((effect, index) => <span key={`${effect.type}:${index}`} className="rounded bg-primary/10 px-1.5 py-0.5 text-[9px] text-primary">{effect.type === "plan_updated" ? t("agentDashboard.effect.planUpdated") : t("agentDashboard.effect.canvasUpdated")}</span>)}</div> : null}
        </div>
        <TraceHeaderMetrics item={item} />
      </div>
      <div className="flex border-b border-border px-2">{tabs.map((candidate) => <button key={candidate.id} type="button" onClick={() => setTab(candidate.id)} className={cn("border-b-2 px-2 py-2 text-[10px]", tab === candidate.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground")}>{candidate.label}</button>)}</div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {tab === "input" ? item.kind === "model" ? <ModelInput value={item.payload} /> : <DataDetails value={item.payload} />
          : tab === "output" ? item.kind === "model" ? <ModelOutput item={item} /> : <DataDetails value={item.result} />
            : tab === "reasoning" ? <ModelReasoning item={item} />
              : <DataDetails value={{ rawType: item.rawType, data: item.raw, effects: item.effects }} />}
      </div>
    </aside>
  );
}

export function AgentDashboardSessions({ range, refreshToken }: AgentDashboardSessionsProps) {
  const t = useT();
  const [sessions, setSessions] = useState<AgentHistorySummary[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [session, setSession] = useState<AgentMetricSessionTrace | null>(null);
  const [view, setView] = useState<SessionView>("trace");
  const [selectedItem, setSelectedItem] = useState<AgentTraceItem | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void window.stela.agent.listHistory().then((history) => {
      if (!active) return;
      const filtered = history.filter((item) => item.isLocal && item.updatedAt >= rangeStart(range));
      setSessions(filtered);
      setSelectedKey((current) => current && filtered.some((item) => sessionKey(item) === current) ? current : filtered[0] ? sessionKey(filtered[0]) : null);
    }).catch((err: unknown) => { if (active) setError(err instanceof Error ? err.message : String(err)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [range, refreshToken]);

  const selectedSummary = sessions.find((item) => sessionKey(item) === selectedKey) ?? null;
  useEffect(() => {
    let active = true;
    setSession(null);
    setSelectedItem(null);
    if (!selectedSummary) return () => { active = false; };
    setLoading(true);
    setError(null);
    const loadSessionTrace = async () => {
      try {
        const result = await window.stela.agentMetrics.getSessionTrace({ sessionId: selectedSummary.sessionId, deviceSlug: selectedSummary.deviceSlug });
        if (!active) return;
        setSession(result);
        const latestTurn = result.turns.at(-1);
        const latestItems = latestTurn ? buildAgentTurnTraceItems(latestTurn) : [];
        setSelectedItem(latestItems.find((item) => item.kind === "model") ?? latestItems[0] ?? null);
      } catch (err: unknown) {
        if (active) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (active) setLoading(false);
      }
    };
    void loadSessionTrace();
    return () => { active = false; };
  }, [selectedKey, refreshToken]);

  const totalTokens = session ? session.totals.promptTokens + session.totals.outputTokens : 0;
  return (
    <div className="flex min-h-0 flex-1">
      <aside className="w-[220px] flex-none overflow-auto border-r border-border bg-muted/10 p-2">
        <div className="px-2 pb-2 pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t("agentDashboard.localSessions")}</div>
        {sessions.map((item) => <button key={sessionKey(item)} type="button" onClick={() => setSelectedKey(sessionKey(item))} className={cn("mb-1 w-full rounded-md px-2.5 py-2 text-left hover:bg-accent", selectedKey === sessionKey(item) && "bg-accent")}><span className="block truncate text-[11px] font-medium text-foreground">{item.title}</span><span className="mt-0.5 block truncate text-[9px] text-muted-foreground">{new Date(item.updatedAt).toLocaleString()}</span></button>)}
        {!loading && sessions.length === 0 ? <div className="px-2 py-6 text-center text-[11px] text-muted-foreground">{t("agentDashboard.noSessions")}</div> : null}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {error ? <div className="m-4 flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive"><AlertTriangle className="h-4 w-4" />{error}</div> : null}
        {loading && !session ? <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground"><RefreshCw className="mr-2 h-3.5 w-3.5 animate-spin" />{t("agentDashboard.loadingSession")}</div> : null}
        {session ? <>
          <header className="border-b border-border px-4 py-3">
            <div className="flex items-start gap-3"><div className="min-w-0 flex-1"><h3 className="truncate text-sm font-semibold">{session.history.summary.title}</h3><div className="mt-1 truncate font-mono text-[9px] text-muted-foreground">{session.history.summary.sessionId}</div></div><div className="grid grid-cols-6 gap-5"><SessionSummaryMetric label={t("agentDashboard.turns")} value={formatNumber(session.totals.turnCount)} /><SessionSummaryMetric label={t("agentDashboard.modelSteps")} value={formatNumber(session.totals.modelStepCount)} /><SessionSummaryMetric label={t("agentDashboard.calls")} value={formatNumber(session.totals.toolCallCount)} /><SessionSummaryMetric label={t("agentDashboard.tokens")} value={formatNumber(totalTokens)} /><SessionSummaryMetric label={t("agentDashboard.duration")} value={formatDuration(session.totals.durationMs)} /><SessionSummaryMetric label={t("agentDashboard.cacheHitRate")} value={session.totals.cacheHitRate === null ? "—" : `${Math.round(session.totals.cacheHitRate * 100)}%`} /></div></div>
            <div className="mt-3 flex gap-1">{(["conversation", "trace"] as const).map((candidate) => <button key={candidate} type="button" onClick={() => setView(candidate)} className={cn("rounded px-2.5 py-1 text-[10px]", view === candidate ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-accent")}>{candidate === "conversation" ? t("agentDashboard.conversation") : t("agentDashboard.trajectory")}</button>)}</div>
          </header>
          {view === "trace" ? <SessionWaterfall session={session} onSelect={setSelectedItem} /> : null}
          <div className="min-h-0 flex-1 overflow-hidden">{view === "conversation" ? <div className="h-full overflow-auto"><ConversationView session={session} /></div> : <div className="flex h-full min-h-0"><div className="w-[42%] min-w-[360px] max-w-[520px] flex-none overflow-auto"><TraceView session={session} selectedId={selectedItem?.id ?? null} onSelect={setSelectedItem} /></div>{selectedItem ? <TraceDetails item={selectedItem} /> : null}</div>}</div>
        </> : !loading && !error ? <div className="flex flex-1 flex-col items-center justify-center gap-2 text-xs text-muted-foreground"><MessageSquareText className="h-5 w-5" />{t("agentDashboard.selectSession")}</div> : null}
      </div>
    </div>
  );
}
