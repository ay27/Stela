/**
 * MiniSelect —— 不依赖 Radix 的极简下拉组件。
 *
 * 为什么单独造一个：分页下拉被内嵌在 runsql 的 result-host 里，属于 ProseMirror
 * 的 NodeView 子树。Radix Select 的开关依赖：
 *   1. Trigger 按钮成功获得焦点（pointer-down 开 menu）
 *   2. Content Portal 后还能保持在 Trigger 附近（floating-ui）
 *   3. react-remove-scroll 锁 body
 *
 * 这三件事和 PM 的 `selectionchange` → `setSelection` → `cm.focus()` →
 * `scrollCursorIntoView` 链条冲突严重，各种蜜汁补丁都只能救一部分场景。
 * 既然我们只需要"一个 4 项的超短下拉"，直接用原生按钮 + createPortal 手写一个：
 *   - Trigger 在 `onPointerDown` 里 `preventDefault()`——彻底阻止浏览器在
 *     contenteditable 根上移动原生 caret，PM 自然不会同步选区、不会抢焦点；
 *   - Panel `createPortal` 到 `document.body`，`position: fixed` 定位在 Trigger
 *     下方（下方空间不足就翻到上方），不走 floating-ui；
 *   - 点 panel 外 / 滚动 / resize / Esc 一律关闭，不做 focus trap、不锁 body、
 *     不抢焦点。
 */

import { Check, ChevronDown } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

export interface MiniSelectOption<V extends string = string> {
  value: V;
  label: ReactNode;
  /** 用于 Trigger 里展示的纯文本版本（label 可能是 ReactNode） */
  labelText?: string;
  disabled?: boolean;
}

export interface MiniSelectProps<V extends string = string> {
  value: V;
  options: readonly MiniSelectOption<V>[];
  onChange: (value: V) => void;
  disabled?: boolean;
  size?: "sm" | "md";
  className?: string;
  title?: string;
  /** 占位文本，当 value 匹配不到任何 option 时展示 */
  placeholder?: string;
}

const TRIGGER_SIZE_CLASSES: Record<"sm" | "md", string> = {
  sm: "h-6 px-1.5 text-[11px]",
  md: "h-8 px-2.5 text-sm",
};

interface PanelPos {
  top: number;
  left: number;
  minWidth: number;
  placement: "top" | "bottom";
}

export function MiniSelect<V extends string = string>({
  value,
  options,
  onChange,
  disabled,
  size = "md",
  className,
  title,
  placeholder,
}: MiniSelectProps<V>) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<PanelPos>({
    top: 0,
    left: 0,
    minWidth: 0,
    placement: "bottom",
  });

  const current = options.find((o) => o.value === value);

  const recomputePos = useCallback(() => {
    const btn = triggerRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    // 估算 panel 高度：每项 28px + padding 8px，封顶 240px（再多走自身滚动条）
    const estPanelHeight = Math.min(240, options.length * 28 + 8);
    const spaceBelow = window.innerHeight - rect.bottom;
    const placement: "top" | "bottom" =
      spaceBelow < estPanelHeight + 12 && rect.top > estPanelHeight + 12
        ? "top"
        : "bottom";
    setPos({
      top: placement === "bottom" ? rect.bottom + 4 : rect.top - 4,
      left: rect.left,
      minWidth: rect.width,
      placement,
    });
  }, [options.length]);

  useLayoutEffect(() => {
    if (open) recomputePos();
  }, [open, recomputePos]);

  useEffect(() => {
    if (!open) return;

    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (triggerRef.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    // 页面滚动或窗口变化时直接关掉——跟踪 Trigger 位置的复杂度不值得。
    const onScroll = () => setOpen(false);
    const onResize = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        e.stopPropagation();
      }
    };

    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const triggerLabel = current?.labelText ?? current?.label ?? placeholder ?? "";

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        // preventDefault pointer-down：彻底不让浏览器在 contenteditable 根上移动
        // caret，从源头上避免 PM selectionchange → setSelection → cm.focus 链条。
        onPointerDown={(e) => {
          e.preventDefault();
        }}
        onClick={() => {
          if (disabled) return;
          setOpen((o) => !o);
        }}
        className={cn(
          "inline-flex items-center justify-between gap-1 rounded-md border border-border bg-background text-foreground transition-colors",
          "hover:border-muted-foreground/60 focus:outline-none focus-visible:outline-none",
          "disabled:cursor-not-allowed disabled:opacity-50",
          TRIGGER_SIZE_CLASSES[size],
          className,
        )}
      >
        <span className="truncate text-left">{triggerLabel}</span>
        <ChevronDown className="h-3 w-3 flex-none opacity-60" />
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={panelRef}
              role="listbox"
              style={{
                position: "fixed",
                top:
                  pos.placement === "bottom" ? `${pos.top}px` : undefined,
                bottom:
                  pos.placement === "top"
                    ? `${window.innerHeight - pos.top}px`
                    : undefined,
                left: `${pos.left}px`,
                minWidth: `${pos.minWidth}px`,
                maxHeight: "240px",
                overflowY: "auto",
                zIndex: 50,
              }}
              className="rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
            >
              {options.map((opt) => {
                const selected = opt.value === value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    disabled={opt.disabled}
                    onPointerDown={(e) => e.preventDefault()}
                    onClick={() => {
                      if (opt.disabled) return;
                      onChange(opt.value);
                      setOpen(false);
                    }}
                    className={cn(
                      "relative flex w-full cursor-pointer select-none items-center rounded-sm px-2 py-1 pr-7 text-left text-xs text-foreground outline-none transition-colors",
                      "hover:bg-accent hover:text-accent-foreground",
                      "disabled:pointer-events-none disabled:opacity-50",
                      selected && "bg-accent/60",
                    )}
                  >
                    <span className="truncate">{opt.label}</span>
                    {selected ? (
                      <span className="absolute right-1.5 top-1/2 inline-flex h-3 w-3 -translate-y-1/2 items-center justify-center">
                        <Check className="h-3 w-3" />
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
