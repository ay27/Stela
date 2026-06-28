/**
 * 当前文件查找（Cmd+F / Cmd+Alt+F）的全局状态 store。
 *
 * 同时只有一个 active editor，所以单例 store 就够用——切 tab 时由订阅 store 的
 * MilkdownEditor 自行 hook 进出（mount 关闭、unmount 关闭）。
 *
 * 关键字段：
 *   - `open`：bar 是否显示。
 *   - `mode`："find" / "replace"——后者多渲染一行 replacement 输入。
 *   - `keyword` / `replacement` / `caseSensitive`：受控输入。
 *   - `activeIndex`：当前命中索引（0-based）。-1 表示无 active（keyword 为空 / 无命中）。
 *   - `totalMatches`：当前 keyword 在 doc 内的总命中数。
 *   - `focusToken`：每次"打开 / 重新打开 / 切换 mode"时递增；FindBar 用它驱动 input
 *     重新 focus + selectAll（与 SearchPanel 同款思路）。
 *
 * 这个 store **不**直接调 PM；业务行为放在 [./find-controller.ts](./find-controller.ts)。
 */

import { create } from "zustand";

export type FindMode = "find" | "replace";

export interface FindState {
  /** bar 是否显示。命名为 isOpen 避免和 action `open()` 重名。 */
  isOpen: boolean;
  mode: FindMode;
  keyword: string;
  replacement: string;
  caseSensitive: boolean;
  activeIndex: number;
  totalMatches: number;
  /** 每次 open / re-focus / 切 mode 时 ++，FindBar useEffect 监听重新 focus + select */
  focusToken: number;

  setKeyword: (keyword: string) => void;
  setReplacement: (replacement: string) => void;
  toggleCaseSensitive: () => void;
  setMatches: (activeIndex: number, totalMatches: number) => void;
  /** 打开 bar（已打开则只递增 focusToken 实现"再次按 Cmd+F → 全选输入"）。 */
  open: (mode?: FindMode) => void;
  /** 关闭 bar，清空 keyword 与 matches，但保留 caseSensitive 偏好（用户上次的选择）。 */
  close: () => void;
  /** 切换 find / replace 两个模式。bar 仍开着；focusToken ++ 重新聚焦 keyword 输入。 */
  setMode: (mode: FindMode) => void;
}

const INITIAL: Pick<
  FindState,
  | "isOpen"
  | "mode"
  | "keyword"
  | "replacement"
  | "caseSensitive"
  | "activeIndex"
  | "totalMatches"
  | "focusToken"
> = {
  isOpen: false,
  mode: "find",
  keyword: "",
  replacement: "",
  caseSensitive: false,
  activeIndex: -1,
  totalMatches: 0,
  focusToken: 0,
};

export const useFindState = create<FindState>((set, get) => ({
  ...INITIAL,

  setKeyword: (keyword) => set({ keyword }),
  setReplacement: (replacement) => set({ replacement }),
  toggleCaseSensitive: () =>
    set((s) => ({ caseSensitive: !s.caseSensitive })),
  setMatches: (activeIndex, totalMatches) =>
    set({ activeIndex, totalMatches }),
  open: (mode) => {
    const cur = get();
    set({
      isOpen: true,
      mode: mode ?? cur.mode,
      focusToken: cur.focusToken + 1,
    });
  },
  close: () => {
    set({
      isOpen: false,
      // 关闭时不留 stale matches；下次打开会重新 rescan。
      keyword: "",
      replacement: "",
      activeIndex: -1,
      totalMatches: 0,
    });
  },
  setMode: (mode) => {
    const cur = get();
    if (cur.mode === mode) {
      // 同 mode 重复触发：依然 ++ focusToken（实现"再按 Cmd+F → 全选输入"行为）
      set({ focusToken: cur.focusToken + 1 });
      return;
    }
    set({ mode, focusToken: cur.focusToken + 1 });
  },
}));
