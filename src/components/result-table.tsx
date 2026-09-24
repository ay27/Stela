/**
 * 结果表格（分页版）。
 *
 * 设计要点：
 *   - 高度随行数自然展开，只保留横向滚动；纵向滚动交给页面外层
 *   - 列顺序严格保持查询返回顺序（不做任何 sort）；表头只显示列名，不展示类型
 *   - 单格选中后停留显示复制按钮；多格选区通过快捷键复制完整数据
 *
 * 性能设计（关键）：
 *   - **整张表只渲染 1 个复制按钮**：通过事件委托监听容器 mouseover/out，按钮 position:absolute
 *     定位到当前 hover 的 cell。10 列 × 30 行从「300 个 button + 300 个 Lucide SVG」
 *     降到「1 个 button + 1 个 SVG」，首次挂载与翻页都快一个量级。
 *   - cell 内只保留 `<td data-row data-col>`，不含任何 React 子组件，避免 reconcile 成本
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

import type { ColumnDef } from "@/contracts";
import { i18n } from "@/i18n";
import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";

export interface ResultTableProps {
  columns: ColumnDef[];
  rows: unknown[][];
  /** 行号起点（当前页第一行的全局索引，1-based 展示会 +1） */
  rowOffset?: number;
  emptyMessage?: string;
}

const COLUMN_WIDTH = 160;
const ROW_HEIGHT = 28;
const ROW_NUMBER_WIDTH = 56;
const COPY_FLOATING_OFFSET = 2;
const COPY_HOVER_DELAY_MS = 600;

interface CellPosition { row: number; col: number }
interface CellSelection { anchor: CellPosition; focus: CellPosition }

function cellPosition(target: EventTarget | null): CellPosition | null {
  const cell = target instanceof Element ? target.closest<HTMLElement>("td[data-row]") : null;
  return cell ? { row: Number(cell.dataset.row), col: Number(cell.dataset.col) } : null;
}

function selectionBounds(selection: CellSelection) {
  return {
    top: Math.min(selection.anchor.row, selection.focus.row),
    bottom: Math.max(selection.anchor.row, selection.focus.row),
    left: Math.min(selection.anchor.col, selection.focus.col),
    right: Math.max(selection.anchor.col, selection.focus.col),
  };
}

interface CellContent {
  /** 用于 title / hover tooltip */
  title: string;
  /** 点击复制按钮时写入剪贴板的完整文本；null 表示不显示复制按钮（如 NULL 值） */
  copyText: string | null;
  /** 真正渲染在 cell 里的字符串（DOM 里直接文本节点，不包 React 组件） */
  display: string;
  /** 是否走斜体 muted 样式（NULL / base64 占位等） */
  muted: boolean;
}

/** 把原始值转换成展示字符串 + 复制文本，纯函数。 */
function renderCellContent(value: unknown, typeName: string | undefined): CellContent {
  if (value === null || value === undefined) {
    const nullLabel = i18n.t("resultTable.nullValue");
    return { title: nullLabel, copyText: null, display: nullLabel, muted: true };
  }

  if (
    typeName &&
    /^(BLOB|BINARY|VARBINARY|LONGBLOB|MEDIUMBLOB|TINYBLOB)/i.test(typeName) &&
    typeof value === "string"
  ) {
    const bytes = Math.floor((value.length * 3) / 4);
    return {
      title: i18n.t("resultTable.base64Preview", { count: value.length }),
      copyText: value,
      display: `<base64 ${bytes} bytes>`,
      muted: true,
    };
  }

  let text: string;
  if (typeof value === "object") {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  } else {
    text = String(value);
  }

  return { title: text, copyText: text, display: text, muted: false };
}

async function writeClipboardText(text: string): Promise<void> {
  try {
    window.stela.shell.writeClipboardText(text);
  } catch (err) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    throw err;
  }
}

export function ResultTable({
  columns,
  rows,
  rowOffset = 0,
  emptyMessage,
}: ResultTableProps) {
  const t = useT();
  const resolvedEmpty = emptyMessage ?? t("resultTable.empty");
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [hoverCell, setHoverCell] = useState<{
    row: number;
    col: number;
    left: number;
    top: number;
  } | null>(null);
  const hoverKey = hoverCell ? `${hoverCell.row}:${hoverCell.col}` : null;
  const [copyHoverKey, setCopyHoverKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [selection, setSelection] = useState<CellSelection | null>(null);
  const activeCell = selection?.focus ?? null;
  const bounds = selection ? selectionBounds(selection) : null;
  const singleCellKey = bounds && bounds.top === bounds.bottom && bounds.left === bounds.right ? `${bounds.top}:${bounds.left}` : null;
  const copyCandidateKey = hoverKey === singleCellKey ? hoverKey : null;
  const rangeKey = bounds ? `range:${bounds.top}:${bounds.bottom}:${bounds.left}:${bounds.right}` : "";
  const [dragging, setDragging] = useState(false);
  const pointer = useRef<{ id: number; x: number; y: number } | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyRequest = useRef(0);

  useEffect(() => {
    setCopyHoverKey(null);
    if (!copyCandidateKey || dragging) return;
    const timer = setTimeout(() => setCopyHoverKey(copyCandidateKey), COPY_HOVER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [copyCandidateKey, dragging, rows, columns, rowOffset]);

  // 预先把每个 cell 的文本构造为二维数组，避免每次渲染都做 JSON.stringify
  const renderedRows = useMemo(
    () =>
      rows.map((rowValues) =>
        rowValues.map((value, colIdx) => renderCellContent(value, columns[colIdx]?.typeName)),
      ),
    [rows, columns],
  );

  const updateHoverFromTarget = useCallback((target: EventTarget | null) => {
    if (!(target instanceof Element)) return;
    // 关键修复：浮动按钮是 <td> 的兄弟节点（通过 position:absolute 视觉上盖在 cell
    // 右边缘），光标移到按钮上时 closest("td[data-row]") 会返回 null —— 如果此时
    // setHoverCell(null) 就会把按钮卸载，光标又回到 td 上 → 按钮又出现，循环闪烁，
    // 连带 click 都打不稳。检测到目标在按钮上就维持当前 hover 不动。
    if (target.closest("[data-stela-copy-btn]")) return;
    const td = target.closest<HTMLTableCellElement>("td[data-row]");
    if (!td || !wrapperRef.current?.contains(td)) {
      setHoverCell(null);
      return;
    }
    const rowStr = td.getAttribute("data-row");
    const colStr = td.getAttribute("data-col");
    const hasCopy = td.getAttribute("data-copy") === "1";
    if (!hasCopy || rowStr === null || colStr === null) {
      setHoverCell(null);
      return;
    }
    const rect = td.getBoundingClientRect();
    const containerRect = wrapperRef.current.getBoundingClientRect();
    setHoverCell({
      row: Number(rowStr),
      col: Number(colStr),
      // 相对容器（容器里有横向滚动），所以要加上 scrollLeft
      left: rect.right - containerRect.left + wrapperRef.current.scrollLeft - COPY_FLOATING_OFFSET,
      top: rect.top - containerRect.top + wrapperRef.current.scrollTop + rect.height / 2,
    });
  }, []);

  const handleMouseOver = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (pointer.current) return;
      updateHoverFromTarget(e.target);
    },
    [updateHoverFromTarget],
  );

  const handleMouseLeave = useCallback(() => {
    setHoverCell(null);
  }, []);

  // 翻页 / 数据变化时，清掉旧的 hover 状态（避免按钮停在错位置）
  useEffect(() => {
    setHoverCell(null);
    setSelection(null);
    setDragging(false);
    const captured = pointer.current;
    if (captured && wrapperRef.current?.hasPointerCapture(captured.id)) wrapperRef.current.releasePointerCapture(captured.id);
    pointer.current = null;
    setCopiedKey(null);
    setCopyFailed(false);
    return () => {
      copyRequest.current++;
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, [rows, columns, rowOffset]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!dragging || !wrapper) return;
    let scrollParent = wrapper.parentElement;
    while (scrollParent && !/(auto|scroll)/.test(getComputedStyle(scrollParent).overflowY)) scrollParent = scrollParent.parentElement;
    let frame = 0;
    const extend = () => {
      const point = pointer.current;
      if (!point) return;
      const rect = wrapper.getBoundingClientRect();
      const outer = scrollParent?.getBoundingClientRect();
      const top = Math.max(rect.top, outer?.top ?? 0, 0);
      const bottom = Math.min(rect.bottom, outer?.bottom ?? innerHeight, innerHeight);
      if (point.x > rect.right - 20) wrapper.scrollLeft += 10;
      else if (point.x < rect.left + ROW_NUMBER_WIDTH + 20) wrapper.scrollLeft -= 10;
      if (scrollParent) {
        if (point.y > bottom - 20) scrollParent.scrollTop += 10;
        else if (point.y < top + 20) scrollParent.scrollTop -= 10;
      }
      const body = wrapper.querySelector("tbody")?.getBoundingClientRect();
      const x = Math.max(rect.left + ROW_NUMBER_WIDTH + 1, Math.min(rect.right - 1, point.x));
      const y = Math.max(top + 1, body?.top ?? top, Math.min(bottom - 1, point.y));
      const target = document.elementFromPoint(x, y);
      const next = target && wrapper.contains(target) ? cellPosition(target) : null;
      if (next) setSelection(current => current && (current.focus.row !== next.row || current.focus.col !== next.col) ? { ...current, focus: next } : current);
      frame = requestAnimationFrame(extend);
    };
    frame = requestAnimationFrame(extend);
    return () => cancelAnimationFrame(frame);
  }, [dragging]);

  const doCopy = useCallback(
    (key: string, text: string) => {
      const request = ++copyRequest.current;
      if (copyTimer.current) clearTimeout(copyTimer.current);
      setCopyFailed(false);
      writeClipboardText(text)
        .then(() => {
          if (request !== copyRequest.current) return;
          setCopiedKey(key);
          copyTimer.current = setTimeout(() => setCopiedKey(null), 1600);
        })
        .catch((err) => {
          if (request !== copyRequest.current) return;
          setCopiedKey(null);
          setCopyFailed(true);
          copyTimer.current = setTimeout(() => setCopyFailed(false), 2400);
          console.error("[stela] copy failed", err);
        });
    },
    [],
  );

  if (columns.length === 0) {
    return (
      <div className="py-3 text-center text-xs italic text-muted-foreground">
        {resolvedEmpty}
      </div>
    );
  }

  const totalWidth = ROW_NUMBER_WIDTH + columns.length * COLUMN_WIDTH;

  const hoverContent =
    hoverCell && renderedRows[hoverCell.row]
      ? renderedRows[hoverCell.row][hoverCell.col] ?? null
      : null;
  const showFloatingBtn = !dragging && copyCandidateKey !== null && copyHoverKey === copyCandidateKey && Boolean(hoverCell && hoverContent && hoverContent.copyText !== null);
  const isCopied = hoverKey !== null && copiedKey === hoverKey;

  return (
    <div
      ref={wrapperRef}
      className="stela-result-table stela-result-scroll relative w-full overflow-x-auto bg-background font-mono text-xs"
      tabIndex={0}
      role="region"
      aria-label={t("resultTable.keyboardHint")}
      onMouseOver={handleMouseOver}
      onMouseLeave={handleMouseLeave}
      onScroll={() => setHoverCell(null)}
      onPointerDown={(event) => {
        if (event.button !== 0 || event.pointerType === "touch") return;
        const cell = cellPosition(event.target);
        if (!cell) return;
        event.preventDefault();
        window.getSelection()?.removeAllRanges();
        event.currentTarget.focus({ preventScroll: true });
        setCopiedKey(null);
        setSelection(current => ({ anchor: event.shiftKey && current ? current.anchor : cell, focus: cell }));
        pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
        event.currentTarget.setPointerCapture(event.pointerId);
        setHoverCell(null);
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (pointer.current?.id !== event.pointerId) return;
        pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
        const target = document.elementFromPoint(event.clientX, event.clientY);
        const next = target && event.currentTarget.contains(target) ? cellPosition(target) : null;
        if (next) setSelection(current => current && (current.focus.row !== next.row || current.focus.col !== next.col) ? { ...current, focus: next } : current);
      }}
      onPointerUp={(event) => {
        if (pointer.current?.id !== event.pointerId) return;
        pointer.current = null;
        setDragging(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        updateHoverFromTarget(document.elementFromPoint(event.clientX, event.clientY));
      }}
      onLostPointerCapture={() => { pointer.current = null; setDragging(false); }}
      onPointerCancel={() => { pointer.current = null; setDragging(false); }}
      onClick={(event) => {
        // Physical mouse clicks are handled on pointerdown, so the final click
        // of a drag cannot collapse its range. Keep accessibility/programmatic clicks.
        if (event.detail !== 0 && !(event.nativeEvent instanceof PointerEvent && event.nativeEvent.pointerType === "touch")) return;
        const cell = cellPosition(event.target);
        if (!cell) return;
        setSelection({ anchor: cell, focus: cell });
        updateHoverFromTarget(event.target);
        event.currentTarget.focus({ preventScroll: true });
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || !rows.length) return;
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c" && activeCell) {
          const content = renderedRows[activeCell.row]?.[activeCell.col];
          if (bounds && (bounds.top !== bounds.bottom || bounds.left !== bounds.right)) {
            event.preventDefault();
            // TSV preserves row/column structure; quote embedded tabs/newlines.
            const text = renderedRows.slice(bounds.top, bounds.bottom + 1).map(row => row.slice(bounds.left, bounds.right + 1).map(cell => {
              const value = cell.copyText ?? "";
              return /[\t\n\r"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
            }).join("\t")).join("\n");
            doCopy(rangeKey, text);
            return;
          }
          if (content?.copyText != null) {
            event.preventDefault();
            doCopy(`${activeCell.row}:${activeCell.col}`, content.copyText);
          }
          return;
        }
        if (event.key === "Escape") {
          const captured = pointer.current;
          pointer.current = null;
          if (captured && event.currentTarget.hasPointerCapture(captured.id)) event.currentTarget.releasePointerCapture(captured.id);
          setSelection(null);
          setDragging(false);
          return;
        }
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
        event.preventDefault();
        const next = activeCell ? {
          row: Math.max(0, Math.min(rows.length - 1, activeCell.row + (event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0))),
          col: Math.max(0, Math.min(columns.length - 1, activeCell.col + (event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0))),
        } : { row: 0, col: 0 };
        setSelection(current => ({ anchor: event.shiftKey && current ? current.anchor : next, focus: next }));
        event.currentTarget.querySelector<HTMLElement>(`td[data-row="${next.row}"][data-col="${next.col}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
      }}
    >
      <table
        className="w-max border-separate border-spacing-0"
        style={{ minWidth: totalWidth }}
      >
        <thead>
          <tr>
            <th
              className="sticky left-0 z-10 border-b border-r border-border bg-muted/90 px-2 py-1 text-right font-normal text-muted-foreground"
              style={{ width: ROW_NUMBER_WIDTH, minWidth: ROW_NUMBER_WIDTH }}
            >
              #
            </th>
            {columns.map((col, colIdx) => (
              <th
                key={`${col.name}__${colIdx}`}
                className="border-b border-r border-border px-2 py-1 text-left align-middle font-medium text-foreground"
                style={{ width: COLUMN_WIDTH, minWidth: COLUMN_WIDTH }}
                title={col.typeName ? `${col.name} : ${col.typeName}` : col.name}
              >
                <span className="block truncate">{col.name}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {renderedRows.map((rowContents, rowIdx) => (
            <tr
              key={rowIdx}
              style={{ height: ROW_HEIGHT }}
            >
              <td
                className="sticky left-0 border-b border-r border-border bg-background px-2 text-right text-muted-foreground"
                style={{ width: ROW_NUMBER_WIDTH, minWidth: ROW_NUMBER_WIDTH }}
              >
                {rowOffset + rowIdx + 1}
              </td>
              {rowContents.map((content, colIdx) => {
                const selected = Boolean(bounds && rowIdx >= bounds.top && rowIdx <= bounds.bottom && colIdx >= bounds.left && colIdx <= bounds.right);
                return <td
                  key={colIdx}
                  data-row={rowIdx}
                  data-col={colIdx}
                  data-copy={content.copyText !== null ? "1" : "0"}
                  data-active={activeCell?.row === rowIdx && activeCell.col === colIdx || undefined}
                  data-selected={selected || undefined}
                  data-copied={copiedKey === `${rowIdx}:${colIdx}` || selected && copiedKey === rangeKey || undefined}
                  className="overflow-hidden border-b border-r border-border px-2 align-middle"
                  style={{ width: COLUMN_WIDTH, minWidth: COLUMN_WIDTH }}
                  title={content.title}
                >
                  <span
                    className={cn(
                      "block truncate",
                      content.muted && "italic text-muted-foreground/70",
                    )}
                  >
                    {content.display}
                  </span>
                </td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {/* 整张表唯一一个浮动复制按钮。data-stela-copy-btn 标记用于 hover 循环判断：
          光标移到按钮上时 updateHoverFromTarget 会识别出，维持当前 hover 不变，
          按钮不会被卸载/重挂，点击能稳定落到 onClick 上。 */}
      {showFloatingBtn && hoverCell && hoverContent ? (
        <button
          type="button"
          data-stela-copy-btn="1"
          onClick={(e) => {
            e.stopPropagation();
            if (hoverContent.copyText !== null) {
              doCopy(`${hoverCell.row}:${hoverCell.col}`, hoverContent.copyText);
            }
          }}
          className={cn(
            "stela-result-copy pointer-events-auto absolute z-20 inline-flex h-5 min-w-5 items-center justify-center gap-1 px-1",
            "-translate-x-full -translate-y-1/2 rounded-md",
            "border border-border bg-background text-muted-foreground shadow-sm",
            "hover:bg-accent hover:text-foreground",
          )}
          data-copied={isCopied || undefined}
          style={{ left: hoverCell.left, top: hoverCell.top }}
          title={isCopied ? t("common.copied") : t("common.copy")}
          aria-label={isCopied ? t("common.copied") : t("common.copy")}
          tabIndex={-1}
        >
          {isCopied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {isCopied ? <span className="font-sans text-[10px]">{t("common.copied")}</span> : null}
        </button>
      ) : null}
      <span role="status" aria-live="polite" className={copyFailed ? "sticky bottom-0 left-0 block bg-background px-2 py-1 font-sans text-xs text-destructive" : "sr-only left-0 top-0"}>
        {copyFailed ? t("resultTable.copyFailed") : copiedKey ? t("common.copied") : ""}
      </span>
    </div>
  );
}
