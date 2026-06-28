/**
 * CodeMirror 主题适配。
 *
 * 我们用 `@fsegurai/codemirror-theme-vscode-light` / `vscode-dark` 接管代码块的
 * 颜色 / 字体 / 选区 / cursor / 高亮等等，让 RunSQL 块视觉上贴近 VS Code。
 *
 * 主题切换：监听 `<html>` 的 `class` / `data-theme` 变化（由 `ThemeProvider`
 * 在切换时写入）。所有 NodeView 共享一个 MutationObserver + 订阅 Set —— 单文件
 * 几十个代码块时没必要每个都自己装一份 observer。
 *
 * NodeView 的 destroy 路径必须调用 `subscribeCmTheme` 返回的 unsubscribe，否则
 * 会造成 listener 泄漏（最后一个 listener 取消时才会 disconnect MO）。
 */

import { vsCodeLight } from "@fsegurai/codemirror-theme-vscode-light";
import { vsCodeDark } from "@fsegurai/codemirror-theme-vscode-dark";
import type { Extension } from "@codemirror/state";

/**
 * 当前是否处于 dark 模式。
 *
 * `ThemeProvider` 会在切换时同时写入 `<html class="dark">` 和 `data-theme`，
 * 这里只看 class 即可（与 Tailwind dark 变体保持一致）。
 */
function isDarkMode(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.classList.contains("dark");
}

export function currentCmTheme(): Extension {
  return isDarkMode() ? vsCodeDark : vsCodeLight;
}

let mo: MutationObserver | null = null;
const listeners = new Set<() => void>();

function ensureObserver(): void {
  if (mo) return;
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
  mo = new MutationObserver(() => {
    // 复制一份再迭代，防止 listener 在回调里 unsubscribe 改动 Set
    for (const cb of Array.from(listeners)) {
      try {
        cb();
      } catch (err) {
        // 单个 listener 抛错不能让其他 listener 丢通知
        console.error("[stela] cm theme listener failed", err);
      }
    }
  });
  mo.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-theme"],
  });
}

function teardownObserverIfIdle(): void {
  if (listeners.size > 0) return;
  if (mo) {
    mo.disconnect();
    mo = null;
  }
}

/**
 * 注册主题变化回调。返回 unsubscribe。
 *
 * 当所有订阅者都取消时 MutationObserver 会自动 disconnect，避免空跑。
 */
export function subscribeCmTheme(cb: () => void): () => void {
  listeners.add(cb);
  ensureObserver();
  return () => {
    listeners.delete(cb);
    teardownObserverIfIdle();
  };
}
