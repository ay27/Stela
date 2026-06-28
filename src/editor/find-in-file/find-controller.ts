/**
 * Find-in-file 控制器：把 [./use-find-state.ts](./use-find-state.ts) 的状态变更翻译成
 * PM transaction（rescan / gotoIndex / replace / replaceAll / close）。
 *
 * 设计要点：
 *   1. **不直接持有 EditorView**——caller 通过 `FindControllerOpts.getView()` 拿，避免
 *      闭包捕获过期的 view（用户切 tab、view 销毁重建时）。
 *   2. **active reveal handle 模块单例**：FindBar 同时只能 reveal 一处，每次 next/prev/
 *      replace 前都先 cleanup 旧 handle 再创建新的，保证 PM/CM 高亮与定时器不泄漏。
 *   3. **keyword 命中算法复用** `findKeywordMatches`（locator 内）——和 search-highlight-
 *      plugin 用同一份扫描，命中索引语义一致。这意味着所有匹配都基于 PM doc text node，
 *      跨 mark 边界的命中会被切碎；与 vault 全局搜索的限制保持一致。
 *   4. **replace 走 PM tr.replaceWith / tr.delete**——code_block 内的替换会触发
 *      [CodeBlockNodeView.update()](../runsql/codeblock-nodeview.ts) 内置的 PM→CM diff
 *      回灌，无需在控制器层处理。
 */

import type { EditorView } from "@milkdown/prose/view";

import { findKeywordMatches, type RevealRange } from "@/editor/search";

import {
  clearActiveReveal,
  revealRange,
  setActiveReveal,
} from "./reveal";
import { useFindState } from "./use-find-state";

export interface FindControllerOpts {
  /** 取当前 PM EditorView。FindBar mount 时把 viewRef.current 包进 closure 传进来。 */
  getView: () => EditorView | null;
}

/**
 * 重扫 keyword 命中列表，并把 total / clamp 后的 activeIndex 写回 store。
 *
 * 设计意图：
 *   - 每次 next/prev/replace 都 rescan 一次，编辑过的 doc 也不会拿到过期 pos；
 *   - keyword 为空 → totalMatches=0 / activeIndex=-1，FindBar UI 显示 "No results"。
 *
 * 返回值：用于 caller 紧接着 gotoIndex（避免再扫一次）。
 */
export function rescan(opts: FindControllerOpts): RevealRange[] {
  const view = opts.getView();
  const { keyword, caseSensitive, activeIndex } = useFindState.getState();
  if (!view || !keyword) {
    useFindState.getState().setMatches(-1, 0);
    return [];
  }
  const matches = findKeywordMatches(view, keyword, caseSensitive);
  let nextIndex = activeIndex;
  if (matches.length === 0) nextIndex = -1;
  else if (nextIndex < 0 || nextIndex >= matches.length) nextIndex = 0;
  useFindState.getState().setMatches(nextIndex, matches.length);
  return matches;
}

/**
 * 跳到 matches[wrap(index)] 并完成 reveal。
 *
 * wrap-around：超出 [0, len) 自动按 len 取模映射回去（next 在末尾跳回 0，prev 在头部
 * 跳到 len-1）。负数也能正确取模（双重 + len 防 JS `%` 负数语义）。
 */
function gotoIndex(
  opts: FindControllerOpts,
  matches: RevealRange[],
  index: number,
): void {
  const view = opts.getView();
  if (!view || matches.length === 0) return;
  const len = matches.length;
  const wrap = ((index % len) + len) % len;
  const range = matches[wrap];
  if (!range) return;
  const { keyword, caseSensitive } = useFindState.getState();
  // 切换前 cleanup 旧 handle（含 pendingReveal effect 安装的）；同 tick 内紧接着 revealRange，
  // 浏览器 batch 一次 paint，无闪烁。
  clearActiveReveal();
  const handle = revealRange(view, range, {
    keyword,
    caseSensitive,
    // bar 持续显示时不让高亮自动消失；close 时统一清。
    hlTimeoutMs: -1,
    // step 高频触发，flash 太吵；只在首次显式 reveal 时由 caller 传 flash:true。
    flash: false,
  });
  setActiveReveal(handle);
  useFindState.getState().setMatches(wrap, len);
}

/** keyword 改变后，重扫并跳到第 0 个命中。bar 输入框 onChange 调它。 */
export function refresh(opts: FindControllerOpts): void {
  const matches = rescan(opts);
  if (matches.length === 0) {
    clearActiveReveal();
    return;
  }
  gotoIndex(opts, matches, 0);
}

export function next(opts: FindControllerOpts): void {
  const matches = rescan(opts);
  if (matches.length === 0) return;
  const { activeIndex } = useFindState.getState();
  gotoIndex(opts, matches, activeIndex < 0 ? 0 : activeIndex + 1);
}

export function prev(opts: FindControllerOpts): void {
  const matches = rescan(opts);
  if (matches.length === 0) return;
  const { activeIndex } = useFindState.getState();
  gotoIndex(
    opts,
    matches,
    activeIndex < 0 ? matches.length - 1 : activeIndex - 1,
  );
}

/** 关闭 bar：清 active reveal + 同步关闭 store。 */
export function close(): void {
  clearActiveReveal();
  useFindState.getState().close();
}

/**
 * 用单一 PM transaction 把 from..to 替换为 replacement（空串走 delete）。
 * 抽出来供 replace / replaceAll 复用，确保对 code_block 内文本的替换走相同路径。
 */
function applyReplaceTr(
  view: EditorView,
  from: number,
  to: number,
  replacement: string,
): boolean {
  try {
    const tr =
      replacement.length === 0
        ? view.state.tr.delete(from, to)
        : view.state.tr.replaceWith(
            from,
            to,
            view.state.schema.text(replacement),
          );
    view.dispatch(tr);
    return true;
  } catch (err) {
    console.warn("[stela] replace dispatch failed", err);
    return false;
  }
}

/**
 * Replace 当前 active 命中。
 *
 * 流程：
 *   1. fresh rescan（防止 store 里 activeIndex 与编辑后的实际 matches 不一致）；
 *   2. 在 active 处 dispatch 单 step tr.replaceWith / delete；
 *   3. rescan + gotoIndex(原 activeIndex) —— 替换后该条被消耗，下一条天然顶上来；
 *      若已无命中，clear active reveal。
 */
export function replace(opts: FindControllerOpts): void {
  const view = opts.getView();
  if (!view) return;
  const { keyword, replacement, caseSensitive, activeIndex } =
    useFindState.getState();
  if (!keyword) return;
  const matches = findKeywordMatches(view, keyword, caseSensitive);
  if (
    matches.length === 0 ||
    activeIndex < 0 ||
    activeIndex >= matches.length
  ) {
    return;
  }
  const m = matches[activeIndex];
  if (!m) return;
  if (!applyReplaceTr(view, m.from, m.to, replacement)) return;

  const after = rescan(opts);
  if (after.length === 0) {
    clearActiveReveal();
    return;
  }
  // 替换前 activeIndex 处的命中已被消耗，下一个命中自动顶上来；clamp 到末尾防越界。
  gotoIndex(opts, after, Math.min(activeIndex, after.length - 1));
}

/**
 * Replace All：**倒序** 单事务连续 step 替换。
 *
 * 倒序的关键：每个 step 改变文档长度，但只影响"之后"的位置。从后往前替换，前面的
 * 命中 pos 不会被前一个 step 推位，无需 mapping 计算。一次 dispatch → undo 是单步操作，
 * 用户 Cmd+Z 一次复原全部替换。
 */
export function replaceAll(opts: FindControllerOpts): void {
  const view = opts.getView();
  if (!view) return;
  const { keyword, replacement, caseSensitive } = useFindState.getState();
  if (!keyword) return;
  const matches = findKeywordMatches(view, keyword, caseSensitive);
  if (matches.length === 0) return;

  let tr = view.state.tr;
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    if (!m) continue;
    try {
      tr =
        replacement.length === 0
          ? tr.delete(m.from, m.to)
          : tr.replaceWith(m.from, m.to, view.state.schema.text(replacement));
    } catch (err) {
      console.warn("[stela] replaceAll step failed", err);
      return;
    }
  }
  try {
    view.dispatch(tr);
  } catch (err) {
    console.warn("[stela] replaceAll dispatch failed", err);
    return;
  }

  const after = rescan(opts);
  if (after.length === 0) {
    clearActiveReveal();
  } else {
    gotoIndex(opts, after, 0);
  }
}

/**
 * Editor 销毁 / 切 tab 时调一次：清掉 active reveal handle + 关闭 store。
 * 与 close() 不同的是这里只做"清理"，由 caller 决定是否要让 bar 关闭。
 */
export function teardown(): void {
  clearActiveReveal();
}
