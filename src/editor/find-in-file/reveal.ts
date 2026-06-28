/**
 * 通用的"把一个 PM range 滚到视口、加高亮、闪一下"的纯函数封装。
 *
 * 设计动机：
 *   - 原先 reveal 逻辑写在 [MilkdownEditor.tsx](../MilkdownEditor.tsx) 的 effect 闭包里，
 *     依赖一堆组件 ref（activeCm / hlTimer / flashTimer / flashEl）；
 *   - 引入 in-editor find bar 后，next/prev 切换 active 命中也要走完全相同的链路，
 *     必须做成可以多次调用、handle 可控的函数。
 *
 * 行为契约：
 *   - 调一次 `revealRange(view, range, opts)` 返回一个 `RevealHandle`，包含 `cleanup()`；
 *   - 内部副作用：
 *     1. PM `tr.setSelection(Selection.near($from))`（不带 scrollIntoView，避免 PM 自家
 *        scroll 算法在表格 / 长 NodeView 内静默失败——见 docs/memory.md 同日条目）；
 *     2. DOM 原生 `Element.scrollIntoView({ block: "center", behavior: "auto" })`；
 *     3. code_block 节点：bridge 到内嵌 CM，dispatch selection + scrollIntoView + 高亮；
 *     4. PM `searchHighlightPlugin` 的 `setSearch` meta，画 inline / 块级 Decoration；
 *     5. 可选 `.stela-reveal-flash` 800ms 自褪闪动；
 *   - `cleanup()` 把上述所有状态一次性收掉：清 timeout、摘 flash class、派 clearSearch
 *     给 PM / CM。caller 必须在新一次 reveal 前调旧 handle 的 cleanup。
 *
 * 不在职责内：
 *   - 反复读取 store / 解析 RevealLoc → range；caller 自己用 `resolveReveal()` 拿好。
 *   - 异步等待 layout 沉降；caller 自己用 double rAF（pendingReveal 路径）或确认 view
 *     已稳定（FindBar next/prev 路径）。
 */

import { EditorView as CMView } from "@codemirror/view";
import type { EditorView } from "@milkdown/prose/view";
import { Selection } from "@milkdown/prose/state";

import {
  clearCmSearchHighlight,
  findCmKeywordMatches,
  setCmSearchHighlight,
} from "@/editor/runsql/cm-search-highlight";
import {
  clearSearch,
  searchHighlightPluginKey,
  setSearch,
  type RevealRange,
} from "@/editor/search";

export interface RevealOptions {
  /** 用于 PM Decoration + CM 内同关键字 hits 收集。空字符串等价于不画高亮。 */
  keyword?: string;
  caseSensitive?: boolean;
  /**
   * 高亮自动消失时间（毫秒）。
   *   - 默认 3000ms（与旧版 `SEARCH_HL_MS` 一致）；
   *   - 传 -1 / 0 / 任何 ≤0 值 → **不**自动消失，由 caller 自己 cleanup（FindBar 持续
   *     打开时用这个）。
   */
  hlTimeoutMs?: number;
  /** 是否给 active block 加 .stela-reveal-flash class（800ms 自褪）。 */
  flash?: boolean;
  /**
   * 强制走块级 active 高亮（`Decoration.node` 整块描边）。
   * 通常 caller 不需要手动设：keyword 路径里命中落在 code_block 时会自动转块级；
   * line / slug / detail-fallback 路径由 caller 通过 range.kind 表达，本函数也会
   * 自动判定。这条参数留给极少数想强制走块级的边界场景。
   */
  forceBlock?: boolean;
}

export interface RevealHandle {
  /**
   * 一次性收掉本次 reveal 的所有副作用：
   *   - 取消未跑完的 hl / flash timeout
   *   - 摘掉 flash class
   *   - 派 clearSearch 给 PM 与（如有）active CM
   * 可重复调（幂等）。
   */
  cleanup(): void;
}

/**
 * 模块单例 active handle。MilkdownEditor 的 pendingReveal effect 与 FindBar 的
 * controller 共享：任何一方再次 reveal 之前都先 cleanup 上一次的 handle，避免
 * 两条路径同时管 PM/CM 高亮 → fade timer / class 残留。
 *
 * 用 setActiveReveal 在 caller 完成本次 reveal 后注册 handle；下一次任何 caller 想
 * 走 reveal 时调 takeoverReveal()——它会把旧 handle cleanup 掉再返回新位置占用。
 */
let activeHandle: RevealHandle | null = null;

/** 把当前 handle 替换为新的，旧 handle 立即 cleanup。null 表示放弃 active 状态。 */
export function setActiveReveal(handle: RevealHandle | null): void {
  if (activeHandle && activeHandle !== handle) {
    try {
      activeHandle.cleanup();
    } catch {
      /* swallow */
    }
  }
  activeHandle = handle;
}

export function clearActiveReveal(): void {
  setActiveReveal(null);
}

const DEFAULT_HL_MS = 3000;
const FLASH_MS = 800;

/**
 * 给定一个已解析的 RevealRange，找到要 scrollIntoView 的最佳 DOM 元素。
 *   1. code_block（NodeView 接管）→ 直接 `view.nodeDOM(blockPos)`，因为 domAtPos
 *      在无 contentDOM 节点内部只会返回编辑器根节点。
 *   2. 否则 `view.domAtPos(range.from)` 拿命中字符所在 inline DOM 的 parentElement。
 *   3. 兜底：`view.nodeDOM(blockPos)`。
 */
function findRevealDom(
  view: EditorView,
  range: RevealRange,
): HTMLElement | null {
  // node 测试环境没有 DOM globals；此函数在测试里通过 try/catch 也能跑过，但
  // ReferenceError 会被打到 stderr 噪声很大。直接 guard 一下 typeof 避免污染。
  if (typeof HTMLElement === "undefined") return null;

  const blockNode = view.state.doc.nodeAt(range.blockPos);
  const blockDom = view.nodeDOM(range.blockPos);

  if (
    blockNode?.type.name === "code_block" &&
    blockDom instanceof HTMLElement
  ) {
    return blockDom;
  }

  try {
    const at = view.domAtPos(range.from);
    const el =
      at.node instanceof HTMLElement ? at.node : at.node.parentElement;
    if (el && el !== view.dom) return el;
  } catch {
    /* 某些边界 pos 上 domAtPos 会抛 */
  }

  if (blockDom instanceof HTMLElement) return blockDom;
  return null;
}

export function revealRange(
  view: EditorView,
  range: RevealRange,
  opts: RevealOptions = {},
): RevealHandle {
  const kw = opts.keyword ?? "";
  const caseSensitive = opts.caseSensitive ?? false;
  const hlTimeoutMs = opts.hlTimeoutMs ?? DEFAULT_HL_MS;

  let activeCm: CMView | null = null;
  let hlTimer: ReturnType<typeof setTimeout> | null = null;
  let flashTimer: ReturnType<typeof setTimeout> | null = null;
  let flashEl: HTMLElement | null = null;
  let cleaned = false;

  // 1) PM 选区（不带 PM 自家 scrollIntoView，PM 算法在表格/长 NodeView 内不可靠）
  try {
    const $from = view.state.doc.resolve(range.from);
    view.dispatch(view.state.tr.setSelection(Selection.near($from)));
  } catch (err) {
    console.warn("[stela] reveal selection dispatch failed", err);
  }

  // 2) DOM 原生 scrollIntoView，浏览器内核路径，处理嵌套滚动 / table 都正确
  try {
    const dom = findRevealDom(view, range);
    if (dom) dom.scrollIntoView({ block: "center", behavior: "auto" });
  } catch (err) {
    console.warn("[stela] DOM scrollIntoView failed", err);
  }

  // 3) code_block 桥接到内嵌 CM
  const targetNode = view.state.doc.nodeAt(range.blockPos);
  const isCodeBlock = targetNode?.type.name === "code_block";

  if (isCodeBlock && targetNode) {
    try {
      const nodeDom = view.nodeDOM(range.blockPos);
      const cm =
        nodeDom instanceof HTMLElement ? CMView.findFromDOM(nodeDom) : null;
      if (cm) {
        const docLen = cm.state.doc.length;
        const cmFrom = Math.min(
          docLen,
          Math.max(0, range.from - (range.blockPos + 1)),
        );
        const cmTo = Math.min(
          docLen,
          Math.max(cmFrom, range.to - (range.blockPos + 1)),
        );
        const cmText = cm.state.doc.toString();
        const allHits =
          kw.length > 0 ? findCmKeywordMatches(cmText, kw, caseSensitive) : [];
        const annotated = allHits.map((h) => ({
          from: h.from,
          to: h.to,
          active: h.from === cmFrom && h.to === cmTo,
        }));
        cm.dispatch({
          effects: setCmSearchHighlight.of(annotated),
          selection: { anchor: cmFrom, head: cmTo },
          scrollIntoView: true,
        });
        activeCm = cm;
      }
    } catch (err) {
      console.warn("[stela] code_block CM bridge failed", err);
    }
  }

  // 4) PM Decoration（inline + 块级二选一）
  if (kw.length > 0) {
    // useBlockHighlight：当 range 不是 keyword 类型（line/slug/detail fallback），或
    // keyword 命中落在 code_block 内（PM 在 NodeView 内画不出 inline）时，统一走
    // 块级描边作为视觉锚。
    const useBlockHighlight =
      !!opts.forceBlock || range.kind !== "keyword" || isCodeBlock;
    const blockTo = targetNode
      ? range.blockPos + targetNode.nodeSize
      : range.blockPos;
    try {
      view.dispatch(
        view.state.tr.setMeta(
          searchHighlightPluginKey,
          setSearch({
            keyword: kw,
            caseSensitive,
            activeFrom: useBlockHighlight ? -1 : range.from,
            activeTo: useBlockHighlight ? -1 : range.to,
            activeBlockFrom: useBlockHighlight ? range.blockPos : -1,
            activeBlockTo: useBlockHighlight ? blockTo : -1,
          }),
        ),
      );
    } catch (err) {
      console.warn("[stela] setSearch dispatch failed", err);
    }
    if (hlTimeoutMs > 0) {
      hlTimer = setTimeout(() => {
        hlTimer = null;
        try {
          view.dispatch(
            view.state.tr.setMeta(searchHighlightPluginKey, clearSearch()),
          );
        } catch {
          /* view destroyed */
        }
        if (activeCm) {
          try {
            activeCm.dispatch({ effects: clearCmSearchHighlight.of(null) });
          } catch {
            /* CM destroyed */
          }
          activeCm = null;
        }
      }, hlTimeoutMs);
    }
  }

  // 5) flash
  if (opts.flash) {
    try {
      const at = view.domAtPos(range.blockPos + 1);
      const node = at.node;
      const el = (
        node instanceof HTMLElement ? node : node.parentElement
      ) as HTMLElement | null;
      const blockEl = el?.closest<HTMLElement>(".ProseMirror > *");
      if (blockEl) {
        blockEl.classList.add("stela-reveal-flash");
        flashEl = blockEl;
        flashTimer = setTimeout(() => {
          flashTimer = null;
          blockEl.classList.remove("stela-reveal-flash");
          if (flashEl === blockEl) flashEl = null;
        }, FLASH_MS);
      }
    } catch (err) {
      // domAtPos 在边界 pos 上可能抛；flash 是锦上添花，丢弃即可。
      void err;
    }
  }

  return {
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      if (hlTimer) {
        clearTimeout(hlTimer);
        hlTimer = null;
      }
      if (flashTimer) {
        clearTimeout(flashTimer);
        flashTimer = null;
      }
      if (flashEl) {
        flashEl.classList.remove("stela-reveal-flash");
        flashEl = null;
      }
      try {
        view.dispatch(
          view.state.tr.setMeta(searchHighlightPluginKey, clearSearch()),
        );
      } catch {
        /* view destroyed */
      }
      if (activeCm) {
        try {
          activeCm.dispatch({ effects: clearCmSearchHighlight.of(null) });
        } catch {
          /* CM destroyed */
        }
        activeCm = null;
      }
    },
  };
}
