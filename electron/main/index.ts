/**
 * Electron 主进程入口。
 *
 * 启动顺序：
 *   1. 应用就绪前安装安全策略（web-contents-created hooks）
 *   2. ready 后注册 IPC handler、初始化 connector registry
 *   3. 创建主窗口；窗口加载 dev URL 或打包后 file://
 *   4. quit 时关闭 SQLite + 子进程 connector
 */

import { app, BrowserWindow } from "electron";
import path from "node:path";

import { registerAllHandlers } from "./handlers";
import { applyCsp, applySecurityDefaults } from "./security";
import { createMainWindow, resolveAssetPath } from "./window";
import { assertAllRegistered, unregisterAll } from "./ipc-router";
import { shutdownVaultContext } from "./vault-context";
import * as connectorRegistry from "../services/connectors/registry";
import * as resultStore from "../services/result-store";
import * as sqlIndex from "../services/sql-index";
import * as vaultIndex from "../services/vault-index";
import * as vaultWatcher from "../services/vault-watcher";
import { bootstrapFromLegacyIfFresh } from "../services/user-cache-store";
import { log } from "../services/logger";
import { IPC_EVENTS } from "@shared/ipc-events";

// 进程级异常兜底：onnxruntime / better-sqlite3 这类 native 模块抛 C++ 异常
// 时会冒泡成 uncaughtException，没有 handler 的话整个 main 静默 SIGABRT，
// stderr 拿不到任何 trace。装上 handler 至少能在崩之前把堆栈 flush 出去。
// 不在这里 process.exit —— 让默认行为（Node 22+ 会 throw 退出）继续，
// 这样 electron-vite 至少能感知到子进程退出码。
process.on("uncaughtException", (err) => {
  try {
    log.error("uncaughtException", err);
    // 强制把 stderr 缓冲推出去（native abort 时默认 flush 可能丢最后行）
    if (typeof (process.stderr as { _writev?: unknown })._writev === "function") {
      try { (process.stderr as unknown as { write: (s: string) => void }).write(""); } catch { /* noop */ }
    }
  } catch {
    /* logger 自己挂了也别再 throw */
  }
});
process.on("unhandledRejection", (reason) => {
  try {
    log.error("unhandledRejection", reason);
  } catch {
    /* noop */
  }
});

/**
 * dev / prod 环境探测：项目规则要求统一看 `ELECTRON_RENDERER_URL`，
 * 不依赖 `app.isPackaged`。dev 下 electron-vite 会注入这个 env。
 */
const IS_DEV = !!process.env.ELECTRON_RENDERER_URL;

// dev 单独走一份 userData，避免与已安装的 /Applications/Stela.app（生产版）
// 抢同一把 singleton lock —— 抢不到锁会立刻 app.quit()，表现是 electron-vite
// 一启动就退、像"启动不起来"。同时把 settings / connections / cache 完全隔离
// 也方便开发态调试不污染真实数据。
if (IS_DEV) {
  const devName = `${app.getName()}-dev`;
  app.setPath("userData", path.join(app.getPath("appData"), devName));
}

let mainWindow: BrowserWindow | null = null;

function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

// 防止 macOS 上多实例
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  applySecurityDefaults();

  app.whenReady().then(async () => {
    applyCsp();

    registerAllHandlers({ getMainWindow });
    assertAllRegistered();

    // 一次性迁移：把老 user 级 settings 里的 vault.path / recentPaths
    // seed 进新 stela-cache.json。已有 cache 则 no-op。
    await bootstrapFromLegacyIfFresh().catch((err) => {
      log.error("bootstrap user-cache from legacy failed", err);
    });

    try {
      // 仅注册内置 connector；subprocess plugin 等到 renderer 调
      // window.stela.vault.setCurrent(...) 时通过 vault-context 重新加载。
      connectorRegistry.initBuiltinRegistry();
    } catch (err) {
      log.error("connector registry init failed", err);
    }
    log.info("renderer entry =", process.env.ELECTRON_RENDERER_URL ?? "<file>");

    const preloadPath = path.join(__dirname, "../preload/index.mjs");
    const rendererHtml = resolveAssetPath("out/renderer/index.html");

    mainWindow = createMainWindow({
      preloadPath,
      rendererHtmlPath: rendererHtml,
    });
    mainWindow.on("closed", () => {
      mainWindow = null;
    });

    // 注入 vault-watcher 的广播 sink。watcher 在 setCurrentVault 时启动，
    // 启动时会读取这里设置好的 broadcaster；先创建 BrowserWindow 再 set 是
    // 因为 webContents 必须在 window 创建后才存在。
    vaultWatcher.setBroadcaster((payload) => {
      const win = mainWindow;
      if (!win || win.isDestroyed()) return;
      try {
        win.webContents.send(IPC_EVENTS.VAULT_EXTERNAL_CHANGE, payload);
      } catch (err) {
        log.error("send vault:external-change failed", err);
      }
    });

    // 同上：vault-index 完成增量更新后通过这条 sink 把单独的 INDEX_CHANGED
    // 事件推给 renderer。事件无 payload，renderer 端 store 收到后按 token
    // bump 触发重查（见 src/state/wiki-index.ts）。
    vaultIndex.setBroadcaster((channel) => {
      const win = mainWindow;
      if (!win || win.isDestroyed()) return;
      try {
        win.webContents.send(channel);
      } catch (err) {
        log.error("send index:changed failed", err);
      }
    });

    // 同上：SQL 事实索引完成全量构建 / 增量更新后通过这条 sink 推给 renderer。
    sqlIndex.setBroadcaster((channel) => {
      const win = mainWindow;
      if (!win || win.isDestroyed()) return;
      try {
        win.webContents.send(channel);
      } catch (err) {
        log.error("send sql-index:changed failed", err);
      }
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow({
          preloadPath,
          rendererHtmlPath: rendererHtml,
        });
        mainWindow.on("closed", () => {
          mainWindow = null;
        });
      }
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("before-quit", () => {
    try {
      unregisterAll();
      shutdownVaultContext();
      connectorRegistry.shutdown();
      resultStore.close();
    } catch (err) {
      log.error("shutdown error", err);
    }
  });
}
