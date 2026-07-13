/**
 * Ctrl+Tab 切换器弹窗。
 *
 * 行为：
 *   - 状态读自 [`useTabSwitcher`](../state/tab-switcher.ts)：open / cursor / orderedIds
 *   - 键盘交互（Ctrl 持续按住 + Tab 累加）由 [`AppShell`](../layout/AppShell.tsx)
 *     的 window listener 驱动；本组件只负责"开了就画"
 *   - 不抢焦点，也不用 Radix Dialog——焦点要留在原编辑器，松开 Ctrl 立刻关闭
 *   - cursor 改变时把对应行 scrollIntoView，避免 tab 多到列表溢出后看不到选中项
 *
 * UI：
 *   - 居中、半透明遮罩、紧凑列表，每行展示标题 + 相对路径 + pinned/dirty 角标
 *   - cursor 行用 accent 背景；可点击直接 confirm，可 hover 切换 cursor
 */

import { File, Pin } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import { useTabSwitcher } from "@/state/tab-switcher";
import { useWorkspace } from "@/state/workspace";
import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";

function relativePath(path: string | undefined, vaultPath: string | null): string {
  if (!path) return "";
  if (vaultPath && path.startsWith(vaultPath)) {
    return path.slice(vaultPath.length).replace(/^[\\/]+/, "");
  }
  return path;
}

export function TabSwitcher() {
  const t = useT();
  const open = useTabSwitcher((s) => s.open);
  const cursor = useTabSwitcher((s) => s.cursor);
  const orderedIds = useTabSwitcher((s) => s.orderedIds);
  const setCursor = useTabSwitcher((s) => s.setCursor);
  const confirm = useTabSwitcher((s) => s.confirm);

  const tabs = useWorkspace((s) => s.tabs);
  const activeId = useWorkspace((s) => s.activeTabId);
  const vaultPath = useWorkspace((s) => s.vaultPath);

  const items = useMemo(() => {
    if (!open) return [];
    const byId = new Map(tabs.map((t) => [t.id, t]));
    return orderedIds
      .map((id) => byId.get(id))
      .filter((t): t is NonNullable<typeof t> => !!t);
  }, [open, orderedIds, tabs]);

  // cursor 行滚动可见
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-tab-switcher-idx="${cursor}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [open, cursor]);

  if (!open || items.length === 0) return null;

  return (
    <div
      className="stela-tab-switcher fixed inset-0 z-[80] flex items-center justify-center bg-black/30 backdrop-blur-[2px]"
      // 点遮罩取消（hover/click 不抢焦点）
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          useTabSwitcher.getState().cancel();
        }
      }}
      role="dialog"
      aria-label={t("tabSwitcher.aria")}
      aria-modal="false"
    >
      <div
        className="flex max-h-[70vh] w-[420px] max-w-[92vw] flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-3 py-2 text-[11px] uppercase tracking-wider text-muted-foreground">
          <span>{t("tabSwitcher.title")}</span>
          <span className="font-mono normal-case">
            {t("tabSwitcher.count", { count: items.length })}
          </span>
        </div>
        <div ref={listRef} className="flex-1 overflow-y-auto p-1">
          {items.map((tab, idx) => {
            const selected = idx === cursor;
            const isCurrent = tab.id === activeId;
            const rel = relativePath(tab.path, vaultPath);
            // 列表中已经在标题中带了 basename，相对路径里把末段去掉避免视觉重复
            const dir = rel.includes("/")
              ? rel.slice(0, rel.lastIndexOf("/"))
              : "";
            return (
              <div
                key={tab.id}
                data-tab-switcher-idx={idx}
                role="option"
                aria-selected={selected}
                onMouseEnter={() => setCursor(idx)}
                onClick={() => confirm()}
                className={cn(
                  "group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                  selected
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-accent/40",
                )}
                title={tab.path ?? tab.title}
              >
                {tab.pinned ? (
                  <Pin className="h-3.5 w-3.5 flex-none text-primary" />
                ) : (
                  <File className="h-3.5 w-3.5 flex-none text-muted-foreground" />
                )}
                <span
                  className={cn(
                    "flex-1 truncate",
                    tab.ephemeral && "italic text-muted-foreground",
                  )}
                >
                  {tab.title}
                </span>
                {tab.dirty ? (
                  <span
                    className="h-1.5 w-1.5 flex-none rounded-full bg-primary"
                    aria-label={t("tabSwitcher.unsaved")}
                  />
                ) : null}
                {dir ? (
                  <span className="ml-2 max-w-[200px] truncate text-[11px] text-muted-foreground">
                    {dir}
                  </span>
                ) : null}
                {isCurrent ? (
                  <span className="ml-1 flex-none text-[10px] uppercase tracking-wider text-muted-foreground">
                    {t("tabSwitcher.current")}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-1.5 font-mono text-[10px] text-muted-foreground">
          <span>
            <kbd className="rounded bg-muted px-1 py-0.5">Tab</kbd>{" "}
            {t("tabSwitcher.nextTab")} ·
            <kbd className="ml-1 rounded bg-muted px-1 py-0.5">⇧Tab</kbd>{" "}
            {t("tabSwitcher.prevTab")}
          </span>
          <span>
            {t("tabSwitcher.releaseToSwitch")} ·
            <kbd className="ml-1 rounded bg-muted px-1 py-0.5">Esc</kbd>{" "}
            {t("tabSwitcher.escCancel")}
          </span>
        </div>
      </div>
    </div>
  );
}
