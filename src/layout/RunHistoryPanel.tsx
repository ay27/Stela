/**
 * 全局 Run History 侧栏面板（v0.2 #5）。
 *
 * - 按 startedAt 倒序展示当前 vault 内的所有 RunRecord
 * - 折叠态：状态点 + 连接名 + 相对时间 + SQL 摘要 + rows / elapsed
 * - 点击行展开：
 *     · 多行 SQL <pre>（保留原换行 / 缩进）
 *     · status=err 时的完整错误信息
 *     · blockId + 完整时间戳 + 文件路径
 *     · 操作按钮：打开笔记（notePath 缺失时置灰）/ 复制 SQL
 * - 顶部：关键字过滤（client-side，按 sql / 连接 / blockId）+ 刷新按钮
 *
 * 性能：listRuns 一次拉全量，对于 dogfood 量级（数百到数千行）够用；超大 vault
 * 后续再接分页 IPC（不在 v0.2 范围）。
 */

import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { RunRecord } from "@/contracts";
import { electronStorage } from "@/services/storage/electron-storage";
import { useWorkspace } from "@/state/workspace";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n/use-t";

interface State {
  loading: boolean;
  error: string | null;
  runs: RunRecord[];
}

const INITIAL: State = { loading: false, error: null, runs: [] };

export function RunHistoryPanel() {
  const t = useT();
  const vaultReady = useWorkspace((s) => s.vaultReady);
  const openFile = useWorkspace((s) => s.openFile);

  const [state, setState] = useState<State>(INITIAL);
  const [keyword, setKeyword] = useState("");
  /** 展开的 runId 集合。点击行翻转。 */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** 复制反馈：1.2s 内显示"已复制"。 */
  const [flash, setFlash] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const runs = await electronStorage.listRuns();
      setState({ loading: false, error: null, runs });
    } catch (err) {
      setState((s) => ({
        ...s,
        loading: false,
        error: (err as Error)?.message ?? t("errors.generic"),
      }));
    }
  }, [t]);

  useEffect(() => {
    if (!vaultReady) return;
    void refresh();
  }, [vaultReady, refresh]);

  const filtered = useMemo(() => {
    const k = keyword.trim().toLowerCase();
    if (!k) return state.runs;
    return state.runs.filter((r) => {
      return (
        r.sql.toLowerCase().includes(k) ||
        r.connectionName.toLowerCase().includes(k) ||
        r.blockId.toLowerCase().includes(k)
      );
    });
  }, [state.runs, keyword]);

  const toggle = (runId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  };

  const onCopy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setFlash(key);
      window.setTimeout(() => {
        setFlash((cur) => (cur === key ? null : cur));
      }, 1200);
    } catch {
      // 剪贴板权限被拒，静默
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-2.5 py-2">
        <div className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 focus-within:border-primary">
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder={t("runHistory.filterPlaceholder")}
            className="flex-1 bg-transparent py-0.5 text-[12px] focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={state.loading}
            className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-40"
            title={t("common.refresh")}
          >
            {state.loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
        <div className="mt-1.5 text-[10px] text-muted-foreground">
          {state.error
            ? t("runHistory.refreshFailed")
            : t("runHistory.count", {
                filtered: filtered.length,
                total: state.runs.length,
              })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {state.error ? (
          <div className="px-3 py-2 text-[11px] text-destructive">
            {state.error}
          </div>
        ) : null}
        {!state.error && filtered.length === 0 && !state.loading ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            {state.runs.length === 0
              ? t("runHistory.empty")
              : t("runHistory.noMatches")}
          </div>
        ) : null}
        {filtered.map((run) => (
          <RunRow
            key={run.runId}
            run={run}
            isExpanded={expanded.has(run.runId)}
            flash={flash}
            onToggle={() => toggle(run.runId)}
            onOpen={() => run.notePath && openFile(run.notePath)}
            onCopy={onCopy}
          />
        ))}
      </div>
    </div>
  );
}

function RunRow({
  run,
  isExpanded,
  flash,
  onToggle,
  onOpen,
  onCopy,
}: {
  run: RunRecord;
  isExpanded: boolean;
  flash: string | null;
  onToggle: () => void;
  onOpen: () => void;
  onCopy: (key: string, text: string) => void | Promise<void>;
}) {
  const t = useT();
  const ok = run.status === "ok";
  const sqlOneLine = useMemo(() => collapseWhitespace(run.sql), [run.sql]);
  const canOpen = !!run.notePath;
  const copyKey = `sql:${run.runId}`;

  return (
    <div className="border-b border-border/60">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full flex-col gap-0.5 px-2.5 py-1.5 text-left hover:bg-sidebar-hover"
      >
        <div className="flex items-center gap-1.5 text-[11px]">
          {isExpanded ? (
            <ChevronDown className="h-3 w-3 flex-none text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3 w-3 flex-none text-muted-foreground" />
          )}
          {ok ? (
            <CheckCircle2 className="h-3 w-3 flex-none text-emerald-600 dark:text-emerald-400" />
          ) : (
            <XCircle className="h-3 w-3 flex-none text-destructive" />
          )}
          <span className="truncate font-medium" title={run.connectionName}>
            {run.connectionName || t("common.noConnection")}
          </span>
          <span
            className="ml-auto flex-none text-[10px] text-muted-foreground"
            title={new Date(run.startedAt).toLocaleString()}
          >
            {formatRelative(run.startedAt)}
          </span>
        </div>
        <div
          className="ml-[18px] truncate font-mono text-[11px] text-foreground/90"
          title={run.sql}
        >
          {sqlOneLine}
        </div>
        <div className="ml-[18px] flex items-center gap-2 text-[10px] text-muted-foreground">
          <span>{t("common.rows", { count: run.rowCount })}</span>
          <span>{formatElapsed(run.elapsedMs)}</span>
          {run.blockId ? (
            <span className="truncate" title={`block ${run.blockId}`}>
              block {run.blockId.slice(0, 8)}
            </span>
          ) : null}
        </div>
      </button>

      {isExpanded ? (
        <div className="border-l-2 border-border/60 bg-muted/30 px-3 py-2 ml-5 mr-2 mb-1 text-[11px]">
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-background/60 p-2 font-mono text-[11px] text-foreground/90">
            {run.sql}
          </pre>

          {!ok && run.message ? (
            <div className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded border border-destructive/30 bg-destructive/5 p-2 text-[10.5px] text-destructive">
              {run.message}
            </div>
          ) : null}

          <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
            <dt>started</dt>
            <dd className="font-mono text-foreground/80">
              {new Date(run.startedAt).toLocaleString()}
            </dd>
            <dt>blockId</dt>
            <dd className="truncate font-mono text-foreground/80">
              {run.blockId || "(empty)"}
            </dd>
            {run.notePath ? (
              <>
                <dt>note</dt>
                <dd
                  className="truncate font-mono text-foreground/80"
                  title={run.notePath}
                >
                  {run.notePath}
                </dd>
              </>
            ) : null}
          </dl>

          <div className="mt-2 flex items-center gap-1.5">
            <button
              type="button"
              onClick={onOpen}
              disabled={!canOpen}
              className={cn(
                "inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px]",
                canOpen
                  ? "bg-background hover:bg-accent"
                  : "cursor-not-allowed bg-muted text-muted-foreground/60",
              )}
              title={
                canOpen
                  ? t("runHistory.openTitle", { path: run.notePath })
                  : t("runHistory.missingPathTitle")
              }
            >
              <ExternalLink className="h-3 w-3" />
              {t("runHistory.openNote")}
            </button>
            <button
              type="button"
              onClick={() => void onCopy(copyKey, run.sql)}
              className="inline-flex items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5 text-[10px] hover:bg-accent"
              title={t("runHistory.copySqlTitle")}
            >
              <Copy className="h-3 w-3" />
              {flash === copyKey ? t("common.copied") : t("runHistory.copySql")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(ts).toLocaleDateString();
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(2)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${Math.round(s - m * 60)}s`;
}
