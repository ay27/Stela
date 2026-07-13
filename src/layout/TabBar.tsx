import * as ContextMenu from "@radix-ui/react-context-menu";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Bot,
  ChevronDown,
  FileText,
  Loader2,
  Pin,
  PinOff,
  X,
} from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";

import { useWorkspace, type Tab } from "@/state/workspace";
import { useLayout } from "@/state/layout";
import { cn } from "@/lib/utils";
import { formatHotkey } from "@/lib/hotkeys";
import { useT } from "@/i18n/use-t";
import { TitlebarNavButtons } from "./TitlebarNavButtons";

const CLOSE_TAB_HINT = formatHotkey("Mod+W");
const REOPEN_HINT = formatHotkey("Mod+Shift+T");

/** 拖拽用的 mime type；自定义避免和系统 text/plain 冲突。 */
const TAB_DRAG_MIME = "application/x-stela-tab-id";

export function TabBar() {
  const t = useT();
  const tabs = useWorkspace((s) => s.tabs);
  const activeId = useWorkspace((s) => s.activeTabId);
  const setActive = useWorkspace((s) => s.setActive);
  const closeTab = useWorkspace((s) => s.closeTab);
  const closeOtherTabs = useWorkspace((s) => s.closeOtherTabs);
  const closeTabsToRight = useWorkspace((s) => s.closeTabsToRight);
  const closeSavedTabs = useWorkspace((s) => s.closeSavedTabs);
  const reopenLastClosed = useWorkspace((s) => s.reopenLastClosed);
  const setPinned = useWorkspace((s) => s.setPinned);
  const reorderTab = useWorkspace((s) => s.reorderTab);
  const promoteEphemeral = useWorkspace((s) => s.promoteEphemeral);
  const closedCount = useWorkspace((s) => s.closedTabsStack.length);

  const agentPanelCollapsed = useLayout((s) => s.agentPanelCollapsed);
  const sidebarCollapsed = useLayout((s) => s.sidebarCollapsed);
  const toggleAgentPanel = useLayout((s) => s.toggleAgentPanel);
  const focusAgentPanel = useLayout((s) => s.focusAgentPanel);

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [hoverTargetId, setHoverTargetId] = useState<string | null>(null);

  // 把 handlers 包成稳定引用，让 TabItem 的 React.memo 能跳过未变 tab 的重渲染。
  // store action 函数本身在 zustand 里就是稳定的；包一层 useMemo 锁定整体对象引用。
  const handlers: TabHandlers = useMemo(
    () => ({
      onSelect: setActive,
      onClose: closeTab,
      onCloseOthers: closeOtherTabs,
      onCloseToRight: closeTabsToRight,
      onCloseSaved: closeSavedTabs,
      onReopenLast: reopenLastClosed,
      onTogglePin: (id, pinned) => setPinned(id, pinned),
      onPromote: promoteEphemeral,
    }),
    [
      setActive,
      closeTab,
      closeOtherTabs,
      closeTabsToRight,
      closeSavedTabs,
      reopenLastClosed,
      setPinned,
      promoteEphemeral,
    ],
  );

  const onDragStart = (id: string, e: React.DragEvent) => {
    e.dataTransfer.setData(TAB_DRAG_MIME, id);
    e.dataTransfer.effectAllowed = "move";
    setDraggingId(id);
  };

  const onDragEnd = () => {
    setDraggingId(null);
    setHoverTargetId(null);
  };

  const onDragOverTab = (targetId: string, e: React.DragEvent) => {
    if (!draggingId || draggingId === targetId) return;
    const src = tabs.find((t) => t.id === draggingId);
    const dst = tabs.find((t) => t.id === targetId);
    if (!src || !dst) return;
    // 跨 pinned/unpinned 区不允许 drop
    if ((src.pinned ?? false) !== (dst.pinned ?? false)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setHoverTargetId(targetId);
  };

  const onDropOnTab = (targetId: string, e: React.DragEvent) => {
    e.preventDefault();
    const sourceId = e.dataTransfer.getData(TAB_DRAG_MIME) || draggingId;
    setDraggingId(null);
    setHoverTargetId(null);
    if (!sourceId) return;
    reorderTab(sourceId, targetId);
  };

  /**
   * 鼠标滚轮 → 横向滚动。PC 鼠标只有竖向滚轮，没有这个映射就完全滚不动。
   * macOS trackpad 双指横向手势浏览器原生就走 scrollLeft（deltaX !== 0），
   * 我们只在 deltaX === 0 时才把 deltaY 转换过去，避免和触控板手势打架。
   *
   * 不调 preventDefault：onWheel 是 React passive listener，preventDefault
   * 不生效；同时 main 是 overflow:hidden、body 也是 overflow:hidden，
   * 没有可被"误滚"的祖先页面。
   */
  const onWheelScroll = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (e.deltaX === 0 && e.deltaY !== 0) {
      e.currentTarget.scrollLeft += e.deltaY;
    }
  }, []);

  // 没有 tab 时直接不渲染整个 TabBar，避免在 Welcome 空态上方留一条空 chrome。
  if (tabs.length === 0) return null;

  return (
    <div
      className={cn(
        "stela-app-drag stela-titlebar-safe-right flex h-9 flex-none items-stretch border-b border-border bg-muted/60",
        sidebarCollapsed && "stela-titlebar-safe-left",
      )}
    >
      {sidebarCollapsed ? (
        <div className="flex flex-none items-center self-center">
          <TitlebarNavButtons />
        </div>
      ) : null}
      {/*
       * min-w-0 关键：父级是 flex container，flex 子项默认 min-width:auto，
       * 会被内部 N 个 TabItem 撑超过父容器宽度，触发外层 main overflow-hidden
       * 裁剪，自己的 overflow-x-auto 反而失效。min-w-0 把最小宽度归零，让
       * 容器尊重父级宽度，超出时由 overflow-x-auto 横向滚动。
       *
       * stela-tabbar-scroll：隐藏可见滚动条（10px 滚动条在 36px tabbar 里太丑），
       * 保留滚动能力。
       *
       * 父容器是 stela-app-drag（frameless 窗口拖拽区），这里需要 no-drag
       * 把 TabItem 区域恢复成可点击 / 可滚动；否则鼠标按住任意 tab 都会被
       * 系统当成"拖窗起手"，点击 / drag-reorder / 横滚都失灵。
       */}
      <div
        className="stela-app-no-drag stela-tabbar-scroll flex min-w-0 flex-1 items-stretch overflow-x-auto"
        onWheel={onWheelScroll}
      >
        {tabs.map((tab, idx) => {
          const active = tab.id === activeId;
          const prev = tabs[idx - 1];
          const next = tabs[idx + 1];

          // 仅在「两个非激活 tab 相邻」时画竖线，避免激活 tab 两侧的线与激活边框打架
          const showLeftDivider =
            idx > 0 && !active && prev && prev.id !== activeId;
          const showRightDivider =
            idx < tabs.length - 1 && !active && next && next.id !== activeId;

          return (
            <TabItem
              key={tab.id}
              tab={tab}
              idx={idx}
              active={active}
              showLeftDivider={!!showLeftDivider}
              showRightDivider={!!showRightDivider}
              isLast={idx === tabs.length - 1}
              closedCount={closedCount}
              dragging={draggingId === tab.id}
              dropTarget={hoverTargetId === tab.id}
              onDragStartTab={onDragStart}
              onDragEndTab={onDragEnd}
              onDragOverTab={onDragOverTab}
              onDropOnTab={onDropOnTab}
              handlers={handlers}
            />
          );
        })}
        {/* 末尾 spacer 显式恢复 drag，让 TabBar 右侧空白区域也能拖窗。 */}
        <div className="stela-app-drag flex-1 border-b border-border/0" />
      </div>
      {tabs.length > 1 ? (
        <OverflowMenu
          tabs={tabs}
          activeId={activeId}
          onSelect={setActive}
          onClose={closeTab}
        />
      ) : null}
      <button
        type="button"
        onClick={() =>
          agentPanelCollapsed ? focusAgentPanel() : toggleAgentPanel()
        }
        title={
          agentPanelCollapsed ? t("tab.agentOpen") : t("tab.agentCollapse")
        }
        className={cn(
          "stela-app-no-drag flex w-8 flex-none items-center justify-center border-l border-border hover:bg-background/50",
          agentPanelCollapsed
            ? "text-muted-foreground hover:text-foreground"
            : "text-primary",
        )}
      >
        <Bot className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

interface TabHandlers {
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onCloseOthers: (id: string) => void;
  onCloseToRight: (id: string) => void;
  onCloseSaved: () => void;
  onReopenLast: () => void;
  onTogglePin: (id: string, pinned: boolean) => void;
  onPromote: (id: string) => void;
}

interface TabItemProps {
  tab: Tab;
  idx: number;
  active: boolean;
  showLeftDivider: boolean;
  showRightDivider: boolean;
  isLast: boolean;
  closedCount: number;
  dragging: boolean;
  dropTarget: boolean;
  onDragStartTab: (id: string, e: React.DragEvent) => void;
  onDragEndTab: () => void;
  onDragOverTab: (id: string, e: React.DragEvent) => void;
  onDropOnTab: (id: string, e: React.DragEvent) => void;
  handlers: TabHandlers;
}

function TabItemImpl({
  tab,
  idx,
  active,
  showLeftDivider,
  showRightDivider,
  isLast,
  closedCount,
  dragging,
  dropTarget,
  onDragStartTab,
  onDragEndTab,
  onDragOverTab,
  onDropOnTab,
  handlers,
}: TabItemProps) {
  const t = useT();
  const {
    onSelect,
    onClose,
    onCloseOthers,
    onCloseToRight,
    onCloseSaved,
    onReopenLast,
    onTogglePin,
    onPromote,
  } = handlers;
  const canCloseToRight = !isLast;
  const isPinned = !!tab.pinned;
  const isEphemeral = !!tab.ephemeral;
  const sqlRunning = (tab.sqlRunningCount ?? 0) > 0;
  const onDragStart = (e: React.DragEvent) => onDragStartTab(tab.id, e);
  const onDragEnd = () => onDragEndTab();
  const onDragOver = (e: React.DragEvent) => onDragOverTab(tab.id, e);
  const onDrop = (e: React.DragEvent) => onDropOnTab(tab.id, e);

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          draggable
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onClick={() => onSelect(tab.id)}
          // 双击 tab 标题 → 升级 ephemeral 为永久（与 obsidian 行为一致）
          onDoubleClick={() => {
            if (isEphemeral) onPromote(tab.id);
          }}
          onAuxClick={(e) => {
            if (e.button === 1) {
              e.preventDefault();
              onClose(tab.id);
            }
          }}
          className={cn(
            // shrink-0：tab 多时不被压缩到不可读的窄度，超出由父容器横向滚动
            "group relative flex min-w-[120px] max-w-[220px] shrink-0 cursor-pointer select-none items-center gap-2 px-3 text-[12px] transition-colors",
            active
              ? "bg-background text-foreground"
              : "text-muted-foreground hover:bg-background/50 hover:text-foreground",
            showLeftDivider && "border-l border-border",
            showRightDivider && "border-r border-border",
            dragging && "opacity-40",
          )}
          title={
            sqlRunning
              ? `${tab.path ?? tab.title}\n${t("tab.sqlRunningSuffix")}`
              : (tab.path ?? tab.title)
          }
        >
          <span
            className={cn(
              "pointer-events-none absolute inset-x-0 bottom-0 h-[2px]",
              active ? "bg-primary" : "bg-transparent",
            )}
          />
          {dropTarget ? (
            <span className="pointer-events-none absolute inset-y-0 left-0 w-[2px] bg-primary" />
          ) : null}

          {isPinned ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onTogglePin(tab.id, false);
              }}
              title={t("tab.unpin")}
              className="flex h-3.5 w-3.5 flex-none items-center justify-center text-primary hover:text-foreground"
            >
              <Pin className="h-3 w-3" />
            </button>
          ) : idx < 9 ? (
            <span
              className="flex-none font-mono text-[10px] text-muted-foreground/70"
              aria-hidden
            >
              {idx + 1}
            </span>
          ) : null}

          <span
            className={cn(
              "flex-1 truncate",
              // ephemeral：标题斜体，对比度略降，强化"还没承诺打开"的语义
              isEphemeral && "italic text-muted-foreground/90",
            )}
          >
            {tab.title}
          </span>

          {sqlRunning ? (
            <Loader2 className="h-3 w-3 flex-none animate-spin text-primary" />
          ) : null}

          {tab.dirty ? (
            <span className="h-1.5 w-1.5 flex-none rounded-full bg-primary" />
          ) : null}

          {!isPinned ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
              title={t("tab.closeWithHotkey", { hotkey: CLOSE_TAB_HINT })}
              className={cn(
                "flex h-4 w-4 flex-none items-center justify-center rounded text-muted-foreground",
                // ephemeral 与 active 一样始终显示关闭按钮——预览态本来就该一眼能丢掉
                "opacity-0 group-hover:opacity-100 hover:bg-accent hover:text-foreground",
                (active || isEphemeral) && "opacity-100",
              )}
            >
              <X className="h-3 w-3" />
            </button>
          ) : (
            <span className="h-4 w-4 flex-none" />
          )}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="z-[60] min-w-[200px] overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
          <MenuItem
            label={t("tab.close")}
            hotkey="Mod+W"
            onSelect={() => onClose(tab.id)}
            disabled={isPinned}
          />
          <MenuItem label={t("tab.closeOthers")} onSelect={() => onCloseOthers(tab.id)} />
          <MenuItem
            label={t("tab.closeToRight")}
            onSelect={() => onCloseToRight(tab.id)}
            disabled={!canCloseToRight}
          />
          <MenuItem label={t("tab.closeSaved")} onSelect={() => onCloseSaved()} />
          <ContextMenu.Separator className="my-1 h-px bg-border" />
          <MenuItem
            label={isPinned ? t("tab.unpinTab") : t("tab.pin")}
            onSelect={() => onTogglePin(tab.id, !isPinned)}
          />
          <ContextMenu.Separator className="my-1 h-px bg-border" />
          <MenuItem
            label={
              closedCount > 0
                ? t("tab.reopenClosedCount", { count: closedCount })
                : t("tab.reopenClosed")
            }
            hotkey="Mod+Shift+T"
            onSelect={() => onReopenLast()}
            disabled={closedCount === 0}
          />
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/**
 * 给 TabItem 包一层 React.memo，避免某个 tab 的 dirty/active/ephemeral 变化时
 * 整条 tab 列表都被重渲染。
 *
 * 关键性能修复：之前 setDirty 会生成新的 tabs 数组（map 的产物），TabBar 的
 * useWorkspace((s) => s.tabs) selector 拿到新引用 → 重渲染整个 TabBar →
 * 所有 TabItem 跟着 commit。打字保存触发的 dirty toggle 会在 50+ tab 文档上
 * 体感为"键击有迟滞"。memo 后，未变 tab 的子树跳过协调与 DOM 提交，整体延迟
 * 从 N 倍 (tab 数) 降为 O(1)。
 *
 * handlers 对象在父组件用 useMemo 锁了引用，drag 回调直接接收 tab.id 在内部
 * 包闭包，所有 prop 都是 referentially stable when meaningful values unchanged。
 * 标准 React.memo 浅比较即可命中——不需要自定义 comparator。
 */
const TabItem = memo(TabItemImpl);

function MenuItem({
  label,
  hotkey,
  onSelect,
  disabled,
}: {
  label: string;
  hotkey?: string;
  onSelect: () => void;
  disabled?: boolean;
}) {
  return (
    <ContextMenu.Item
      onSelect={onSelect}
      disabled={disabled}
      className={cn(
        "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-xs outline-none",
        "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
        "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
      )}
    >
      <span className="flex-1">{label}</span>
      {hotkey ? (
        <span className="font-mono text-[10px] text-muted-foreground">
          {hotkey === "Mod+Shift+T" ? REOPEN_HINT : formatHotkey(hotkey)}
        </span>
      ) : null}
    </ContextMenu.Item>
  );
}

/**
 * 末尾的 ▾ 按钮：列出当前所有 tab，方便在折叠 / 横滚状态下快速定位。
 *
 * 设计取舍：
 *   - 不实际把溢出的 tab 折叠掉视图（容器自带横滚），避免布局抖动
 *   - dropdown 按当前 tab 顺序展示，pinned 在前；激活 tab 高亮；可单独关闭
 */
function OverflowMenu({
  tabs,
  activeId,
  onSelect,
  onClose,
}: {
  tabs: Tab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}) {
  const t = useT();
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          title={t("tab.allTabs", { count: tabs.length })}
          className="stela-app-no-drag flex w-8 flex-none items-center justify-center border-l border-border text-muted-foreground hover:bg-background/50 hover:text-foreground"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-[60] max-h-[60vh] min-w-[260px] overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          {tabs.map((tab) => (
            <OverflowItem
              key={tab.id}
              tab={tab}
              active={tab.id === activeId}
              onSelect={() => onSelect(tab.id)}
              onClose={() => onClose(tab.id)}
            />
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function OverflowItem({
  tab,
  active,
  onSelect,
  onClose,
}: {
  tab: Tab;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const closable = !tab.pinned;
  const sqlRunning = (tab.sqlRunningCount ?? 0) > 0;
  return (
    <DropdownMenu.Item
      onSelect={onSelect}
      className={cn(
        "group flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-xs outline-none",
        "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
        active && "bg-accent/40 font-medium text-foreground",
      )}
    >
      {tab.pinned ? (
        <Pin className="h-3.5 w-3.5 flex-none text-primary" />
      ) : (
        <FileText className="h-3.5 w-3.5 flex-none text-muted-foreground" />
      )}
      {sqlRunning ? (
        <Loader2 className="h-3 w-3 flex-none animate-spin text-primary" />
      ) : null}
      <span
        className={cn(
          "flex-1 truncate",
          tab.ephemeral && "italic text-muted-foreground",
        )}
        title={tab.path ?? tab.title}
      >
        {tab.title}
      </span>
      {tab.dirty ? (
        <span className="h-1.5 w-1.5 flex-none rounded-full bg-primary" />
      ) : null}
      {closable ? (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }}
          title={t("tab.closeWithHotkey", { hotkey: CLOSE_TAB_HINT })}
          className="flex h-4 w-4 flex-none items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-background hover:text-foreground group-hover:opacity-100"
        >
          <X className="h-3 w-3" />
        </button>
      ) : tab.pinned ? (
        <PinOff className="h-3 w-3 flex-none text-muted-foreground/40" />
      ) : null}
    </DropdownMenu.Item>
  );
}
