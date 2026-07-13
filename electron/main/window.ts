/**
 * BrowserWindow 创建与管理。
 *
 * 安全要点：
 * - contextIsolation: true（默认；显式写出来便于审计）
 * - nodeIntegration: false（renderer 不拿 Node 权限）
 * - sandbox: false（preload 需要在 require 范围内导入 ipcRenderer/contextBridge；
 *   sandbox=true 会限制 preload 仅能用 import，且无法 require native 模块。
 *   我们在 preload 里只 require electron，没有 native deps，理论上可以开 sandbox，
 *   但 electron-vite cjs preload 在 sandbox 模式下 require 行为不稳，先保留 false。
 *   Phase 7 评估开 sandbox。）
 * - webSecurity: true
 * - 不加载远程内容
 */

import { BrowserWindow, app, nativeTheme } from "electron";
import path from "node:path";

import {
  TITLEBAR_OVERLAY_COLOR,
  titleBarSymbolColor,
} from "./titlebar-overlay";

/**
 * electron-vite 的 dev/prod 约定：
 *   - dev 模式：ELECTRON_RENDERER_URL 指向 dev server
 *   - prod 模式：环境变量缺失，从 file:// 加载打包后的 index.html
 */
const RENDERER_URL = process.env.ELECTRON_RENDERER_URL;

const IS_MAC = process.platform === "darwin";

export interface CreateMainWindowOptions {
  preloadPath: string;
  rendererHtmlPath: string;
}

export function createMainWindow(opts: CreateMainWindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    title: "Stela",
    backgroundColor: "#101115",
    // 移除系统标题栏，渲染层自绘 chrome（参考 VS Code / Linear）。
    //   - macOS：hidden + 自定义 trafficLightPosition，让红绿灯落进 Sidebar
    //     顶部 vault header（pl-[78px] 给它让位）。"hidden" 比 "hiddenInset"
    //     更可控（后者只在 inset=true 时偏移红绿灯，且 y 偏移固定）。
    //   - Windows：hidden + titleBarOverlay 叠在 renderer 自绘的顶栏
    //    （WindowsTitleBar）右上角；TabBar 不再避让。
    //   - Linux：overlay 仍叠 TabBar 右上角，renderer 保留 ~138px 安全区。
    titleBarStyle: "hidden",
    ...(IS_MAC
      ? {
          // 36px TabBar / 44px vault header 中点附近，垂直居中红绿灯。
          // 与 Sidebar.tsx pl-[78px] 配合，整条 header 视觉对齐。
          trafficLightPosition: { x: 14, y: 12 },
        }
      : {
          titleBarOverlay: {
            color: TITLEBAR_OVERLAY_COLOR,
            symbolColor: titleBarSymbolColor(nativeTheme.shouldUseDarkColors),
            height: 36,
          },
        }),
    webPreferences: {
      preload: opts.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      spellcheck: false,
      // 阻止 form submit 触发导航
      navigateOnDragDrop: false,
    },
  });

  // 阻止默认菜单的 New Window 等动作意外打开远程内容
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  if (RENDERER_URL) {
    win.loadURL(RENDERER_URL);
    if (!app.isPackaged) {
      win.webContents.openDevTools({ mode: "detach" });
    }
  } else {
    win.loadFile(opts.rendererHtmlPath);
  }

  return win;
}

export function resolveAssetPath(...segments: string[]): string {
  return path.join(app.getAppPath(), ...segments);
}
