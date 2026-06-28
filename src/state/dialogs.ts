/**
 * 全局 dialog 开关 store。
 *
 * 把 ConnectionsDialog / SettingsDialog / CommandPalette 的开闭状态从 Sidebar 内部
 * 提到全局 store，方便：
 *   - 命令面板可以触发 "打开 Settings"（不再依赖组件树位置）
 *   - cmd+K 全局快捷键直接 toggle，不必通过 props 链向下传
 *   - FileTree 右键 / cmd+N 等任何位置都能调起 "新建笔记"（M5 扩展）
 */

import { create } from "zustand";

interface DialogsState {
  connectionsOpen: boolean;
  settingsOpen: boolean;
  paletteOpen: boolean;
  /** 当前要导出的笔记路径；null 表示对话框关闭 */
  exportNoteFilePath: string | null;
  setConnections: (open: boolean) => void;
  setSettings: (open: boolean) => void;
  setPalette: (open: boolean) => void;
  togglePalette: () => void;
  openExportNote: (filePath: string) => void;
  closeExportNote: () => void;
}

export const useDialogs = create<DialogsState>((set, get) => ({
  connectionsOpen: false,
  settingsOpen: false,
  paletteOpen: false,
  exportNoteFilePath: null,
  setConnections: (open) => set({ connectionsOpen: open }),
  setSettings: (open) => set({ settingsOpen: open }),
  setPalette: (open) => set({ paletteOpen: open }),
  togglePalette: () => set({ paletteOpen: !get().paletteOpen }),
  openExportNote: (filePath) => set({ exportNoteFilePath: filePath }),
  closeExportNote: () => set({ exportNoteFilePath: null }),
}));
