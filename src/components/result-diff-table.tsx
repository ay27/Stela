/**
 * 行级 Diff 表格：渲染 computeResultDiff 的结果。
 *
 * 两种布局：
 *   - 单行监控：只有 1 个 matched 行且无增删 → 转置成 `列 | 基线 | 当前 | 状态`，
 *     一眼看出每列从旧值变到新值（典型：聚合 count 监控 SQL）。
 *   - 多行：行级 diff —— 新增行绿底、删除行红底删除线、matched 行内变更单元格黄底
 *     并以 `旧 → 新` 形式展示。
 */

import type { CellDiffStatus, DiffColumn, ResultDiff } from "@/services/result-diff";
import { cellValue } from "@/services/result-diff";
import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";

const COLUMN_WIDTH = 160;
const ROW_NUMBER_WIDTH = 56;

function fmt(value: unknown, nullLabel: string): { text: string; muted: boolean } {
  if (value === null || value === undefined) {
    return { text: nullLabel, muted: true };
  }
  if (typeof value === "object") {
    try {
      return { text: JSON.stringify(value), muted: false };
    } catch {
      return { text: String(value), muted: false };
    }
  }
  return { text: String(value), muted: false };
}

const CELL_TONE: Record<CellDiffStatus, string> = {
  same: "",
  changed: "bg-amber-200/40 dark:bg-amber-500/20",
  added: "bg-emerald-200/40 dark:bg-emerald-500/20",
  removed: "bg-rose-200/40 dark:bg-rose-500/20",
};

export interface ResultDiffTableProps {
  diff: ResultDiff;
}

export function ResultDiffTable({ diff }: ResultDiffTableProps) {
  const t = useT();
  if (diff.columns.length === 0) {
    return (
      <div className="py-3 text-center text-xs italic text-muted-foreground">
        {t("resultDiff.noColumns")}
      </div>
    );
  }

  const singleRow =
    diff.rows.length === 1 &&
    diff.rows[0].kind === "matched" &&
    diff.stats.added === 0 &&
    diff.stats.removed === 0;

  return (
    <div className="w-full overflow-x-auto bg-background font-mono text-xs">
      {singleRow
        ? renderTransposed(diff, t)
        : renderRowLevel(diff, t)}
    </div>
  );
}

function cellStatusLabel(
  status: CellDiffStatus,
  t: ReturnType<typeof useT>,
): string {
  if (status === "same") return "";
  if (status === "changed") return t("resultDiff.cellStatus.changed");
  if (status === "added") return t("resultDiff.cellStatus.added");
  return t("resultDiff.cellStatus.removed");
}

/** 单行监控：转置为 列 | 基线 | 当前 | 状态。 */
function renderTransposed(diff: ResultDiff, t: ReturnType<typeof useT>) {
  const nullLabel = t("resultTable.nullValue");
  const headers = [
    t("resultDiff.column"),
    t("resultDiff.baseline"),
    t("resultDiff.current"),
    t("resultDiff.status"),
  ];
  const row = diff.rows[0];
  return (
    <table className="w-max border-separate border-spacing-0">
      <thead className="bg-muted/80">
        <tr>
          {headers.map((h, i) => (
            <th
              key={h}
              className="border-b border-r border-border px-2 py-1 text-left font-medium text-foreground"
              style={{
                width: i === 0 ? COLUMN_WIDTH : COLUMN_WIDTH,
                minWidth: i === 3 ? 72 : COLUMN_WIDTH,
              }}
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {diff.columns.map((col, colIdx) => {
          const status = row.cells[colIdx];
          const left = fmt(
            cellValue(row.left, col, "left", diff.leftColumns, diff.rightColumns),
            nullLabel,
          );
          const right = fmt(
            cellValue(row.right, col, "right", diff.leftColumns, diff.rightColumns),
            nullLabel,
          );
          return (
            <tr key={col.name} className={cn(status !== "same" && CELL_TONE[status])}>
              <td className="border-b border-r border-border px-2 py-1 font-medium text-foreground">
                {col.name}
              </td>
              <td className="border-b border-r border-border px-2 py-1">
                <span className={cn(left.muted && "italic text-muted-foreground/70")}>
                  {left.text}
                </span>
              </td>
              <td className="border-b border-r border-border px-2 py-1">
                <span className={cn(right.muted && "italic text-muted-foreground/70")}>
                  {right.text}
                </span>
              </td>
              <td className="border-b border-r border-border px-2 py-1 text-muted-foreground">
                {cellStatusLabel(status, t)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** 多行：行级 diff。 */
function renderRowLevel(diff: ResultDiff, t: ReturnType<typeof useT>) {
  const nullLabel = t("resultTable.nullValue");
  const totalWidth = ROW_NUMBER_WIDTH + diff.columns.length * COLUMN_WIDTH;
  return (
    <table
      className="w-max border-separate border-spacing-0"
      style={{ minWidth: totalWidth }}
    >
      <thead className="bg-muted/80">
        <tr>
          <th
            className="sticky left-0 z-10 border-b border-r border-border bg-muted/90 px-2 py-1 text-right font-normal text-muted-foreground"
            style={{ width: ROW_NUMBER_WIDTH, minWidth: ROW_NUMBER_WIDTH }}
          >
            #
          </th>
          {diff.columns.map((col) => (
            <th
              key={col.name}
              className="border-b border-r border-border px-2 py-1 text-left font-medium text-foreground"
              style={{ width: COLUMN_WIDTH, minWidth: COLUMN_WIDTH }}
              title={
                col.inLeft && col.inRight
                  ? col.name
                  : col.inRight
                    ? t("resultDiff.columnAdded", { name: col.name })
                    : t("resultDiff.columnRemoved", { name: col.name })
              }
            >
              <span className="block truncate">{col.name}</span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {diff.rows.map((row, rowIdx) => {
          const marker =
            row.kind === "added" ? "+" : row.kind === "removed" ? "−" : rowIdx + 1;
          const rowTone =
            row.kind === "added"
              ? "bg-emerald-100/40 dark:bg-emerald-500/10"
              : row.kind === "removed"
                ? "bg-rose-100/40 dark:bg-rose-500/10"
                : "";
          return (
            <tr key={row.key} className={cn(rowTone)}>
              <td
                className="sticky left-0 border-b border-r border-border bg-background px-2 text-right text-muted-foreground"
                style={{ width: ROW_NUMBER_WIDTH, minWidth: ROW_NUMBER_WIDTH }}
              >
                {marker}
              </td>
              {diff.columns.map((col, colIdx) => (
                <DiffCell
                  key={col.name}
                  column={col}
                  status={row.cells[colIdx]}
                  kind={row.kind}
                  left={cellValue(row.left, col, "left", diff.leftColumns, diff.rightColumns)}
                  right={cellValue(row.right, col, "right", diff.leftColumns, diff.rightColumns)}
                  nullLabel={nullLabel}
                />
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

interface DiffCellProps {
  column: DiffColumn;
  status: CellDiffStatus;
  kind: "matched" | "added" | "removed";
  left: unknown;
  right: unknown;
  nullLabel: string;
}

function DiffCell({ status, kind, left, right, nullLabel }: DiffCellProps) {
  const tone = status === "same" ? "" : CELL_TONE[status];
  let content: React.ReactNode;
  if (kind === "added") {
    const r = fmt(right, nullLabel);
    content = <span className={cn(r.muted && "italic text-muted-foreground/70")}>{r.text}</span>;
  } else if (kind === "removed") {
    const l = fmt(left, nullLabel);
    content = (
      <span className={cn("line-through opacity-70", l.muted && "italic")}>{l.text}</span>
    );
  } else if (status === "changed") {
    const l = fmt(left, nullLabel);
    const r = fmt(right, nullLabel);
    content = (
      <span className="whitespace-nowrap">
        <span className="line-through opacity-60">{l.text}</span>
        <span className="mx-1 text-muted-foreground">→</span>
        <span>{r.text}</span>
      </span>
    );
  } else {
    const r = fmt(right, nullLabel);
    content = <span className={cn(r.muted && "italic text-muted-foreground/70")}>{r.text}</span>;
  }
  return (
    <td
      className={cn(
        "overflow-hidden border-b border-r border-border px-2 align-middle",
        tone,
      )}
      style={{ width: COLUMN_WIDTH, minWidth: COLUMN_WIDTH }}
    >
      <span className="block truncate">{content}</span>
    </td>
  );
}
