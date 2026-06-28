/**
 * 全局快捷键集中管理。
 *
 * 设计：
 *   - 单个 `keydown` listener 挂在 window 上，按顺序匹配 bindings
 *   - 每个 binding 带 `context`：
 *     - `"always"`：任何焦点都生效（包括输入框/编辑器内）
 *     - `"outside-input"`：焦点**不**在 input/textarea/contenteditable 时才生效
 *   - 匹配后 preventDefault + stopPropagation，保证浏览器/系统默认键位（尤其 Cmd+W）
 *     不抢占
 *   - 提供 `useHotkeys(bindings)` hook：组件挂载期间注册，卸载自动清理
 *
 * 命名：用 lucide / VSCode 社区通用写法，大小写不敏感。
 *   - "Mod"：macOS 映射到 Meta（Cmd），其它平台映射到 Control
 *   - 修饰符顺序：Mod / Ctrl / Shift / Alt 在前，主键在最后
 */

import { useEffect } from "react";

export type HotkeyContext = "always" | "outside-input";

export interface HotkeyBinding {
  /** 快捷键表达式，示例：`"Mod+K"`、`"Mod+Shift+F"`、`"Mod+1"`、`"Escape"` */
  keys: string;
  context?: HotkeyContext;
  handler: (e: KeyboardEvent) => void;
}

interface Parsed {
  mod: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  /** 主键（小写），如 "k"、"enter"、"arrowup"、"," */
  key: string;
}

function parse(keys: string): Parsed {
  const parts = keys.split("+").map((s) => s.trim());
  const out: Parsed = { mod: false, ctrl: false, shift: false, alt: false, key: "" };
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "mod" || lower === "cmd" || lower === "meta") out.mod = true;
    else if (lower === "ctrl" || lower === "control") out.ctrl = true;
    else if (lower === "shift") out.shift = true;
    else if (lower === "alt" || lower === "option") out.alt = true;
    else out.key = lower;
  }
  return out;
}

const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || "");

/**
 * 把 KeyboardEvent 的"逻辑键名"统一抽出来给 binding 比对。
 *
 * **关键 quirk**：macOS 上按住 Option（Alt）时，`Option+F` 的 `e.key` 不是 `"f"`
 * 而是组合字符 `"ƒ"`；同理 `Option+S = "ß"`、`Option+G = "©"` 等。直接比 e.key
 * 会让 `Mod+Alt+F` 这类 binding 永远 miss。
 *
 * 解法：letter / digit 物理键统一走 `e.code`（"KeyF" / "Digit3"），与 macOS 的
 * Option 组合字符无关；其它键（Enter / Escape / Arrow* / 标点）继续用 e.key——
 * e.code 在标点上是 `"Comma" / "Period"` 之类，与 binding 写法（`"Mod+,"`）对不上。
 */
function eventLogicalKey(e: KeyboardEvent): string {
  if (e.code && e.code.startsWith("Key") && e.code.length === 4) {
    return e.code.charAt(3).toLowerCase();
  }
  if (e.code && e.code.startsWith("Digit") && e.code.length === 6) {
    return e.code.charAt(5);
  }
  return e.key.toLowerCase();
}

function matches(binding: Parsed, e: KeyboardEvent): boolean {
  const modPressed = IS_MAC ? e.metaKey : e.ctrlKey;
  if (binding.mod !== modPressed) return false;
  // ctrl 只在非 "Mod" 下额外要求（Mod 已经包含 ctrl on non-mac）
  if (!binding.mod && binding.ctrl !== e.ctrlKey) return false;
  if (binding.shift !== e.shiftKey) return false;
  if (binding.alt !== e.altKey) return false;
  return eventLogicalKey(e) === binding.key;
}

/**
 * 判断事件发生在文本输入控件内（input / textarea / contenteditable / CodeMirror / ProseMirror）。
 *
 * 这个判断只影响 `"outside-input"` context 的 binding 是否放行；`"always"` 的 binding
 * 在任何地方都会被触发。
 */
function isInsideInput(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  // CodeMirror 6 的 .cm-content 以及 ProseMirror 的 .milkdown / .ProseMirror
  if (target.closest(".cm-content, .ProseMirror, .milkdown")) return true;
  return false;
}

/**
 * 把快捷键表达式（如 `"Mod+Shift+F"`）按当前平台格式化为用户可读字符串。
 * macOS：`⇧⌘F`；其它平台：`Ctrl+Shift+F`。供 button `title` 和 Settings Shortcuts
 * tab 展示共用。
 */
export function formatHotkey(keys: string): string {
  const p = parse(keys);
  const parts: string[] = [];
  if (IS_MAC) {
    if (p.ctrl) parts.push("⌃");
    if (p.alt) parts.push("⌥");
    if (p.shift) parts.push("⇧");
    if (p.mod) parts.push("⌘");
    parts.push(prettyKey(p.key, true));
    return parts.join("");
  }
  if (p.mod || p.ctrl) parts.push("Ctrl");
  if (p.alt) parts.push("Alt");
  if (p.shift) parts.push("Shift");
  parts.push(prettyKey(p.key, false));
  return parts.join("+");
}

function prettyKey(key: string, mac: boolean): string {
  switch (key) {
    case "enter":
      return mac ? "⏎" : "Enter";
    case "escape":
      return mac ? "⎋" : "Esc";
    case "arrowup":
      return "↑";
    case "arrowdown":
      return "↓";
    case "arrowleft":
      return "←";
    case "arrowright":
      return "→";
    case "backspace":
      return mac ? "⌫" : "Backspace";
    case "tab":
      return mac ? "⇥" : "Tab";
    case " ":
    case "space":
      return "Space";
    default:
      return key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
  }
}

/**
 * 注册一组快捷键；组件卸载时自动清理。
 *
 * 传入的 bindings 会在每次 render 重新解析，为了稳定性建议用 `useMemo` 包 bindings
 * 数组，或直接把 handler 写成 stable ref（`useCallback`）。
 */
export function useHotkeys(bindings: HotkeyBinding[]): void {
  useEffect(() => {
    const parsed = bindings.map((b) => ({ ...b, parsed: parse(b.keys) }));
    const onKey = (e: KeyboardEvent) => {
      // 尊重下游（CodeMirror / Radix / 等）已经处理过的键：比如 runsql 块内
      // CM 的 bridgeKeymap 处理 Mod+Enter 后会调 preventDefault，这里就该放行，
      // 避免全局 Mod+Enter 再点一次 Run 按钮导致 SQL 跑两遍。
      if (e.defaultPrevented) return;
      const inInput = isInsideInput(e.target);
      for (const b of parsed) {
        if (b.context === "outside-input" && inInput) continue;
        if (!matches(b.parsed, e)) continue;
        e.preventDefault();
        e.stopPropagation();
        b.handler(e);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bindings]);
}
