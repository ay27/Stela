/**
 * CodeMirror 6 搜索高亮扩展。
 *
 * 为什么 PM Decoration 不够：RunSQL / Mermaid 用自定义 NodeView 渲染 `code_block`，
 * 把 PM 默认的 `<pre><code>` 替换成内嵌的 CM6 编辑器。NodeView 没有 `contentDOM`，
 * 所以 PM 内部认为 `code_block.textContent` 的文本节点不存在于渲染 DOM 里——
 * `Decoration.inline(from, to, …)` 想包一个 `<span>` 也找不到 DOM 来包，**最终视觉上
 * 完全没有高亮**。
 *
 * 解法：在 NodeView 的 CM 编辑器里加一个 StateField，监听 setCmSearchHighlight /
 * clearCmSearchHighlight 两个 effect，画自家 `Decoration.mark`。MilkdownEditor reveal
 * effect 检测到目标 block 是 code_block 时，桥接一下：拿到 CM 实例 → 计算 SQL 偏移 →
 * dispatch CM effect。
 *
 * 与 PM 侧 search-highlight-plugin 的分工：
 *   - PM 侧：负责 paragraph / heading / list / blockquote 等"PM 直接渲染"的块
 *   - CM 侧（本文件）：负责 NodeView 接管渲染的 code_block 内部
 *   两者通过 [src/editor/MilkdownEditor.tsx](../MilkdownEditor.tsx) 的 reveal effect
 *   协调，时序保持一致（同一份 SEARCH_HL_MS 超时一起清）。
 */

import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";

export interface CmSearchHit {
  /** CM 文档内的字符偏移（0-based）。 */
  from: number;
  /** exclusive。 */
  to: number;
  /** active 命中（当前点击的那条）加深一档。 */
  active: boolean;
}

/**
 * 一次性设置该 CM 编辑器内的搜索命中范围（会覆盖上一次的）。空数组等价 clear。
 */
export const setCmSearchHighlight = StateEffect.define<CmSearchHit[]>();

/**
 * 显式 clear。与 `setCmSearchHighlight.of([])` 等价，留作语义化的清空入口。
 */
export const clearCmSearchHighlight = StateEffect.define<null>();

const hitDeco = Decoration.mark({ class: "stela-cm-search-hit" });
const activeHitDeco = Decoration.mark({
  class: "stela-cm-search-hit stela-cm-search-hit--active",
});

const cmSearchHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setCmSearchHighlight)) {
        const hits = e.value;
        if (hits.length === 0) {
          next = Decoration.none;
          continue;
        }
        // CM Decoration.set 要求 ranges 按 from 升序——caller 调用前应保证；
        // 这里再做一道 sort 兜底，避免外部漏排时崩 invariant。
        const sorted = [...hits].sort((a, b) => a.from - b.from || a.to - b.to);
        next = Decoration.set(
          sorted.map((h) =>
            (h.active ? activeHitDeco : hitDeco).range(h.from, h.to),
          ),
          /* sort */ true,
        );
      } else if (e.is(clearCmSearchHighlight)) {
        next = Decoration.none;
      }
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * 装到 CodeBlockNodeView 的 CM 扩展列表里。一次即可，多次 of 进去也只取第一个。
 */
export function cmSearchHighlightExtension() {
  return cmSearchHighlightField;
}

/**
 * 在 CM 文档全文里找出 `keyword` 的所有命中（按 from 升序）。供 reveal effect
 * 一次性灌进 setCmSearchHighlight 用——不需要走 CM 自带的 @codemirror/search。
 */
export function findCmKeywordMatches(
  cmDocText: string,
  keyword: string,
  caseSensitive: boolean,
): Array<{ from: number; to: number }> {
  if (!keyword) return [];
  const needle = caseSensitive ? keyword : keyword.toLowerCase();
  if (needle.length === 0) return [];
  const hay = caseSensitive ? cmDocText : cmDocText.toLowerCase();
  const out: Array<{ from: number; to: number }> = [];
  let cursor = 0;
  while (cursor <= hay.length) {
    const idx = hay.indexOf(needle, cursor);
    if (idx < 0) break;
    out.push({ from: idx, to: idx + needle.length });
    cursor = idx + Math.max(1, needle.length);
  }
  return out;
}
