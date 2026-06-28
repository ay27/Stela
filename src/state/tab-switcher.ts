/**
 * Ctrl+Tab 切换器状态。
 *
 * 交互：
 *   - 按 `Ctrl+Tab`（或 `Ctrl+Shift+Tab`）→ open=true，按 MRU 顺序快照所有 tab id
 *     到 `orderedIds`，cursor 立即移到下一项（forward 时为 1，backward 时为末位）
 *   - 持续按住 Ctrl，每按一次 Tab 调 `move(±1)`，cursor 在 orderedIds 内循环
 *   - 松开 Ctrl 调 `confirm()`：把 `orderedIds[cursor]` 设为活跃 tab，关闭弹窗
 *   - 按 Escape 调 `cancel()`：关闭弹窗，不改活跃 tab
 *
 * 设计要点：
 *   - `orderedIds` 是打开时一次性快照，弹窗存活期间不动；
 *     这样 confirm 时不会因为 setActive → MRU 重排而错位
 *   - 快照来源 = `mruTabIds`（活跃排第一），加上 MRU 中没有的 tab 兜底追加，
 *     保证全集
 *   - 单 tab / 空 tab 时 open 调用直接 no-op，避免无意义弹窗
 */

import { create } from "zustand";

import { useWorkspace } from "@/state/workspace";

interface TabSwitcherState {
  open: boolean;
  /** orderedIds 内的高亮位置；松开 Ctrl 时落到这个 tab */
  cursor: number;
  /**
   * 弹窗存活期间的 tab id 顺序快照。第一项是触发时的活跃 tab，
   * 第二项是「上一个使用」的 tab——cursor 默认就指向它。
   */
  orderedIds: string[];

  /**
   * 打开切换器（如果已开则直接 move）。
   * @param direction 1 = forward（Tab）；-1 = backward（Shift+Tab）
   */
  openSwitcher: (direction: 1 | -1) => void;
  /** cursor 在 orderedIds 内循环移动 */
  move: (delta: 1 | -1) => void;
  /** 松开 Ctrl：确认 cursor 指向的 tab 为活跃 tab，关闭弹窗 */
  confirm: () => void;
  /** Esc：关闭弹窗，不切换 */
  cancel: () => void;
  /** 直接 set cursor（鼠标 hover / 点击场景） */
  setCursor: (idx: number) => void;
}

function buildOrderedIds(): string[] {
  const { tabs, mruTabIds, activeTabId } = useWorkspace.getState();
  if (tabs.length === 0) return [];
  const tabIdSet = new Set(tabs.map((t) => t.id));
  const seen = new Set<string>();
  const ordered: string[] = [];
  // 1. 先按 MRU 顺序——栈顶（最近活跃，理论上 = activeTabId）排第一
  for (const id of mruTabIds) {
    if (tabIdSet.has(id) && !seen.has(id)) {
      ordered.push(id);
      seen.add(id);
    }
  }
  // 2. MRU 没覆盖到的 tab（理论上不应有，兜底）按 tabs 自身顺序追加
  for (const t of tabs) {
    if (!seen.has(t.id)) {
      ordered.push(t.id);
      seen.add(t.id);
    }
  }
  // 3. 不变量：activeTabId 必须排第一（如果它存在）
  if (activeTabId && ordered[0] !== activeTabId && tabIdSet.has(activeTabId)) {
    const next = ordered.filter((id) => id !== activeTabId);
    next.unshift(activeTabId);
    return next;
  }
  return ordered;
}

export const useTabSwitcher = create<TabSwitcherState>((set, get) => ({
  open: false,
  cursor: 0,
  orderedIds: [],

  openSwitcher: (direction) => {
    const { open } = get();
    if (open) {
      // 已经在 hold 状态了，按 Tab 等价 move
      get().move(direction);
      return;
    }
    const ordered = buildOrderedIds();
    if (ordered.length < 2) return;
    // direction=1：默认跳到上一次访问（idx=1，VS Code / IntelliJ 行为）
    // direction=-1：跳到末位
    const cursor = direction === 1 ? 1 : ordered.length - 1;
    set({ open: true, cursor, orderedIds: ordered });
  },

  move: (delta) => {
    const { open, cursor, orderedIds } = get();
    if (!open || orderedIds.length === 0) return;
    const len = orderedIds.length;
    const next = (cursor + delta + len) % len;
    if (next === cursor) return;
    set({ cursor: next });
  },

  setCursor: (idx) => {
    const { open, orderedIds } = get();
    if (!open) return;
    if (idx < 0 || idx >= orderedIds.length) return;
    set({ cursor: idx });
  },

  confirm: () => {
    const { open, cursor, orderedIds } = get();
    if (!open) return;
    set({ open: false, cursor: 0, orderedIds: [] });
    const targetId = orderedIds[cursor];
    if (!targetId) return;
    const ws = useWorkspace.getState();
    if (!ws.tabs.some((t) => t.id === targetId)) return;
    if (ws.activeTabId === targetId) return;
    ws.setActive(targetId);
  },

  cancel: () => {
    if (!get().open) return;
    set({ open: false, cursor: 0, orderedIds: [] });
  },
}));
