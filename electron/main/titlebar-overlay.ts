/**
 * Win/Linux frameless 窗口右上角系统按钮（titleBarOverlay）主题同步。
 *
 * overlay 背景保持透明，让 renderer 的顶栏 / 蒙版从底下透出来，避免和
 * Dialog 的 bg-black/40 各算一套颜色。只同步 symbolColor + nativeTheme。
 */

import { nativeTheme, type BrowserWindow } from "electron";

import type { ThemeMode } from "@shared/types";

const OVERLAY_HEIGHT = 36;
/** 透明底：透出 WindowsTitleBar / 全屏蒙版 */
export const TITLEBAR_OVERLAY_COLOR = "#00000000";

const SYMBOL_ON_DARK = "#e4e4e7";
const SYMBOL_ON_LIGHT = "#27272a";

export function titleBarSymbolColor(dark: boolean): string {
  return dark ? SYMBOL_ON_DARK : SYMBOL_ON_LIGHT;
}

export function syncTitleBarFromApp(
  win: BrowserWindow | null | undefined,
  mode: ThemeMode,
  effectiveDark: boolean,
): void {
  if (!win || win.isDestroyed()) return;
  if (process.platform === "darwin") return;

  nativeTheme.themeSource =
    mode === "system" ? "system" : mode === "dark" ? "dark" : "light";

  try {
    win.setTitleBarOverlay({
      color: TITLEBAR_OVERLAY_COLOR,
      symbolColor: titleBarSymbolColor(effectiveDark),
      height: OVERLAY_HEIGHT,
    });
  } catch {
    /* 某些 Linux 桌面不支持 titleBarOverlay */
  }
}
