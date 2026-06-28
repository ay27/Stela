/**
 * 通用下拉选择组件，封装 `@radix-ui/react-select`。
 *
 * 为什么基于 Radix：
 *   - 项目已经使用 dialog / context-menu / tabs / tooltip / scroll-area / separator / slot
 *     七个 Radix 包，"再多一个 select" 在模式内
 *   - Radix 免费提供：键盘导航（↑↓ / Home / End / 首字母 typeahead）、focus trap、
 *     focus 回归、portal 定位、aria 角色——自研版很难覆盖完整
 *
 * 样式风格对齐 `ConnectionPicker` 与 `cmdk` 弹窗：
 *   `bg-popover + border-border + shadow-lg`，触发器按钮使用 background + border
 *   而不是 shadcn 默认的 "select trigger"（避免与项目现有紧凑风格打架）
 *
 * 两种使用方式：
 *   1. 高阶 API（推荐）：`<Select options onValueChange>`，最省代码
 *   2. 底层 API：`<SelectRoot>/<SelectTrigger>/<SelectContent>/<SelectItem>`，
 *      供需要 group / separator / 自定义渲染时使用
 */

import { Check, ChevronDown } from "lucide-react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { forwardRef, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/** 底层 re-export，供自定义渲染场景使用。 */
export const SelectRoot = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

type TriggerSize = "sm" | "md";

const TRIGGER_SIZE_CLASSES: Record<TriggerSize, string> = {
  sm: "h-6 px-1.5 text-[11px]",
  md: "h-8 px-2.5 text-sm",
};

export interface SelectTriggerProps
  extends React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger> {
  size?: TriggerSize;
}

/**
 * 选择器触发按钮。默认 `md` 尺寸对齐常规表单；`sm` 用于工具条里的紧凑场景（如分页）。
 */
export const SelectTrigger = forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  SelectTriggerProps
>(({ className, size = "md", children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      "inline-flex items-center justify-between gap-1 rounded-md border border-border bg-background text-foreground transition-colors",
      "hover:border-muted-foreground/60 focus:border-primary focus:outline-none focus-visible:outline-none",
      "disabled:cursor-not-allowed disabled:opacity-50",
      "[&>span]:truncate [&>span]:text-left",
      TRIGGER_SIZE_CLASSES[size],
      className,
    )}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      <ChevronDown className="h-3 w-3 flex-none opacity-60" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = "SelectTrigger";

export interface SelectContentProps
  extends React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content> {
  /** 覆盖 Radix Portal 的容器。用于 ProseMirror NodeView 里把弹层挂到 body 而不是 PM 子树。 */
  portalContainer?: HTMLElement | null;
}

export const SelectContent = forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  SelectContentProps
>(
  (
    { className, children, position = "popper", sideOffset = 4, portalContainer, ...props },
    ref,
  ) => (
    <SelectPrimitive.Portal container={portalContainer ?? undefined}>
      <SelectPrimitive.Content
        ref={ref}
        position={position}
        sideOffset={sideOffset}
        className={cn(
          "z-50 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-lg",
          "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          "min-w-[var(--radix-select-trigger-width)]",
          position === "popper" &&
            "data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1",
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport className="p-1">
          {children}
        </SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  ),
);
SelectContent.displayName = "SelectContent";

export const SelectLabel = forwardRef<
  React.ElementRef<typeof SelectPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Label
    ref={ref}
    className={cn("px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground", className)}
    {...props}
  />
));
SelectLabel.displayName = "SelectLabel";

export const SelectItem = forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1 pr-7 text-xs text-foreground outline-none transition-colors",
      "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
      "data-[state=checked]:text-foreground",
      "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className,
    )}
    {...props}
  >
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    <span className="absolute right-1.5 top-1/2 inline-flex h-3 w-3 -translate-y-1/2 items-center justify-center">
      <SelectPrimitive.ItemIndicator>
        <Check className="h-3 w-3" />
      </SelectPrimitive.ItemIndicator>
    </span>
  </SelectPrimitive.Item>
));
SelectItem.displayName = "SelectItem";

export const SelectSeparator = forwardRef<
  React.ElementRef<typeof SelectPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Separator
    ref={ref}
    className={cn("my-1 h-px bg-border", className)}
    {...props}
  />
));
SelectSeparator.displayName = "SelectSeparator";

// ---------- 高阶 Select ----------

export interface SelectOption<V extends string = string> {
  value: V;
  label: ReactNode;
  disabled?: boolean;
  /** 用于 <SelectValue /> 展示——label 可能是 ReactNode 时，显示需要一个纯字符串 */
  labelText?: string;
}

export interface SelectProps<V extends string = string> {
  value: V;
  onValueChange: (value: V) => void;
  options: readonly SelectOption<V>[];
  placeholder?: string;
  disabled?: boolean;
  size?: TriggerSize;
  className?: string;
  contentClassName?: string;
  title?: string;
  /** 自定义触发器内的展示——返回 ReactNode 作为 children 注入到 `<SelectValue>` */
  renderValue?: (value: V, option: SelectOption<V> | undefined) => ReactNode;
  /** Radix Portal 的容器——放在 PM NodeView 里时一般传 document.body（默认即 body，这里显式透出） */
  portalContainer?: HTMLElement | null;
  /**
   * Content 关闭时的自动聚焦回调。关菜单时焦点默认回到 Trigger；在 PM NodeView 里
   * 我们用 `preventDefault()` 让焦点保持在当前 selection，避免 PM 的 focus-sticky
   * 逻辑把焦点拽回到编辑光标位置时触发页面级 scrollIntoView。
   * （Radix Select v2 未暴露 onOpenAutoFocus，开菜单时的聚焦由 Radix 内部管，
   *  我们通过 `contenteditable="false"` 标记 result-host 让 PM 不在那里查 selection）
   */
  onCloseAutoFocus?: (event: Event) => void;
}

/**
 * 高阶 Select：一行传 options + value + onChange 即可，覆盖 90% 的使用场景。
 */
export function Select<V extends string = string>({
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
  size = "md",
  className,
  contentClassName,
  title,
  renderValue,
  portalContainer,
  onCloseAutoFocus,
}: SelectProps<V>) {
  const current = options.find((o) => o.value === value);
  return (
    <SelectRoot
      value={value}
      onValueChange={(v) => onValueChange(v as V)}
      disabled={disabled}
    >
      <SelectTrigger size={size} className={className} title={title}>
        <SelectValue placeholder={placeholder}>
          {renderValue
            ? renderValue(value, current)
            : current?.labelText ?? current?.label}
        </SelectValue>
      </SelectTrigger>
      <SelectContent
        className={contentClassName}
        portalContainer={portalContainer}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        {options.map((opt) => (
          <SelectItem key={opt.value} value={opt.value} disabled={opt.disabled}>
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  );
}
