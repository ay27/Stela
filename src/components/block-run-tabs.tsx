/**
 * RunSQL block 结果区底部的「版本对比栏」。
 *
 * 布局（见用户确认设计）：
 *   | 对比 | 最新 | 版本 1 | 版本 2 | … | 版本 8 | ▾ |
 *
 *   - 最左侧 `对比` 按钮：切换浏览 / 比对模式。比对模式下每个 tab 出现勾选框，
 *     勾选两个即触发 diff。
 *   - tab 横向平铺、平均占满该栏；最左是「最新」，往右依次是更早的版本。
 *   - 默认最多显示 8 个 run tab，超出的进右侧 `▾` 下拉。
 *
 * 不直接拉数据：run 列表由 BlockResult 统一加载后传入。
 */

import { Check, GitCompare } from "lucide-react";

import type { RunRecord } from "@/contracts";
import { MiniSelect, type MiniSelectOption } from "@/components/ui/mini-select";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n/use-t";

/** 默认最多平铺显示的 run tab 数（含「最新」）。 */
export const RUN_TABS_MAX_VISIBLE = 8;

export interface RunTabItem {
  run: RunRecord;
  /** 是否为最新一次成功执行（对应 `<detail>`） */
  isLatest: boolean;
}

export interface RunTabsProps {
  /** 按时间倒序、「最新」在首位 */
  tabs: RunTabItem[];
  mode: "browse" | "compare";
  /** 浏览模式：当前查看的 runId；null = 最新 */
  activeRunId: string | null;
  latestRunId: string | null;
  /** 比对模式：已勾选的 runId（0..2） */
  selectedRunIds: string[];
  /** 是否有 ≥2 个可比对（成功）run；false 时禁用「对比」 */
  canCompare: boolean;
  maxVisible?: number;
  onToggleCompare: () => void;
  onSelectBrowse: (runId: string) => void;
  onToggleSelect: (runId: string) => void;
}

function timeLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const p = (n: number) => String(n).padStart(2, "0");
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (sameDay) return hm;
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${hm}`;
}

function fullTooltip(item: RunTabItem, t: ReturnType<typeof useT>): string {
  const startedAt = new Date(item.run.startedAt).toLocaleString();
  const rows =
    item.run.status === "ok"
      ? t("common.rows", { count: item.run.rowCount })
      : t("runTabs.failed");
  const prefix = item.isLatest ? t("runTabs.latestPrefix") : "";
  return `${prefix}${startedAt} · ${rows} · ${item.run.elapsedMs}ms`;
}

export function RunTabs({
  tabs,
  mode,
  activeRunId,
  latestRunId,
  selectedRunIds,
  canCompare,
  maxVisible = RUN_TABS_MAX_VISIBLE,
  onToggleCompare,
  onSelectBrowse,
  onToggleSelect,
}: RunTabsProps) {
  const t = useT();
  const compare = mode === "compare";
  const visible = tabs.slice(0, maxVisible);
  const overflow = tabs.slice(maxVisible);

  const isActive = (item: RunTabItem) =>
    item.isLatest ? activeRunId === null : activeRunId === item.run.runId;
  const isSelected = (item: RunTabItem) => selectedRunIds.includes(item.run.runId);

  const handleTabClick = (item: RunTabItem) => {
    if (compare) {
      if (item.run.status !== "ok") return;
      onToggleSelect(item.run.runId);
    } else {
      onSelectBrowse(item.isLatest ? (latestRunId ?? item.run.runId) : item.run.runId);
    }
  };

  const overflowOptions: MiniSelectOption[] = overflow.map((item) => {
    const err = item.run.status === "err";
    const selected = isSelected(item);
    const active = isActive(item);
    return {
      value: item.run.runId,
      labelText: timeLabel(item.run.startedAt),
      disabled: compare && err,
      label: (
        <span className="flex items-center gap-1.5">
          <span
            className={cn(
              "inline-block h-1.5 w-1.5 flex-none rounded-full",
              err ? "bg-destructive" : "bg-emerald-500",
            )}
          />
          <span className="tabular-nums">{timeLabel(item.run.startedAt)}</span>
          {item.isLatest ? (
            <span className="text-[10px] text-muted-foreground">
              {t("runTabs.latest")}
            </span>
          ) : null}
          {compare && selected ? <Check className="h-3 w-3 text-primary" /> : null}
          {!compare && active ? <Check className="h-3 w-3 text-primary" /> : null}
        </span>
      ),
    };
  });

  // 下拉当前值：浏览模式高亮 active 的溢出项
  const overflowValue =
    !compare && activeRunId && overflow.some((i) => i.run.runId === activeRunId)
      ? activeRunId
      : "";

  return (
    <div className="stela-cb__run-tabs">
      <button
        type="button"
        onPointerDown={(e) => e.preventDefault()}
        onClick={onToggleCompare}
        disabled={!compare && !canCompare}
        aria-pressed={compare}
        className={cn(
          "stela-cb__run-tabs-compare",
          "inline-flex items-center gap-1 text-[11px] transition-colors",
          "disabled:cursor-not-allowed disabled:opacity-50",
          compare
            ? "stela-cb__run-tabs-compare--active"
            : cn(
                "h-5 rounded border border-border bg-background px-1.5",
                "text-muted-foreground",
                "hover:enabled:bg-accent hover:enabled:text-foreground",
              ),
        )}
        title={
          compare
            ? t("runTabs.exitCompare")
            : canCompare
              ? t("runTabs.compareTwo")
              : t("runTabs.needTwo")
        }
      >
        <GitCompare className={cn("h-3 w-3", compare && "text-primary")} />
        {t("runTabs.compare")}
      </button>

      <div className="stela-cb__run-tabs-list">
        {visible.map((item) => {
          const err = item.run.status === "err";
          const active = isActive(item);
          const selected = isSelected(item);
          return (
            <button
              key={item.run.runId}
              type="button"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => handleTabClick(item)}
              disabled={compare && err}
              title={fullTooltip(item, t)}
              className={cn(
                "stela-cb__run-tab",
                err && "stela-cb__run-tab--err",
                !compare && active && "stela-cb__run-tab--active",
                compare && selected && "stela-cb__run-tab--selected",
              )}
            >
              {compare ? (
                <span
                  className={cn(
                    "stela-cb__run-tab-check",
                    selected && "stela-cb__run-tab-check--on",
                  )}
                  aria-hidden
                >
                  {selected ? <Check className="h-2.5 w-2.5" /> : null}
                </span>
              ) : err ? (
                <span
                  className="inline-block h-1.5 w-1.5 flex-none rounded-full bg-destructive"
                  aria-hidden
                />
              ) : null}
              {item.isLatest ? (
                <span className="stela-cb__run-tab-latest">
                  {t("runTabs.latest")}
                </span>
              ) : null}
              <span className="truncate tabular-nums">
                {timeLabel(item.run.startedAt)}
              </span>
            </button>
          );
        })}
      </div>

      {overflow.length > 0 ? (
        <MiniSelect
          value={overflowValue}
          options={overflowOptions}
          onChange={(v) => (compare ? onToggleSelect(v) : onSelectBrowse(v))}
          size="sm"
          placeholder={`+${overflow.length}`}
          title={t("runTabs.moreHistory")}
          className="stela-cb__run-tabs-more"
        />
      ) : null}
    </div>
  );
}
