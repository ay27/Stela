import {
  AlertTriangle,
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
} from "@shared/types";

import {
  buildAgentSessionWaterfall,
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
type DetailTab = "summary" | "payload" | "result" | "timing";

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

function sessionKey(ref: AgentHistoryRef): string {
  return `${ref.deviceSlug}:${ref.sessionId}`;
}

function traceKindClass(kind: AgentTraceItemKind): string {
  switch (kind) {
    case "system": return "bg-slate-500/15 text-slate-700 dark:text-slate-300";
    case "user": return "bg-blue-500/15 text-blue-700 dark:text-blue-300";
    case "context": return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
    case "model": return "bg-violet-500/15 text-violet-700 dark:text-violet-300";
    case "tool": return "bg-amber-500/15 text-amber-700 dark:text-amber-300";
    case "review": return "bg-violet-500/15 text-violet-700 dark:text-violet-300";
    case "maintenance": return "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300";
    default: return "bg-muted text-muted-foreground";
  }
}

function statusDotClass(item: AgentTraceItem): string {
  if (item.status === "error" || item.status === "timeout") return "bg-destructive";
  if (item.status === "running") return "bg-primary animate-pulse";
  if (item.status === "cancelled" || item.status === "dropped") return "bg-muted-foreground";
  return "bg-emerald-500";
}

function SessionSummaryMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[9px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="truncate text-[12px] font-semibold tabular-nums text-foreground">{value}</div>
    </div>
  );
}

function SessionWaterfall({
  session,
  onSelect,
}: {
  session: AgentMetricSessionTrace;
  onSelect: (item: AgentTraceItem) => void;
}) {
  const t = useT();
  const items = useMemo(() => session.turns.flatMap(buildAgentTurnTraceItems), [session]);
  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const segments = useMemo(() => buildAgentSessionWaterfall(session), [session]);
  const first = Math.min(...segments.map((segment) => segment.startedAt), session.history.summary.createdAt);
  const last = Math.max(
    ...segments.map((segment) => segment.startedAt + segment.durationMs),
    session.history.summary.updatedAt,
    first + 1,
  );
  const span = Math.max(1, last - first);
  const lanes = ["input", "model", "tool"] as const;
  const laneLabels = {
    input: t("agentDashboard.input"),
    model: t("agentDashboard.model"),
    tool: t("agentDashboard.tools"),
  };
  return (
    <div className="border-b border-border bg-muted/10 px-4 py-3">
      <div className="mb-2 flex items-center justify-between text-[10px] text-muted-foreground">
        <span>{t("agentDashboard.timeline")}</span>
        <span>{formatDuration(span)}</span>
      </div>
      <div className="space-y-1">
        {lanes.map((lane) => (
          <div key={lane} className="grid grid-cols-[46px_1fr] items-center gap-2">
            <span className="text-[9px] text-muted-foreground">{laneLabels[lane]}</span>
            <div className="relative h-3 overflow-hidden rounded-sm bg-muted/50">
              {segments.filter((segment) => segment.kind === lane).map((segment) => {
                const left = ((segment.startedAt - first) / span) * 100;
                const width = Math.max(0.7, (segment.durationMs / span) * 100);
                const failed = segment.status === "error" || segment.status === "timeout";
                return (
                  <button
                    key={segment.id}
                    type="button"
                    title={`${segment.label} · ${formatDuration(segment.durationMs)}`}
                    onClick={() => {
                      const item = itemById.get(segment.id);
                      if (item) onSelect(item);
                    }}
                    className={cn(
                      "absolute top-0 h-3 rounded-[2px] opacity-85 hover:opacity-100",
                      failed ? "bg-destructive" : lane === "model" ? "bg-violet-500" : lane === "tool" ? "bg-amber-500" : "bg-emerald-500",
                    )}
                    style={{ left: `${left}%`, width: `${Math.min(100 - left, width)}%` }}
                  />
                );
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
  return (
    <div className="space-y-5 p-5">
      {session.history.runs.map((run, index) => {
        const final = run.events.findLast((event) => event.type === "final");
        const error = run.events.findLast((event) => event.type === "error");
        const cancelled = run.events.some((event) => event.type === "cancelled");
        return (
          <section key={run.request.runId} className="space-y-2.5">
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {t("agentDashboard.turn", { count: index + 1 })}
            </div>
            <div className="flex justify-end">
              <div className="max-w-[82%] rounded-lg bg-muted px-3 py-2 text-sm text-foreground">
                <AgentUserMessage message={requestAgentMessage(run.request)} />
              </div>
            </div>
            {final?.type === "final" ? (
              <div className="rounded-lg border border-border bg-card/40 p-3">
                <AssistantMessage content={final.content} />
              </div>
            ) : error?.type === "error" ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                {error.message}
              </div>
            ) : cancelled ? (
              <div className="text-xs italic text-muted-foreground">{t("agentDashboard.cancelled")}</div>
            ) : (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <RefreshCw className="h-3 w-3" />
                {run.finishedAt === null ? t("agentDashboard.running") : t("agentDashboard.traceUnavailable")}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function TraceView({
  session,
  selectedId,
  onSelect,
}: {
  session: AgentMetricSessionTrace;
  selectedId: string | null;
  onSelect: (item: AgentTraceItem) => void;
}) {
  const t = useT();
  return (
    <div className="divide-y divide-border">
      {session.turns.map((turn) => {
        const items = buildAgentTurnTraceItems(turn);
        return (
          <section key={turn.history.request.runId}>
            <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background/95 px-4 py-2 backdrop-blur">
              <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                {t("agentDashboard.turn", { count: turn.index })}
              </span>
              <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                {turn.history.request.prompt}
              </span>
              <span className="text-[10px] tabular-nums text-muted-foreground">
                {formatDuration(turn.trace?.root.run.durationMs ?? null)}
              </span>
            </div>
            {!turn.trace ? (
              <div className="flex items-center gap-2 px-4 py-4 text-xs text-muted-foreground">
                <AlertTriangle className="h-3.5 w-3.5" />
                {t("agentDashboard.traceUnavailable")}
              </div>
            ) : null}
            <div>
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onSelect(item)}
                  className={cn(
                    "grid w-full grid-cols-[76px_1fr_82px] items-center gap-3 border-b border-border/60 px-4 py-2 text-left text-[11px] last:border-b-0 hover:bg-accent/50",
                    selectedId === item.id && "bg-accent",
                    (item.kind === "tool" || item.kind === "review" || item.kind === "maintenance") && "pl-8",
                  )}
                >
                  <span className={cn("w-fit rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase", traceKindClass(item.kind))}>
                    {item.kind}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-foreground">{item.label}</span>
                    <span className="block truncate text-muted-foreground">{item.summary}</span>
                  </span>
                  <span className="flex items-center justify-end gap-1.5 tabular-nums text-muted-foreground">
                    <span className={cn("h-1.5 w-1.5 rounded-full", statusDotClass(item))} />
                    {formatDuration(item.durationMs)}
                  </span>
                </button>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function TraceDetails({ item }: { item: AgentTraceItem }) {
  const t = useT();
  const [tab, setTab] = useState<DetailTab>("summary");
  useEffect(() => setTab("summary"), [item.id]);
  const tabs: Array<{ id: DetailTab; label: string }> = [
    { id: "summary", label: t("agentDashboard.summary") },
    { id: "payload", label: t("agentDashboard.payload") },
    { id: "result", label: t("agentDashboard.result") },
    { id: "timing", label: t("agentDashboard.timing") },
  ];
  return (
    <aside className="flex w-[340px] flex-none flex-col border-l border-border bg-muted/10">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <span className={cn("rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase", traceKindClass(item.kind))}>{item.kind}</span>
          <span className="min-w-0 flex-1 truncate text-xs font-semibold">{item.label}</span>
        </div>
        <div className="mt-1 text-[10px] text-muted-foreground">{t("agentDashboard.turn", { count: item.turnIndex })}</div>
      </div>
      <div className="flex border-b border-border px-2">
        {tabs.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            onClick={() => setTab(candidate.id)}
            className={cn(
              "border-b-2 px-2 py-2 text-[10px]",
              tab === candidate.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground",
            )}
          >
            {candidate.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {tab === "summary" ? (
          <div className="space-y-4 text-[11px]">
            <div>
              <div className="mb-1 text-[9px] uppercase tracking-wide text-muted-foreground">{t("agentDashboard.status")}</div>
              <div className="flex items-center gap-2"><span className={cn("h-2 w-2 rounded-full", statusDotClass(item))} />{item.status}</div>
            </div>
            <div>
              <div className="mb-1 text-[9px] uppercase tracking-wide text-muted-foreground">{t("agentDashboard.summary")}</div>
              <p className="whitespace-pre-wrap break-words leading-5">{item.summary || "—"}</p>
            </div>
          </div>
        ) : tab === "timing" ? (
          <div className="space-y-3 text-[11px]">
            <div><span className="text-muted-foreground">{t("agentDashboard.started")}</span><div className="mt-0.5 font-mono">{new Date(item.startedAt).toLocaleString()}</div></div>
            <div><span className="text-muted-foreground">{t("agentDashboard.duration")}</span><div className="mt-0.5 font-mono">{formatDuration(item.durationMs)}</div></div>
            <div><span className="text-muted-foreground">{t("agentDashboard.firstToken")}</span><div className="mt-0.5 font-mono">{formatDuration(item.firstTokenMs)}</div></div>
          </div>
        ) : (
          <pre className="whitespace-pre-wrap break-all text-[10px] leading-5 text-foreground">
            {formatJson(tab === "payload" ? item.payload : item.result)}
          </pre>
        )}
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
    void window.stela.agent.listHistory()
      .then((history) => {
        if (!active) return;
        const filtered = history.filter((item) => item.isLocal && item.updatedAt >= rangeStart(range));
        setSessions(filtered);
        setSelectedKey((current) => current && filtered.some((item) => sessionKey(item) === current)
          ? current
          : filtered[0] ? sessionKey(filtered[0]) : null);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
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
        const result = await window.stela.agentMetrics.getSessionTrace({
          sessionId: selectedSummary.sessionId,
          deviceSlug: selectedSummary.deviceSlug,
        });
        if (!active) return;
        setSession(result);
        const latestTurn = result.turns.at(-1);
        setSelectedItem(latestTurn ? buildAgentTurnTraceItems(latestTurn).find((item) => item.kind === "model") ?? null : null);
      } catch (err: unknown) {
        if (active) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (active) setLoading(false);
      }
    };
    void loadSessionTrace();
    return () => { active = false; };
  }, [selectedKey, refreshToken]);

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="w-[240px] flex-none overflow-auto border-r border-border bg-muted/10 p-2">
        <div className="px-2 pb-2 pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t("agentDashboard.localSessions")}
        </div>
        {sessions.map((item) => (
          <button
            key={sessionKey(item)}
            type="button"
            onClick={() => setSelectedKey(sessionKey(item))}
            className={cn(
              "mb-1 w-full rounded-md px-2.5 py-2 text-left hover:bg-accent",
              selectedKey === sessionKey(item) && "bg-accent",
            )}
          >
            <span className="block truncate text-[11px] font-medium text-foreground">{item.title}</span>
            <span className="mt-0.5 block truncate text-[9px] text-muted-foreground">{new Date(item.updatedAt).toLocaleString()}</span>
          </button>
        ))}
        {!loading && sessions.length === 0 ? <div className="px-2 py-6 text-center text-[11px] text-muted-foreground">{t("agentDashboard.noSessions")}</div> : null}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {error ? <div className="m-4 flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive"><AlertTriangle className="h-4 w-4" />{error}</div> : null}
        {loading && !session ? <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground"><RefreshCw className="mr-2 h-3.5 w-3.5 animate-spin" />{t("agentDashboard.loadingSession")}</div> : null}
        {session ? (
          <>
            <header className="border-b border-border px-4 py-3">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-sm font-semibold">{session.history.summary.title}</h3>
                  <div className="mt-1 truncate font-mono text-[9px] text-muted-foreground">{session.history.summary.sessionId}</div>
                </div>
                <div className="grid grid-cols-5 gap-5">
                  <SessionSummaryMetric label={t("agentDashboard.turns")} value={formatNumber(session.totals.turnCount)} />
                  <SessionSummaryMetric label={t("agentDashboard.modelSteps")} value={formatNumber(session.totals.modelStepCount)} />
                  <SessionSummaryMetric label={t("agentDashboard.calls")} value={formatNumber(session.totals.toolCallCount)} />
                  <SessionSummaryMetric label={t("agentDashboard.duration")} value={formatDuration(session.totals.durationMs)} />
                  <SessionSummaryMetric label={t("agentDashboard.cacheHitRate")} value={session.totals.cacheHitRate === null ? "—" : `${Math.round(session.totals.cacheHitRate * 100)}%`} />
                </div>
              </div>
              <div className="mt-3 flex gap-1">
                {(["conversation", "trace"] as const).map((candidate) => (
                  <button
                    key={candidate}
                    type="button"
                    onClick={() => setView(candidate)}
                    className={cn("rounded px-2.5 py-1 text-[10px]", view === candidate ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-accent")}
                  >
                    {candidate === "conversation" ? t("agentDashboard.conversation") : t("agentDashboard.trajectory")}
                  </button>
                ))}
              </div>
            </header>
            {view === "trace" ? <SessionWaterfall session={session} onSelect={setSelectedItem} /> : null}
            <div className="min-h-0 flex-1 overflow-auto">
              {view === "conversation"
                ? <ConversationView session={session} />
                : <TraceView session={session} selectedId={selectedItem?.id ?? null} onSelect={setSelectedItem} />}
            </div>
          </>
        ) : !loading && !error ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
            <MessageSquareText className="h-5 w-5" />
            {t("agentDashboard.selectSession")}
          </div>
        ) : null}
      </div>
      {view === "trace" && selectedItem ? <TraceDetails item={selectedItem} /> : null}
    </div>
  );
}
