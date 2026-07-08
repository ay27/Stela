/**
 * 轻量模糊匹配下拉框：纯文本输入 + 悬浮候选列表，候选来自 `fuzzy.ts` 的子序列
 * 匹配（顺序命中即可，不要求连续），用于 SQL 搜索里表名 / 列名两个输入统一
 * 交互与样式（此前是丑陋且不统一的 `<select>` + `<datalist>` 拼凑）。
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { fuzzyFilter } from "@/lib/fuzzy";
import { cn } from "@/lib/utils";

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** 用户从候选里选中一项，或按 Enter 确认输入时触发 */
  onCommit: (value: string) => void;
  options: string[];
  placeholder: string;
  disabled?: boolean;
  disabledHint?: string;
  className?: string;
}

export function FuzzyCombobox({
  value,
  onChange,
  onCommit,
  options,
  placeholder,
  disabled,
  disabledHint,
  className,
}: Props) {
  const [open, setOpen] = useState(false);
  // -1 = 没有用键盘导航选中任何候选项；此时 Enter 应该原样提交输入框里的文字
  // （精确匹配），而不是偷偷替换成模糊排序第一的候选——下拉列表只是"输入提示"，
  // 不代表用户想要的就是排第一的那个（比如输入 cluster 想精确查 cluster 这一列，
  // 结果被替换成模糊得分更高但其实不相关的 part_cluster_type）。
  const [highlight, setHighlight] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    if (disabled) return [];
    return fuzzyFilter(value, options, (s) => s, 30);
  }, [value, options, disabled]);

  useEffect(() => setHighlight(-1), [value, open]);

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  return (
    <div ref={rootRef} className={cn("relative", className)} title={disabled ? disabledHint : undefined}>
      <input
        value={value}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setHighlight((i) => Math.min(i + 1, filtered.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            // 只有用户用方向键真正选中过某一项时，才用那一项；否则原样提交输入
            // 框里的文字（精确匹配），不做任何隐式的模糊替换。
            const picked = open && highlight >= 0 ? filtered[highlight] : undefined;
            const next = picked ?? value.trim();
            if (next) {
              onChange(next);
              onCommit(next);
            }
            setOpen(false);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        placeholder={placeholder}
        className={cn(
          "w-full rounded-md border border-border bg-background px-2 py-1 text-[11px]",
          "placeholder:text-muted-foreground/70 focus:border-primary focus:outline-none",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
      />
      {open && !disabled && filtered.length > 0 ? (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-md border border-border bg-popover shadow-md">
          {filtered.map((opt, i) => (
            <button
              key={opt}
              type="button"
              onMouseDown={(e) => {
                // mousedown 而非 click：避免先触发 input 的 blur 把菜单关掉
                e.preventDefault();
                onChange(opt);
                onCommit(opt);
                setOpen(false);
              }}
              onMouseEnter={() => setHighlight(i)}
              className={cn(
                "block w-full truncate px-2 py-1 text-left text-[11px]",
                i === highlight ? "bg-accent text-foreground" : "text-foreground/90 hover:bg-accent",
              )}
            >
              {opt}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
