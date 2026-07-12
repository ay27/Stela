/**
 * 顶栏连接切换器。
 *
 * 当前文档连接选择器：
 *   - 未配置：pill 显示 "○ 未选择连接"，点击弹列表
 *   - 已配置但连接不存在：橙色警告状态
 *   - 已配置且存在：蓝点 + 连接名
 *
 * 选中某项后调用 `onChange(name)`，由父组件负责写 frontmatter + 持久化。
 * "管理连接…" 入口打开已有的 SettingsDialog（connections tab）。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Database, Plus } from "lucide-react";

import { useConnections } from "@/state/connections";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n/use-t";

export interface ConnectionPickerProps {
  value: string | null;
  onChange: (name: string) => void;
  onOpenSettings?: () => void;
}

export function ConnectionPicker({
  value,
  onChange,
  onOpenSettings,
}: ConnectionPickerProps) {
  const t = useT();
  const entries = useConnections((s) => s.entries);
  const loaded = useConnections((s) => s.loaded);
  const reload = useConnections((s) => s.reload);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!loaded) void reload();
  }, [loaded, reload]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const names = useMemo(() => Object.keys(entries).sort(), [entries]);
  const known = value ? value in entries : false;
  const status: "unset" | "missing" | "ok" = !value
    ? "unset"
    : known
      ? "ok"
      : "missing";

  const label =
    status === "unset"
      ? t("connectionPicker.unset")
      : status === "missing"
        ? t("connectionPicker.missing", { name: value })
        : value!;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors",
          "hover:bg-accent hover:text-accent-foreground",
          status === "ok" &&
            "border-border bg-background text-foreground",
          status === "unset" &&
            "border-dashed border-border bg-background text-muted-foreground",
          status === "missing" &&
            "border-destructive/40 bg-destructive/5 text-destructive",
        )}
        title={t("connectionPicker.title")}
      >
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            status === "ok" && "bg-primary",
            status === "unset" && "bg-muted-foreground/50",
            status === "missing" && "bg-destructive",
          )}
        />
        <Database className="h-3 w-3 opacity-70" />
        <span className="max-w-[160px] truncate">{label}</span>
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>

      {open ? (
        <div className="absolute right-0 top-[calc(100%+4px)] z-50 w-56 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-lg">
          <div className="max-h-64 overflow-y-auto py-1">
            {names.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                {t("connectionPicker.empty")}
              </div>
            ) : (
              names.map((name) => {
                const active = name === value;
                return (
                  <button
                    key={name}
                    type="button"
                    onClick={() => {
                      onChange(name);
                      setOpen(false);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground",
                      active && "bg-accent/60 text-foreground",
                    )}
                  >
                    <span
                      className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        active ? "bg-primary" : "bg-muted-foreground/40",
                      )}
                    />
                    <span className="flex-1 truncate">{name}</span>
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {entries[name]?.kind ?? ""}
                    </span>
                  </button>
                );
              })
            )}
          </div>
          {onOpenSettings ? (
            <>
              <div className="border-t border-border" />
              <button
                type="button"
                onClick={() => {
                  onOpenSettings();
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <Plus className="h-3 w-3" />
                {t("connectionPicker.manage")}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
