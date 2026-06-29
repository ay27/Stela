/**
 * RunSQL 块内嵌的结果区域（每个 block 独立、可折叠、不互相抢占）。
 *
 * 改动：从"触底无限滚动"改成"分页按钮"模式：
 *   - 页大小 10 / 50 / 100 / 1000，默认 10
 *   - pageIndex 变化 → 从 SQLite 再拉一页（现有 electronStorage.queryPage(offset, limit) 直接用）
 *   - 表格本身不再有滚动条，高度随当前页行数自然展开；纵向滚动交给页面外层
 *   - 空结果（mutation / 0 rows）显示更紧凑的一行提示，不再固定 80px 占空
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  AlertCircle,
  ChevronLeft,
  ChevronsLeft,
  ChevronsRight,
  Download,
  Sparkles,
} from "lucide-react";

import type { ColumnDef, RunRecord } from "@/contracts";
import { ResultTable } from "@/components/result-table";
import {
  RunTabs,
  RUN_TABS_MAX_VISIBLE,
  type RunTabItem,
} from "@/components/block-run-tabs";
import { ResultDiffTable } from "@/components/result-diff-table";
import {
  buildCsvContent,
  buildExcelXmlContent,
  buildJsonContent,
  triggerDownload,
} from "@/components/result-export";
import { MiniSelect, type MiniSelectOption } from "@/components/ui/mini-select";
import { electronStorage } from "@/services/storage/electron-storage";
import { loadResultPage } from "@/services/result-loader";
import { useT } from "@/i18n/use-t";
import {
  computeResultDiff,
  DIFF_ROW_CAP,
  type ResultDiff,
} from "@/services/result-diff";
import { cn } from "@/lib/utils";
import type { DetailMeta } from "@/core/types";

const PAGE_SIZES = [10, 50, 100, 1000] as const;
const DEFAULT_PAGE_SIZE = 10;
const EXPORT_BATCH_SIZE = 1000;

export type BlockResultRunState = "idle" | "running" | "error";

export type BlockResultViewMode = "browse" | "compare";

/**
 * Block 内历史浏览 / 比对的纯 UI 态（不落 markdown）。由 NodeView 持有，
 * 新执行完成时重置为 browse + 最新。
 */
export interface BlockResultViewState {
  mode: BlockResultViewMode;
  /** 浏览模式激活的 run；null = 「最新」(detail.resultRefId) */
  activeRunId: string | null;
  /** 比对基线（较旧） */
  diffBaselineRunId: string | null;
  /** 比对当前（较新） */
  diffCurrentRunId: string | null;
  /** 行匹配 key 列名；null = 自动推断 */
  diffKeyColumns: string[] | null;
}

export const DEFAULT_VIEW_STATE: BlockResultViewState = {
  mode: "browse",
  activeRunId: null,
  diffBaselineRunId: null,
  diffCurrentRunId: null,
  diffKeyColumns: null,
};

export interface BlockResultProps {
  /** 最新一次成功执行的 run id（= detail.resultRefId） */
  runId: string | null;
  /** 该 block 的稳定标识；用于按 block 拉历史 run 列表 */
  blockId: string | null;
  detail: DetailMeta | null;
  runState: BlockResultRunState;
  errorMessage?: string | null;
  expanded: boolean;
  /** 递增即触发一次强制重拉；用于 Mod+R 等刷新场景 */
  refreshNonce?: number;
  /** 历史浏览 / 比对 UI 态（由 NodeView 持有） */
  viewState?: BlockResultViewState;
  onViewStateChange?: (next: BlockResultViewState) => void;
  onToggle: () => void;
  /** 执行失败时从 result-bar 发起 AI 改写 */
  onAiFix?: () => void;
}

interface FetchedState {
  runId: string;
  schema: ColumnDef[] | null;
  rows: unknown[][];
  total: number;
  pageIndex: number;
  pageSize: number;
  loading: boolean;
  error: string | null;
}

interface DiffState {
  baselineRunId: string;
  currentRunId: string;
  loading: boolean;
  error: string | null;
  diff: ResultDiff | null;
  /** 任一侧行数超过 DIFF_ROW_CAP 被截断 */
  truncated: boolean;
}

export function BlockResult({
  runId,
  blockId,
  detail,
  runState,
  errorMessage,
  expanded,
  refreshNonce = 0,
  viewState = DEFAULT_VIEW_STATE,
  onViewStateChange,
  onToggle,
  onAiFix,
}: BlockResultProps) {
  const t = useT();
  const [state, setState] = useState<FetchedState | null>(null);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [exporting, setExporting] = useState<null | "csv" | "excel" | "json">(
    null,
  );
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [diffState, setDiffState] = useState<DiffState | null>(null);
  const reqIdRef = useRef(0);
  const diffReqIdRef = useRef(0);

  const inCompare = viewState.mode === "compare";
  // 浏览模式下实际查看的 run：activeRunId 优先，否则最新
  const effectiveRunId = viewState.activeRunId ?? runId;
  const activeRun = runs.find((r) => r.runId === effectiveRunId) ?? null;
  const viewingHistory = effectiveRunId !== null && effectiveRunId !== runId;

  const patchViewState = useCallback(
    (patch: Partial<BlockResultViewState>) => {
      onViewStateChange?.({ ...viewState, ...patch });
    },
    [onViewStateChange, viewState],
  );

  // detail 在 React state 之外用 ref 缓存，避免把 detail 放进 fetchPage 的依赖
  // 数组——detail 在每次执行后会变化，但 fetchPage 的恒等性要保持稳定，否则
  // 触底分页 / pageSize 切换时会重新创建 effect。
  const detailRef = useRef<DetailMeta | null>(detail);
  detailRef.current = detail;
  // 浏览历史 run 时，恢复判断用该 run 自身的 rowCount（detail 只描述最新）。
  const activeRowCountRef = useRef<number | null>(null);
  activeRowCountRef.current = activeRun?.rowCount ?? detail?.rowCount ?? null;

  // 加载该 block 的历史 run 列表（展开 + 有 blockId 时）。最新执行 / 刷新后重拉。
  useEffect(() => {
    if (!expanded || !blockId) {
      setRuns([]);
      return;
    }
    let cancelled = false;
    electronStorage
      .listRunsByBlockId(blockId, { limit: 50 })
      .then((list) => {
        if (!cancelled) setRuns(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          console.error("[stela] listRunsByBlockId failed", err);
          setRuns([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, blockId, runId, refreshNonce]);

  const fetchPage = useCallback(
    (targetRunId: string, pageIdx: number, size: number) => {
      const reqId = ++reqIdRef.current;
      setState((prev) => ({
        runId: targetRunId,
        schema: prev?.runId === targetRunId ? prev.schema : null,
        rows: [],
        total: prev?.runId === targetRunId ? prev.total : 0,
        pageIndex: pageIdx,
        pageSize: size,
        loading: true,
        error: null,
      }));
      // 走统一的 result-loader：本地命中直接返回；本地缺数据但 detail 记过非零
      // 行数时（典型场景：vault 切机器 / 清过 .stela.sqlite 缓存）会自动按 runId
      // 从执行历史 JSONL 导入一次写回缓存，再读一遍。
      // 详见 [`src/services/result-loader.ts`](../services/result-loader.ts)。
      loadResultPage(
        {
          runId: targetRunId,
          detailRowCount: activeRowCountRef.current,
          pageIndex: pageIdx,
          pageSize: size,
        },
        {
          storage: {
            getSchema: electronStorage.getSchema,
            queryPage: electronStorage.queryPage,
          },
          journal: {
            importRun: (id) => window.stela.journal.importRun(id),
          },
        },
      )
        .then((res) => {
          if (reqIdRef.current !== reqId) return;
          setState({
            runId: targetRunId,
            schema: res.schema,
            rows: res.rows,
            total: res.total,
            pageIndex: pageIdx,
            pageSize: size,
            loading: false,
            error: null,
          });
        })
        .catch((err: unknown) => {
          if (reqIdRef.current !== reqId) return;
          setState({
            runId: targetRunId,
            schema: null,
            rows: [],
            total: 0,
            pageIndex: pageIdx,
            pageSize: size,
            loading: false,
            error: errMessage(err),
          });
        });
    },
    [],
  );

  // effectiveRunId / pageSize / refreshNonce 变化 → 重置到第 0 页（仅浏览模式）
  useEffect(() => {
    if (!expanded || inCompare) return;
    if (!effectiveRunId) {
      setState(null);
      return;
    }
    fetchPage(effectiveRunId, 0, pageSize);
  }, [effectiveRunId, expanded, inCompare, pageSize, refreshNonce, fetchPage]);

  // 比对模式：并行拉 baseline / current 两侧前 DIFF_ROW_CAP 行，算 diff
  useEffect(() => {
    if (!expanded || !inCompare) {
      setDiffState(null);
      return;
    }
    const baseline = viewState.diffBaselineRunId;
    const current = viewState.diffCurrentRunId;
    if (!baseline || !current) {
      setDiffState(null);
      return;
    }
    const reqId = ++diffReqIdRef.current;
    setDiffState({
      baselineRunId: baseline,
      currentRunId: current,
      loading: true,
      error: null,
      diff: null,
      truncated: false,
    });
    const rowCountOf = (id: string) =>
      runs.find((r) => r.runId === id)?.rowCount ?? null;
    Promise.all([
      loadDiffSide(baseline, rowCountOf(baseline)),
      loadDiffSide(current, rowCountOf(current)),
    ])
      .then(([left, right]) => {
        if (diffReqIdRef.current !== reqId) return;
        const diff = computeResultDiff(
          { columns: left.columns, rows: left.rows },
          { columns: right.columns, rows: right.rows },
          { keyColumns: viewState.diffKeyColumns },
        );
        setDiffState({
          baselineRunId: baseline,
          currentRunId: current,
          loading: false,
          error: null,
          diff,
          truncated: left.truncated || right.truncated,
        });
      })
      .catch((err: unknown) => {
        if (diffReqIdRef.current !== reqId) return;
        setDiffState({
          baselineRunId: baseline,
          currentRunId: current,
          loading: false,
          error: errMessage(err),
          diff: null,
          truncated: false,
        });
      });
  }, [
    expanded,
    inCompare,
    viewState.diffBaselineRunId,
    viewState.diffCurrentRunId,
    viewState.diffKeyColumns,
    refreshNonce,
    runs,
  ]);

  const gotoPage = useCallback(
    (pageIdx: number) => {
      if (!state || !effectiveRunId) return;
      const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
      const clamped = Math.max(0, Math.min(totalPages - 1, pageIdx));
      if (clamped === state.pageIndex) return;
      fetchPage(effectiveRunId, clamped, state.pageSize);
    },
    [state, effectiveRunId, fetchPage],
  );

  const changePageSize = useCallback(
    (size: number) => {
      setPageSize(size);
      if (effectiveRunId && state) {
        // 换页大小后定位到第一条原来所在页的新下标
        const firstRowGlobalIdx = state.pageIndex * state.pageSize;
        const newPageIdx = Math.floor(firstRowGlobalIdx / size);
        fetchPage(effectiveRunId, newPageIdx, size);
      }
    },
    [effectiveRunId, state, fetchPage],
  );

  const summary = renderSummary({
    runState,
    detail,
    runId: effectiveRunId,
    state,
    failedLabel: t("runTabs.failed"),
    activeRun: viewingHistory ? activeRun : null,
  });

  // 分页控件只在"有结果集 + 展开"时才显示在左侧
  const showPager =
    expanded &&
    !!state &&
    state.error === null &&
    state.schema !== null &&
    state.schema.length > 0;
  const showExport = showPager && state.total > 0;

  const exportAllRows = useCallback(
    async (fmt: "csv" | "excel" | "json") => {
      if (
        !state ||
        !effectiveRunId ||
        state.schema === null ||
        state.schema.length === 0
      )
        return;
      try {
        setExporting(fmt);
        const allRows: unknown[][] = [];
        for (
          let offset = 0;
          offset < state.total;
          offset += EXPORT_BATCH_SIZE
        ) {
          const page = await electronStorage.queryPage(
            effectiveRunId,
            offset,
            EXPORT_BATCH_SIZE,
          );
          allRows.push(...page.rows);
        }
        const ts =
          detail?.runDate?.replace(/[^\d]/g, "").slice(0, 14) ??
          Date.now().toString();
        const base = `stela-result-${effectiveRunId.slice(0, 8)}-${ts}`;
        if (fmt === "csv") {
          triggerDownload(
            `${base}.csv`,
            buildCsvContent(state.schema, allRows),
            "text/csv;charset=utf-8",
          );
          return;
        }
        if (fmt === "json") {
          triggerDownload(
            `${base}.json`,
            buildJsonContent(state.schema, allRows),
            "application/json;charset=utf-8",
          );
          return;
        }
        triggerDownload(
          `${base}.xls`,
          buildExcelXmlContent(state.schema, allRows),
          "application/vnd.ms-excel;charset=utf-8",
        );
      } catch (err) {
        console.error("[stela] export failed", err);
      } finally {
        setExporting(null);
      }
    },
    [state, effectiveRunId, detail?.runDate],
  );

  // 底部版本栏的 tab 列表：「最新」在首位，其余按时间倒序
  const tabItems: RunTabItem[] = (() => {
    if (runs.length === 0) return [];
    const latest = runs.find((r) => r.runId === runId) ?? null;
    const rest = runs.filter((r) => r.runId !== runId);
    const ordered = latest ? [latest, ...rest] : rest;
    return ordered.map((run) => ({ run, isLatest: run.runId === runId }));
  })();

  // 可比对的 run（成功且有结果集）
  const canCompare = runs.filter((r) => r.status === "ok").length >= 2;
  // 是否展示底部版本栏：有 ≥2 个版本（含最新）才有切换 / 对比意义
  const showRunTabs = expanded && tabItems.length >= 2;

  const selectedRunIds = [
    viewState.diffBaselineRunId,
    viewState.diffCurrentRunId,
  ].filter((id): id is string => id !== null);

  const startedAtOf = useCallback(
    (id: string) => runs.find((r) => r.runId === id)?.startedAt ?? 0,
    [runs],
  );

  const enterCompare = useCallback(() => {
    // 默认与上一版比对：current = 最新 ok，baseline = 次新 ok
    const ok = runs.filter((r) => r.status === "ok");
    const current = ok.find((r) => r.runId === runId) ?? ok[0] ?? null;
    const baseline = ok.find((r) => r.runId !== current?.runId) ?? null;
    patchViewState({
      mode: "compare",
      diffCurrentRunId: current?.runId ?? null,
      diffBaselineRunId: baseline?.runId ?? null,
    });
  }, [runs, runId, patchViewState]);

  const exitCompare = useCallback(() => {
    patchViewState({ mode: "browse" });
  }, [patchViewState]);

  const toggleCompare = useCallback(() => {
    if (inCompare) exitCompare();
    else enterCompare();
  }, [inCompare, enterCompare, exitCompare]);

  // 比对模式：勾选 / 取消勾选一个版本，维持最多两个，按时间归一为 基线/当前
  const toggleCompareSelect = useCallback(
    (id: string) => {
      const set = new Set(selectedRunIds);
      if (set.has(id)) {
        set.delete(id);
      } else {
        if (set.size >= 2) {
          // 已满 → 去掉较旧的那个腾位
          const arr = [...set];
          const oldest = arr.reduce((a, b) =>
            startedAtOf(a) <= startedAtOf(b) ? a : b,
          );
          set.delete(oldest);
        }
        set.add(id);
      }
      const arr = [...set].sort((a, b) => startedAtOf(a) - startedAtOf(b));
      patchViewState({
        diffBaselineRunId: arr[0] ?? null,
        diffCurrentRunId: arr[1] ?? null,
      });
    },
    [selectedRunIds, startedAtOf, patchViewState],
  );

  const selectBrowse = useCallback(
    (id: string) => {
      patchViewState({ activeRunId: id === runId ? null : id });
    },
    [runId, patchViewState],
  );

  const showPartControls = showPager && !inCompare;
  const diff = diffState?.diff ?? null;

  return (
    <div className="stela-cb__result">
      <div className="stela-cb__result-bar">
        <button
          type="button"
          className="stela-cb__result-toggle"
          onClick={onToggle}
          title={expanded ? "折叠" : "展开"}
        >
          {expanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </button>

        {/* 比对模式：行匹配 key 列选择（run 选择走底部版本栏勾选） */}
        {expanded && inCompare && diff ? (
          <KeyColumnSelect
            keyColumns={viewState.diffKeyColumns}
            diff={diff}
            onChange={(cols) => patchViewState({ diffKeyColumns: cols })}
          />
        ) : null}

        {/* 部分（单 run 内）：分页 + 导出，比对模式隐藏 */}
        {showPartControls && state ? (
          <div className="flex items-center gap-2 border-l border-border pl-2">
            <Pagination
              pageIndex={state.pageIndex}
              pageSize={state.pageSize}
              total={state.total}
              loading={state.loading}
              onGoto={gotoPage}
              onChangePageSize={changePageSize}
            />
            {showExport ? (
              <div className="flex items-center gap-1 border-l border-border pl-2 text-[11px]">
                <Download className="h-3 w-3 text-muted-foreground" />
                <ExportBtn
                  label="CSV"
                  title="导出 CSV（全量）"
                  disabled={!!exporting}
                  loading={exporting === "csv"}
                  onClick={() => exportAllRows("csv")}
                />
                <ExportBtn
                  label="Excel"
                  title="导出 Excel（全量）"
                  disabled={!!exporting}
                  loading={exporting === "excel"}
                  onClick={() => exportAllRows("excel")}
                />
                <ExportBtn
                  label="JSON"
                  title="导出 JSON（全量）"
                  disabled={!!exporting}
                  loading={exporting === "json"}
                  onClick={() => exportAllRows("json")}
                />
              </div>
            ) : null}
          </div>
        ) : null}
        {runState === "error" && errorMessage && onAiFix ? (
          <button
            type="button"
            className="stela-cb__result-fix"
            onClick={onAiFix}
            title={t("ai.runsql.fixTitle")}
          >
            <Sparkles className="h-3 w-3" aria-hidden="true" />
            <span>{t("ai.runsql.fix")}</span>
          </button>
        ) : null}
        <span
          className={cn("stela-cb__result-summary", summary.tone)}
          style={{
            marginLeft:
              runState === "error" && errorMessage && onAiFix ? undefined : "auto",
          }}
        >
          {summary.icon}
          {inCompare ? renderDiffSummaryText(diffState, t) : summary.text}
        </span>
      </div>
      {expanded ? (
        <div className="stela-cb__result-panel">
          <div className="stela-cb__result-body">
            {inCompare ? (
              renderDiffBody(diffState)
            ) : runState === "error" && errorMessage ? (
              <ErrorBox message={errorMessage} />
            ) : !effectiveRunId ? (
              <Hint>尚未执行。点击 Run 触发查询。</Hint>
            ) : state === null ? (
              <Hint>初始化…</Hint>
            ) : state.error ? (
              <ErrorBox message={state.error} />
            ) : state.schema === null ? (
              <Hint>加载结果…</Hint>
            ) : state.total === 0 &&
              !viewingHistory &&
              detail?.firstRow &&
              detail.resultRefId === effectiveRunId ? (
              renderDetailFallback(detail, state.schema, t)
            ) : state.schema.length === 0 ? (
              <Hint>这次执行没有返回结果集（可能是 mutation）。</Hint>
            ) : (
              <ResultTable
                columns={state.schema}
                rows={state.rows}
                rowOffset={state.pageIndex * state.pageSize}
              />
            )}
          </div>
          {showRunTabs ? (
            <RunTabs
              tabs={tabItems}
              mode={viewState.mode}
              activeRunId={viewState.activeRunId}
              latestRunId={runId}
              selectedRunIds={selectedRunIds}
              canCompare={canCompare}
              maxVisible={RUN_TABS_MAX_VISIBLE}
              onToggleCompare={toggleCompare}
              onSelectBrowse={selectBrowse}
              onToggleSelect={toggleCompareSelect}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function renderDiffSummaryText(
  diffState: DiffState | null,
  t: ReturnType<typeof useT>,
): string {
  if (!diffState) return t("blockResult.diffSummary.select");
  if (diffState.loading) return t("blockResult.diffSummary.loading");
  if (diffState.error) return diffState.error;
  if (!diffState.diff) return t("blockResult.diffSummary.select");
  const { added, removed, changed } = diffState.diff.stats;
  const parts = [
    t("blockResult.diffSummary.added", { count: added }),
    t("blockResult.diffSummary.removed", { count: removed }),
    t("blockResult.diffSummary.changed", { count: changed }),
  ];
  if (diffState.truncated) {
    parts.push(t("blockResult.diffSummary.truncated", { count: DIFF_ROW_CAP }));
  }
  if (!diffState.diff.schemaMatch) {
    parts.push(t("blockResult.diffSummary.schemaMismatch"));
  }
  return parts.join(" · ");
}

function renderDiffBody(diffState: DiffState | null) {
  if (
    !diffState ||
    (!diffState.diff && !diffState.loading && !diffState.error)
  ) {
    return <Hint>选择基线与当前两次执行以查看差异。</Hint>;
  }
  if (diffState.error) return <ErrorBox message={diffState.error} />;
  if (diffState.loading) return <Hint>比对中…</Hint>;
  if (!diffState.diff) return <Hint>选择基线与当前两次执行以查看差异。</Hint>;
  return <ResultDiffTable diff={diffState.diff} />;
}

interface KeyColumnSelectProps {
  keyColumns: string[] | null;
  diff: ResultDiff;
  onChange: (cols: string[] | null) => void;
}

/** 比对模式下的行匹配 key 列选择器（顶栏）。 */
function KeyColumnSelect({ keyColumns, diff, onChange }: KeyColumnSelectProps) {
  const keyOptions: MiniSelectOption[] = [
    { value: "", label: "Key：自动", labelText: "Key：自动" },
    ...diff.rightColumns.map((c) => ({
      value: c.name,
      label: `Key：${c.name}`,
      labelText: `Key：${c.name}`,
    })),
  ];
  return (
    <MiniSelect
      value={keyColumns?.[0] ?? ""}
      options={keyOptions}
      onChange={(v) => onChange(v ? [v] : null)}
      size="sm"
      title="行匹配 key 列"
    />
  );
}

interface ExportBtnProps {
  label: string;
  title: string;
  disabled?: boolean;
  loading?: boolean;
  onClick: () => void;
}

function ExportBtn({
  label,
  title,
  disabled,
  loading,
  onClick,
}: ExportBtnProps) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex h-5 items-center rounded border border-border bg-background px-1.5",
        "text-[11px] text-muted-foreground transition-colors",
        "hover:enabled:bg-accent hover:enabled:text-foreground",
        "disabled:cursor-not-allowed disabled:opacity-50",
      )}
    >
      {loading ? "导出中…" : label}
    </button>
  );
}

interface PaginationProps {
  pageIndex: number;
  pageSize: number;
  total: number;
  loading: boolean;
  onGoto: (idx: number) => void;
  onChangePageSize: (size: number) => void;
}

function Pagination({
  pageIndex,
  pageSize,
  total,
  loading,
  onGoto,
  onChangePageSize,
}: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const atFirst = pageIndex <= 0;
  const atLast = pageIndex >= totalPages - 1;

  return (
    <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
      <PagerBtn
        disabled={atFirst || loading}
        onClick={() => onGoto(0)}
        title="第一页"
      >
        <ChevronsLeft className="h-3 w-3" />
      </PagerBtn>
      <PagerBtn
        disabled={atFirst || loading}
        onClick={() => onGoto(pageIndex - 1)}
        title="上一页"
      >
        <ChevronLeft className="h-3 w-3" />
      </PagerBtn>
      <span className="px-1 tabular-nums text-foreground/80">
        {pageIndex + 1} / {totalPages}
      </span>
      <PagerBtn
        disabled={atLast || loading}
        onClick={() => onGoto(pageIndex + 1)}
        title="下一页"
      >
        <ChevronRight className="h-3 w-3" />
      </PagerBtn>
      <PagerBtn
        disabled={atLast || loading}
        onClick={() => onGoto(totalPages - 1)}
        title="最后一页"
      >
        <ChevronsRight className="h-3 w-3" />
      </PagerBtn>
      <MiniSelect<string>
        value={String(pageSize)}
        onChange={(v) => onChangePageSize(Number(v))}
        options={PAGE_SIZES.map((n) => ({
          value: String(n),
          label: `${n}/页`,
          labelText: `${n}/页`,
        }))}
        disabled={loading}
        size="sm"
        className="ml-1 tabular-nums"
        title="每页行数"
      />
    </div>
  );
}

interface PagerBtnProps {
  disabled?: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}

function PagerBtn({ disabled, onClick, title, children }: PagerBtnProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "inline-flex h-5 w-5 items-center justify-center rounded border border-border bg-background text-muted-foreground transition-colors",
        "hover:enabled:bg-accent hover:enabled:text-foreground",
        "disabled:cursor-not-allowed disabled:opacity-40",
      )}
    >
      {children}
    </button>
  );
}

interface SummaryArgs {
  runState: BlockResultRunState;
  detail: DetailMeta | null;
  runId: string | null;
  state: FetchedState | null;
  failedLabel?: string;
  /** 浏览历史 run 时传入对应 RunRecord；非 null 即在摘要前加「历史 ·」前缀 */
  activeRun?: RunRecord | null;
}

function formatRunDate(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function renderSummary({
  runState,
  detail,
  runId,
  state,
  failedLabel,
  activeRun,
}: SummaryArgs): { text: string; tone: string; icon: React.ReactNode } {
  if (runState === "running") {
    return { text: "执行中…", tone: "is-running", icon: null };
  }
  if (runState === "error") {
    return {
      text: failedLabel ?? "执行失败",
      tone: "is-error",
      icon: <AlertCircle className="h-3 w-3" />,
    };
  }
  if (!runId) {
    return { text: "尚未执行", tone: "is-empty", icon: null };
  }
  const parts: string[] = [];
  // 浏览历史 run：摘要来自该 run 自身记录，加「历史 ·」前缀
  if (activeRun) {
    parts.push("历史");
    parts.push(formatRunDate(activeRun.startedAt));
    parts.push(`${activeRun.elapsedMs}ms`);
    if (state && state.schema !== null) {
      parts.push(`${state.total} rows`);
      parts.push(`${state.schema.length} cols`);
    } else {
      parts.push(`${activeRun.rowCount} rows`);
    }
    return { text: parts.join(" · "), tone: "is-ok", icon: null };
  }
  if (detail?.runDate) parts.push(detail.runDate);
  if (detail?.elapsed) parts.push(detail.elapsed);
  if (state && state.schema !== null) {
    parts.push(`${state.total} rows`);
    parts.push(`${state.schema.length} cols`);
  } else if (detail) {
    parts.push(`${detail.rowCount} rows`);
  }
  return {
    text: parts.join(" · ") || `run ${runId.slice(0, 8)}`,
    tone: "is-ok",
    icon: null,
  };
}

function Hint({ children }: { children: React.ReactNode }) {
  return <div className="stela-cb__result-hint">{children}</div>;
}

/**
 * 本机缓存 + 同步日志均无该 run 的明细，但笔记 detail 里保留了一行 firstRow 时
 * 的兜底渲染。常见触发：
 *   - 历史数据：在 v2 启用 JSONL 之前跑过、之后本机 SQLite 被清/换机
 *   - 截断 run：JSON.stringify(rows) > 1MB 写侧主动跳过 saveRows + JSONL
 *
 * 渲染策略：用 schema 的列序对齐 firstRow（保持表头一致）；schema 为空（典型
 * mutation 场景，比如 affected_rows）时回退到按 firstRow 的 key 排序生成列。
 */
function renderDetailFallback(
  detail: DetailMeta,
  schema: ColumnDef[],
  t: ReturnType<typeof useT>,
): React.ReactElement {
  const firstRow = detail.firstRow ?? {};
  const columns: ColumnDef[] =
    schema.length > 0
      ? schema
      : Object.keys(firstRow).map((name) => ({ name, typeName: "" }));
  const row: unknown[] = columns.map((c) => firstRow[c.name] ?? null);
  return (
    <>
      <Hint>
        {detail.rowCount > 1
          ? t("blockResult.detailFallback.multiple", { count: detail.rowCount })
          : t("blockResult.detailFallback.single")}
      </Hint>
      <ResultTable columns={columns} rows={[row]} rowOffset={0} />
    </>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="stela-cb__result-error">
      <AlertCircle className="h-3.5 w-3.5 flex-none" />
      <span className="whitespace-pre-wrap break-all">{message}</span>
    </div>
  );
}

function errMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(err);
}

/** 拉取 diff 一侧：schema + 前 DIFF_ROW_CAP 行。rowCount 用于本地缺数据时的远端恢复判断。 */
async function loadDiffSide(
  runId: string,
  rowCount: number | null,
): Promise<{ columns: ColumnDef[]; rows: unknown[][]; truncated: boolean }> {
  const res = await loadResultPage(
    {
      runId,
      detailRowCount: rowCount,
      pageIndex: 0,
      pageSize: DIFF_ROW_CAP,
    },
    {
      storage: {
        getSchema: electronStorage.getSchema,
        queryPage: electronStorage.queryPage,
      },
      journal: {
        importRun: (id) => window.stela.journal.importRun(id),
      },
    },
  );
  return {
    columns: res.schema ?? [],
    rows: res.rows,
    truncated: res.total > DIFF_ROW_CAP,
  };
}
