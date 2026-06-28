/**
 * Settings tab 公用的小组件：Section / Row / FormHint。
 *
 * 把样式收敛到这里，避免每个 tab 重复一遍 Tailwind 类，便于未来主题统一调整。
 */

import { cn } from "@/lib/utils";

export function TabContainer({ children }: { children: React.ReactNode }) {
  return <div className="px-6 py-5">{children}</div>;
}

export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-6">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {description ? (
        <p className="mt-0.5 text-[11px] text-muted-foreground">{description}</p>
      ) : null}
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

export function Row({
  label,
  description,
  children,
  disabled,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-4 rounded-md border border-border/60 bg-card/40 px-3 py-2.5",
        disabled && "opacity-60",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-foreground">{label}</div>
        {description ? (
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {description}
          </div>
        ) : null}
      </div>
      <div className="flex-none">{children}</div>
    </div>
  );
}

export function FormHint({ children }: { children: React.ReactNode }) {
  return <p className="mt-1 text-[10px] text-muted-foreground">{children}</p>;
}

/**
 * 通用 ON/OFF 开关（shadcn-style switch）。
 *
 * 设计要点：
 *   - 用 `inline-flex items-center` + thumb `translate-x`，不再用 absolute 定位
 *   - 尺寸 h-6 / w-11 / thumb h-5：比之前的 h-5/w-9 略大，视觉上更明显是个 switch
 *     而不是普通按钮（settings 中开关偏小时容易被误认为蓝色色块）
 *   - thumb 用纯白 + shadow-sm + ring border，OFF 状态在浅灰背景上也清晰可见
 *   - OFF 状态背景用 `bg-input`（globals.css 定义，亮 220 13% 91% / 暗 222 15% 22%）
 */
export function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => {
        if (!disabled) onChange(!checked);
      }}
      className={cn(
        "inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        checked ? "bg-primary" : "bg-input",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none block h-5 w-5 rounded-full bg-white shadow ring-1 ring-black/5 transition-transform",
          checked ? "translate-x-5" : "translate-x-0",
        )}
      />
    </button>
  );
}
