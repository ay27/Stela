/**
 * 结果表格（分页版）。
 *
 * 设计要点：
 *   - 高度随行数自然展开，只保留横向滚动；纵向滚动交给页面外层
 *   - 列顺序严格保持查询返回顺序（不做任何 sort）；表头只显示列名，不展示类型
 *   - 每个 cell 支持 hover 出现复制按钮，点击复制完整原始文本（非截断值）
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
    return { title: "NULL", copyText: null, display: "NULL", muted: true };
  }

  if (
    typeName &&
    /^(BLOB|BINARY|VARBINARY|LONGBLOB|MEDIUMBLOB|TINYBLOB)/i.test(typeName) &&
    typeof value === "string"
  ) {
    const bytes = Math.floor((value.length * 3) / 4);
    return {
      title: `base64 ${value.length} chars`,
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
  emptyMessage = "暂无数据",
}: ResultTableProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [hoverCell, setHoverCell] = useState<{
    row: number;
    col: number;
    left: number;
    top: number;
  } | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

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
    if (!td || !wrapperRef.current) {
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
  }, [rows, columns]);

  const doCopy = useCallback(
    (key: string, text: string) => {
      writeClipboardText(text)
        .then(() => {
          setCopiedKey(key);
          window.setTimeout(() => {
            setCopiedKey((cur) => (cur === key ? null : cur));
          }, 1200);
        })
        .catch((err) => {
          console.error("[stela] copy failed", err);
        });
    },
    [],
  );

  if (columns.length === 0) {
    return (
      <div className="py-3 text-center text-xs italic text-muted-foreground">
        {emptyMessage}
      </div>
    );
  }

  const totalWidth = ROW_NUMBER_WIDTH + columns.length * COLUMN_WIDTH;

  const hoverKey = hoverCell ? `${hoverCell.row}:${hoverCell.col}` : null;
  const hoverContent =
    hoverCell && renderedRows[hoverCell.row]
      ? renderedRows[hoverCell.row][hoverCell.col] ?? null
      : null;
  const showFloatingBtn = Boolean(hoverCell && hoverContent && hoverContent.copyText !== null);
  const isCopied = hoverKey !== null && copiedKey === hoverKey;

  return (
    <div
      ref={wrapperRef}
      className="relative w-full overflow-x-auto bg-background font-mono text-xs"
      onMouseOver={handleMouseOver}
      onMouseLeave={handleMouseLeave}
    >
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
              className="hover:bg-accent/20"
              style={{ height: ROW_HEIGHT }}
            >
              <td
                className="sticky left-0 border-b border-r border-border bg-background px-2 text-right text-muted-foreground"
                style={{ width: ROW_NUMBER_WIDTH, minWidth: ROW_NUMBER_WIDTH }}
              >
                {rowOffset + rowIdx + 1}
              </td>
              {rowContents.map((content, colIdx) => (
                <td
                  key={colIdx}
                  data-row={rowIdx}
                  data-col={colIdx}
                  data-copy={content.copyText !== null ? "1" : "0"}
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
                </td>
              ))}
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
            "pointer-events-auto absolute z-20 inline-flex h-5 w-5 items-center justify-center",
            "-translate-x-full -translate-y-1/2 rounded",
            "border border-border bg-background text-muted-foreground shadow-sm",
            "hover:bg-accent hover:text-foreground",
            isCopied && "text-primary",
          )}
          style={{ left: hoverCell.left, top: hoverCell.top }}
          title={isCopied ? "已复制" : "复制到剪贴板"}
          tabIndex={-1}
        >
          {isCopied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </button>
      ) : null}
    </div>
  );
}
