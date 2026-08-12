import * as Dialog from "@radix-ui/react-dialog";
import { Activity, AlertTriangle, ChevronLeft, ChevronRight, Clock3, Database, RefreshCw, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type {
  AgentMetricBreakdown,
  AgentMetricRange,
  AgentMetricRunSummary,
  AgentMetricRunPage,
  AgentMetricTrace,
  AgentMetricsDashboard,
} from "@shared/types";

import { agentActivityLevel, buildAgentActivityGrid } from "@/components/agent-dashboard-activity";
import { i18n } from "@/i18n";
import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";

interface AgentDashboardDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const TRACE_PAGE_SIZE = 10;

function formatDuration(value: number | null): string {
  if (value === null) return "—";
  if (value < 1_000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(1)} s`;
  return `${(value / 60_000).toFixed(1)} min`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function rate(numerator: number, denominator: number): string {
  return denominator > 0 ? `${Math.round((numerator / denominator) * 100)}%` : "—";
}

function formatRate(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

function runCacheHitRate(run: AgentMetricRunSummary): number | null {
  const promptTokens = run.inputTokens + run.cacheReadTokens + run.cacheWriteTokens;
  return promptTokens > 0 ? run.cacheReadTokens / promptTokens : null;
}

function knowledgeOutcomeLabel(key: string, t: ReturnType<typeof useT>): string {
  const labels: Record<string, string> = {
    saved: t("agentDashboard.outcome.saved"),
    no_change: t("agentDashboard.outcome.noChange"),
    no_source: t("agentDashboard.outcome.noSource"),
    input_too_large: t("agentDashboard.outcome.inputTooLarge"),
    disabled: t("agentDashboard.outcome.disabled"),
    dropped: t("agentDashboard.outcome.dropped"),
    timeout: t("agentDashboard.outcome.timeout"),
    error: t("agentDashboard.outcome.error"),
  };
  return labels[key] ?? key;
}

function MetricCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card/60 p-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums text-foreground">{value}</div>
      {hint ? <div className="mt-0.5 text-[10px] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

function StatusPill({ run }: { run: AgentMetricRunSummary }) {
  return (
    <span className={cn(
      "rounded px-1.5 py-0.5 text-[10px] font-medium",
      run.status === "completed" && "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
      run.status === "error" && "bg-destructive/15 text-destructive",
      (run.status === "cancelled" || run.status === "dropped") && "bg-muted text-muted-foreground",
      run.status === "timeout" && "bg-amber-500/15 text-amber-700 dark:text-amber-400",
      run.status === "running" && "bg-primary/15 text-primary",
    )}>
      {run.outcome ?? run.status}
    </span>
  );
}

function BreakdownTable({ rows }: { rows: AgentMetricBreakdown[] }) {
  const t = useT();
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <table className="w-full text-left text-[11px]">
        <thead className="bg-muted/50 text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">{t("agentDashboard.type")}</th>
            <th className="px-3 py-2 text-right font-medium">{t("agentDashboard.requests")}</th>
            <th className="px-3 py-2 text-right font-medium">{t("agentDashboard.completionRate")}</th>
            <th className="px-3 py-2 text-right font-medium">{t("agentDashboard.errors")}</th>
            <th className="px-3 py-2 text-right font-medium">P50</th>
            <th className="px-3 py-2 text-right font-medium">P95</th>
            <th className="px-3 py-2 text-right font-medium">{t("agentDashboard.cacheHitRate")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-t border-border">
              <td className="px-3 py-2 font-mono text-foreground">{row.key}</td>
              <td className="px-3 py-2 text-right tabular-nums">{row.total}</td>
              <td className="px-3 py-2 text-right tabular-nums">{rate(row.completed, row.completed + row.errors)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{row.errors}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatDuration(row.p50DurationMs)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatDuration(row.p95DurationMs)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatRate(row.cacheHitRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function activityCellClass(level: ReturnType<typeof agentActivityLevel>): string {
  if (level === 4) return "bg-primary";
  if (level === 3) return "bg-primary/75";
  if (level === 2) return "bg-primary/50";
  if (level === 1) return "bg-primary/25";
  return "bg-muted/60";
}

function DailyActivityGrid({ data, range }: { data: AgentMetricsDashboard; range: AgentMetricRange }) {
  const t = useT();
  const grid = useMemo(
    () => buildAgentActivityGrid(range, data.generatedAt, data.daily),
    [data.daily, data.generatedAt, range],
  );
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const dayFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }),
    [locale],
  );
  const weekdayFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { weekday: "narrow" }),
    [locale],
  );
  const weekdays = useMemo(
    () => Array.from({ length: 7 }, (_, index) => weekdayFormatter.format(new Date(2026, 7, 2 + index))),
    [weekdayFormatter],
  );
  const formatDay = (day: string) => dayFormatter.format(new Date(`${day}T00:00:00`));

  return (
    <div>
      <div className="flex items-start gap-2">
        <div className="grid grid-rows-7 gap-1 text-[8px] leading-3 text-muted-foreground" aria-hidden="true">
          {weekdays.map((weekday, index) => <span key={`${weekday}-${index}`} className="h-3 w-3 text-center">{index % 2 === 1 ? weekday : ""}</span>)}
        </div>
        <div
          className="grid gap-1"
          style={{
            gridAutoFlow: "column",
            gridTemplateColumns: `repeat(${grid.weekCount}, 0.75rem)`,
            gridTemplateRows: "repeat(7, 0.75rem)",
          }}
        >
          {grid.cells.map((cell) => cell.inRange ? (
            <div
              key={cell.day}
              className={cn(
                "group relative h-3 w-3 rounded-[2px] ring-1 ring-inset ring-border/40 outline-none transition-transform hover:z-20 hover:scale-125 focus-visible:z-20 focus-visible:scale-125 focus-visible:ring-primary",
                activityCellClass(agentActivityLevel(cell.total, grid.maxTotal)),
              )}
              tabIndex={0}
              role="img"
              aria-label={`${cell.day}: ${t("agentDashboard.activityCount", { count: cell.total })}`}
            >
              <span className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-1.5 w-max max-w-48 -translate-x-1/2 rounded bg-popover px-2 py-1 text-[10px] font-medium text-popover-foreground opacity-0 shadow-md ring-1 ring-border transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                {formatDay(cell.day)} · {t("agentDashboard.activityCount", { count: cell.total })}
              </span>
            </div>
          ) : <span key={cell.day} className="h-3 w-3" aria-hidden="true" />)}
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between text-[9px] text-muted-foreground">
        <span>{formatDay(grid.startDay)} – {formatDay(grid.endDay)}</span>
        <span>{t("agentDashboard.activityPeak", { count: grid.maxTotal })}</span>
      </div>
    </div>
  );
}

export function AgentDashboardDialog({ open, onOpenChange }: AgentDashboardDialogProps) {
  const t = useT();
  const [range, setRange] = useState<AgentMetricRange>("7d");
  const [data, setData] = useState<AgentMetricsDashboard | null>(null);
  const [runPage, setRunPage] = useState<AgentMetricRunPage | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageCursors, setPageCursors] = useState<Array<string | null>>([null]);
  const [trace, setTrace] = useState<AgentMetricTrace | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [dashboard, firstPage] = await Promise.all([
        window.stela.agentMetrics.getDashboard(range),
        window.stela.agentMetrics.listRuns({ range, limit: TRACE_PAGE_SIZE }),
      ]);
      setData(dashboard);
      setRunPage(firstPage);
      setPageIndex(0);
      setPageCursors([null]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) void load();
    else setTrace(null);
  }, [open, range]);

  const totalTokens = data
    ? data.usage.promptTokens + data.usage.outputTokens
    : 0;

  const showTrace = async (runId: string) => {
    try {
      setTrace(await window.stela.agentMetrics.getTrace(runId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const loadRunPage = async (cursor: string | null, index: number) => {
    setError(null);
    try {
      setRunPage(await window.stela.agentMetrics.listRuns({
        range,
        limit: TRACE_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      }));
      setPageIndex(index);
      setTrace(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const nextRunPage = () => {
    const cursor = runPage?.nextCursor;
    if (!cursor) return;
    const nextIndex = pageIndex + 1;
    setPageCursors((current) => [...current.slice(0, nextIndex), cursor]);
    void loadRunPage(cursor, nextIndex);
  };

  const previousRunPage = () => {
    if (pageIndex === 0) return;
    void loadRunPage(pageCursors[pageIndex - 1] ?? null, pageIndex - 1);
  };

  const clearAll = async () => {
    if (!window.confirm(t("agentDashboard.clearConfirm"))) return;
    await window.stela.agentMetrics.clear();
    setTrace(null);
    await load();
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/45 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex h-[88vh] w-[1120px] max-w-[96vw] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl">
          <header className="flex items-center justify-between border-b border-border px-5 py-3">
            <div className="flex items-center gap-2.5">
              <Activity className="h-4 w-4 text-primary" />
              <div>
                <Dialog.Title className="text-sm font-semibold">{t("agentDashboard.title")}</Dialog.Title>
                <Dialog.Description className="text-[11px] text-muted-foreground">{t("agentDashboard.description")}</Dialog.Description>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex rounded-md border border-border p-0.5">
                {(["7d", "30d", "90d"] as const).map((value) => (
                  <button key={value} type="button" onClick={() => setRange(value)} className={cn("rounded px-2 py-1 text-[11px]", range === value ? "bg-accent text-foreground" : "text-muted-foreground")}>{value}</button>
                ))}
              </div>
              <button type="button" onClick={() => void load()} className="rounded-md border border-border p-1.5 text-muted-foreground hover:text-foreground" aria-label={t("agentDashboard.refresh")}><RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} /></button>
              <Dialog.Close asChild><button type="button" className="rounded-md p-1.5 text-muted-foreground hover:bg-accent"><X className="h-4 w-4" /></button></Dialog.Close>
            </div>
          </header>

          <div className="flex min-h-0 flex-1">
            <div className="min-w-0 flex-1 overflow-auto p-5">
              {error ? <div className="mb-4 flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive"><AlertTriangle className="h-4 w-4" />{error}</div> : null}
              {!data && loading ? <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{t("agentDashboard.loading")}</div> : null}
              {data ? (
                <div className="space-y-5">
                  <section className="grid grid-cols-3 gap-3">
                    <MetricCard label={t("agentDashboard.requests")} value={formatNumber(data.overview.total)} hint={t("agentDashboard.topLevelOnly")} />
                    <MetricCard label={t("agentDashboard.completionRate")} value={rate(data.overview.completed, data.overview.completed + data.overview.errors)} hint={t("agentDashboard.cancelSeparate")} />
                    <MetricCard label={t("agentDashboard.errors")} value={formatNumber(data.overview.errors)} />
                    <MetricCard label={t("agentDashboard.p95Latency")} value={formatDuration(data.overview.p95DurationMs)} />
                    <MetricCard
                      label={t("agentDashboard.cacheHitRate")}
                      value={formatRate(data.usage.cacheHitRate)}
                      hint={t("agentDashboard.cacheHitSummary", {
                        read: formatNumber(data.usage.cacheReadTokens),
                        prompt: formatNumber(data.usage.promptTokens),
                      })}
                    />
                    <MetricCard label={t("agentDashboard.tokens")} value={formatNumber(totalTokens)} hint={`${formatNumber(data.usage.inputTokens)} ${t("agentDashboard.tokensIn")} · ${formatNumber(data.usage.outputTokens)} ${t("agentDashboard.tokensOut")} · ${formatNumber(data.usage.cacheReadTokens)} ${t("agentDashboard.tokensCached")} · ${formatNumber(data.usage.cacheWriteTokens)} ${t("agentDashboard.tokensCacheWrite")}`} />
                  </section>

                  <p className="-mt-3 text-[10px] text-muted-foreground">{t("agentDashboard.cacheHitRateHelp")}</p>

                  <section className="rounded-lg border border-border p-4">
                    <div className="mb-3 flex items-center gap-2 text-xs font-semibold"><Clock3 className="h-3.5 w-3.5 text-muted-foreground" />{t("agentDashboard.daily")}</div>
                    <DailyActivityGrid data={data} range={range} />
                  </section>

                  <div className="grid grid-cols-2 gap-4">
                    <section className="rounded-lg border border-border p-4">
                      <h3 className="mb-1 text-xs font-semibold">{t("agentDashboard.skillUsage")}</h3>
                      <p className="mb-3 text-[10px] text-muted-foreground">{t("agentDashboard.skillUsageHelp")}</p>
                      <div className="grid grid-cols-4 gap-2 text-center">
                        {[
                          [t("agentDashboard.skillMatched"), data.skillUsage.matchedRuns],
                          [t("agentDashboard.skillUsed"), data.skillUsage.usedRuns],
                          [t("agentDashboard.skillLoads"), data.skillUsage.loadCount],
                          [t("agentDashboard.skillHitRate"), data.skillUsage.usageRate === null ? "—" : `${Math.round(data.skillUsage.usageRate * 100)}%`],
                        ].map(([label, value]) => <div key={String(label)} className="rounded bg-muted/50 p-2"><div className="text-base font-semibold tabular-nums">{value}</div><div className="text-[9px] text-muted-foreground">{label}</div></div>)}
                      </div>
                      {data.skillUsage.items.length > 0 ? (
                        <div className="mt-3 max-h-56 overflow-auto rounded border border-border">
                          <table className="w-full text-[10px]">
                            <thead className="bg-muted/50 text-muted-foreground"><tr><th className="px-2 py-1.5 text-left font-medium">Skill</th><th className="px-2 py-1.5 text-left font-medium">{t("skills.library.category")}</th><th className="px-2 py-1.5 text-right font-medium">{t("agentDashboard.skillMatched")}</th><th className="px-2 py-1.5 text-right font-medium">{t("agentDashboard.skillUsed")}</th><th className="px-2 py-1.5 text-right font-medium">{t("agentDashboard.skillLoads")}</th><th className="px-2 py-1.5 text-right font-medium">{t("agentDashboard.skillHitRate")}</th></tr></thead>
                            <tbody>{data.skillUsage.items.map((item) => <tr key={item.name} className="border-t border-border"><td className="max-w-[120px] truncate px-2 py-1.5 font-mono" title={item.name}>{item.name}</td><td className="max-w-[90px] truncate px-2 py-1.5 text-muted-foreground" title={item.category ?? "—"}>{item.category ?? "—"}</td><td className="px-2 py-1.5 text-right tabular-nums">{item.matchedRuns}</td><td className="px-2 py-1.5 text-right tabular-nums">{item.usedRuns}</td><td className="px-2 py-1.5 text-right tabular-nums">{item.loadCount}</td><td className="px-2 py-1.5 text-right tabular-nums">{Math.round(item.usageRate * 100)}%</td></tr>)}</tbody>
                          </table>
                        </div>
                      ) : <div className="mt-3 text-[10px] text-muted-foreground">{t("agentDashboard.noSkillUsage")}</div>}
                    </section>
                    <section className="rounded-lg border border-border p-4">
                      <h3 className="mb-3 text-xs font-semibold">{t("agentDashboard.knowledge")}</h3>
                      <div className="flex flex-wrap gap-2">
                        {data.knowledgeOutcomes.length === 0 ? <span className="text-xs text-muted-foreground">{t("agentDashboard.empty")}</span> : data.knowledgeOutcomes.map((item) => <span key={item.key} className="rounded-full border border-border bg-muted/40 px-2 py-1 text-[10px]"><span>{knowledgeOutcomeLabel(item.key, t)}</span> · {item.count}</span>)}
                      </div>
                      {data.knowledgeOutcomes.some((item) => item.key === "no_source") ? <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">{t("agentDashboard.noSourceHelp")}</p> : null}
                      <div className="mt-3 border-t border-border pt-3">
                        <div className="mb-2 text-[10px] font-medium text-muted-foreground">{t("agentDashboard.generatedTypes")}</div>
                        {data.knowledgeCategories.length === 0 ? <div className="text-[10px] text-muted-foreground">{t("agentDashboard.noGeneratedSkills")}</div> : (
                          <div className="space-y-2">
                            {data.knowledgeCategories.map((item) => (
                              <div key={item.category} className="grid grid-cols-[110px_1fr_68px] items-center gap-2 text-[10px]">
                                <span className="truncate font-mono" title={item.category}>{item.category}</span>
                                <div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(2, item.share * 100)}%` }} /></div>
                                <span className="text-right tabular-nums text-muted-foreground">{item.count} · {Math.round(item.share * 100)}%</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </section>
                  </div>

                  <section><h3 className="mb-2 text-xs font-semibold">{t("agentDashboard.surfaces")}</h3><BreakdownTable rows={data.surfaces} /></section>
                  <section><h3 className="mb-2 text-xs font-semibold">{t("agentDashboard.tools")}</h3>{data.tools.length ? <BreakdownTable rows={data.tools} /> : <div className="rounded-md border border-border py-6 text-center text-xs text-muted-foreground">{t("agentDashboard.empty")}</div>}</section>

                  <section>
                    <div className="mb-2 flex items-center justify-between"><h3 className="text-xs font-semibold">{t("agentDashboard.recent")}</h3><button type="button" onClick={() => void clearAll()} className="flex items-center gap-1 rounded px-2 py-1 text-[10px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive"><Trash2 className="h-3 w-3" />{t("agentDashboard.clear")}</button></div>
                    <div className="overflow-hidden rounded-md border border-border">
                      {(runPage?.runs ?? []).map((run) => (
                        <button key={run.runId} type="button" onClick={() => void showTrace(run.runId)} className="grid w-full grid-cols-[150px_1fr_110px_90px] items-center gap-3 border-b border-border px-3 py-2 text-left text-[11px] last:border-b-0 hover:bg-accent/50">
                          <span className="font-mono text-muted-foreground">{new Date(run.startedAt).toLocaleString()}</span>
                          <span className="min-w-0 truncate"><span className="font-medium text-foreground">{run.surface}</span><span className="ml-2 font-mono text-muted-foreground">{run.operation}</span></span>
                          <StatusPill run={run} />
                          <span className="text-right tabular-nums text-muted-foreground">{formatDuration(run.durationMs)}</span>
                        </button>
                      ))}
                      {runPage?.runs.length === 0 ? <div className="py-6 text-center text-xs text-muted-foreground">{t("agentDashboard.empty")}</div> : null}
                    </div>
                    <div className="mt-2 flex items-center justify-end gap-2 text-[10px] text-muted-foreground">
                      <button type="button" onClick={previousRunPage} disabled={pageIndex === 0} className="rounded border border-border p-1 disabled:opacity-40" aria-label={t("agentDashboard.previousPage")}><ChevronLeft className="h-3.5 w-3.5" /></button>
                      <span>{t("agentDashboard.page")} {pageIndex + 1}</span>
                      <button type="button" onClick={nextRunPage} disabled={!runPage?.nextCursor} className="rounded border border-border p-1 disabled:opacity-40" aria-label={t("agentDashboard.nextPage")}><ChevronRight className="h-3.5 w-3.5" /></button>
                    </div>
                  </section>

                  <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-[10px] text-amber-800 dark:text-amber-300"><Database className="mt-0.5 h-3.5 w-3.5 flex-none" />{t("agentDashboard.privacy")}</div>
                </div>
              ) : null}
            </div>

            {trace ? (
              <aside className="w-[390px] flex-none overflow-auto border-l border-border bg-muted/15 p-4">
                <div className="mb-3 flex items-center justify-between"><h3 className="text-xs font-semibold">{t("agentDashboard.trace")}</h3><button type="button" onClick={() => setTrace(null)} className="rounded p-1 text-muted-foreground hover:bg-accent"><X className="h-3.5 w-3.5" /></button></div>
                <div className="mb-3 space-y-1 rounded-md border border-border bg-background p-3 text-[10px]"><div className="font-mono break-all">{trace.run.runId}</div><div>{trace.run.surface} · {trace.run.operation} · {formatDuration(trace.run.durationMs)}</div><div className="text-muted-foreground">{t("agentDashboard.cacheHitRate")} · {formatRate(runCacheHitRate(trace.run))} ({formatNumber(trace.run.cacheReadTokens)} / {formatNumber(trace.run.inputTokens + trace.run.cacheReadTokens + trace.run.cacheWriteTokens)})</div><StatusPill run={trace.run} /></div>
                {[{ title: t("agentDashboard.request"), value: trace.request }, { title: t("agentDashboard.response"), value: trace.response }].map((item) => <details key={item.title} open className="mb-3 rounded-md border border-border bg-background"><summary className="cursor-pointer px-3 py-2 text-[10px] font-semibold">{item.title}</summary><pre className="max-h-64 overflow-auto border-t border-border p-3 text-[9px] whitespace-pre-wrap break-all">{JSON.stringify(item.value, null, 2)}</pre></details>)}
                <div className="space-y-2">{trace.events.map((event) => <details key={event.id} className="rounded-md border border-border bg-background"><summary className="cursor-pointer px-3 py-2 text-[10px]"><span className="font-mono">{event.type}</span>{event.name ? ` · ${event.name}` : ""}{event.durationMs !== null ? ` · ${formatDuration(event.durationMs)}` : ""}</summary><pre className="max-h-56 overflow-auto border-t border-border p-3 text-[9px] whitespace-pre-wrap break-all">{JSON.stringify(event.payload, null, 2)}</pre></details>)}</div>
              </aside>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
