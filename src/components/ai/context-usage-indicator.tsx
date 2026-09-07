import { useEffect, useId, useRef, useState } from "react";
import type { AgentMetricRunSummary } from "@shared/types";
import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";

export function ContextUsageIndicator({
  usedTokens,
  contextWindow,
  estimated,
  runId,
  busy,
}: {
  usedTokens: number;
  contextWindow: number;
  estimated: boolean;
  runId: string | null;
  busy: boolean;
}) {
  const t = useT();
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [run, setRun] = useState<AgentMetricRunSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  useEffect(() => {
    if (!open || !runId) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const trace = await window.stela.agentMetrics.getTrace(`agent:${runId}`);
        if (live) {
          setRun(trace.run);
          setFailed(false);
        }
      } catch {
        if (live) setFailed(true);
      } finally {
        if (live) {
          setLoading(false);
          // Only read metrics while expanded, and never overlap requests.
          if (busy) timer = setTimeout(refresh, 5000);
        }
      }
    };
    setRun(null);
    setFailed(false);
    setLoading(true);
    void refresh();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [open, runId, busy]);

  const percent = Math.min(100, Math.max(0, Math.round((usedTokens / contextWindow) * 100)));
  const circumference = 2 * Math.PI * 7;
  const tone = percent >= 90 ? "text-destructive" : percent >= 70 ? "text-amber-500" : "text-primary";
  const format = (value: number) => value.toLocaleString();
  const label = t("agent.context.summary", {
    percent,
    used: format(usedTokens),
    limit: format(contextWindow),
  });
  // A new conversation turn must not display the previous turn's counters.
  const current = run?.runId === `agent:${runId}` ? run : null;
  const promptTokens = current
    ? current.inputTokens + current.cacheReadTokens + current.cacheWriteTokens
    : 0;
  const totalTokens = promptTokens + (current?.outputTokens ?? 0);
  const rows = current ? [
    [t("agent.context.input"), current.inputTokens],
    [t("agent.context.output"), current.outputTokens],
    [t("agent.context.cacheRead"), current.cacheReadTokens],
    [t("agent.context.cacheWrite"), current.cacheWriteTokens],
    [t("agentDashboard.totalTokens"), totalTokens],
  ] as const : [];

  return (
    <div
      ref={menuRef}
      className="stela-context-usage relative flex-none"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setOpen(false);
          triggerRef.current?.focus();
          event.stopPropagation();
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className={cn(
          "flex h-5 w-5 cursor-pointer items-center justify-center rounded hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          tone,
        )}
        title={label}
        aria-label={label}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" className="-rotate-90" aria-hidden="true">
          <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="2" className="opacity-20" />
          <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - percent / 100)} />
        </svg>
      </button>
      {open && <div id={panelId} role="region" aria-label={t("agentDashboard.contextWindow")} tabIndex={-1} className="absolute right-0 top-7 z-20 w-64 space-y-3 rounded-md border border-border bg-popover p-3 text-[11px] text-popover-foreground shadow-md outline-none">
        <div>
          <div className="flex items-center justify-between font-medium">
            <span>{t("agentDashboard.contextWindow")}</span>
            <span className={tone}>{percent}%</span>
          </div>
          <div className="mt-1 tabular-nums text-muted-foreground">
            {format(usedTokens)} / {format(contextWindow)} tokens
            {estimated ? ` · ${t("agent.context.estimated")}` : ""}
          </div>
        </div>
        <div className="border-t border-border pt-2">
          <div className="mb-2 font-medium">{t("agent.context.turnUsage")}</div>
          {loading ? (
            <div className="text-muted-foreground" role="status">{t("common.loading")}</div>
          ) : failed ? (
            <div className="text-muted-foreground" role="status">{t("agent.context.loadFailed")}</div>
          ) : current && totalTokens > 0 ? (
            <>
              <dl className="space-y-1.5">
                {rows.map(([name, value]) => (
                  <div key={name} className="flex items-center justify-between gap-3">
                    <dt className="text-muted-foreground">{name}</dt>
                    <dd className="tabular-nums">{format(value)}</dd>
                  </div>
                ))}
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">{t("agentDashboard.cacheHitRate")}</dt>
                  <dd className="tabular-nums">{promptTokens > 0 ? `${(current.cacheReadTokens / promptTokens * 100).toFixed(1)}%` : "—"}</dd>
                </div>
              </dl>
              <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">{t("agent.context.usageHelp")}</p>
            </>
          ) : (
            <div className="text-muted-foreground">{t("agent.context.unavailable")}</div>
          )}
        </div>
      </div>}
    </div>
  );
}
