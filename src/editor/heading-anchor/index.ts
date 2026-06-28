/**
 * Heading anchor Milkdown plugin。
 *
 * 行为：每次 doc 变化时，顺序扫描顶层 `heading` node，按 [./slug.ts](./slug.ts) 生成不
 * 重名 slug，用 ProseMirror node decoration 给 heading DOM 加 `data-heading-slug`
 * 属性。**不写进 node.attrs**，避免 round-trip 把 slug 落到 markdown 里。
 *
 * slug 的消费方：
 *   - [src/editor/MilkdownEditor.tsx](src/editor/MilkdownEditor.tsx) 的 reveal effect
 *     （相对链接 + anchor 跳转）
 *   - [src/services/opener.ts](src/services/opener.ts) 的 `#anchor` 分支（文档内滚动）
 *
 * 为什么不直接在 DOM 上 `h1.id = slug`？
 *   - `id` 冲突（全局）会影响 `document.getElementById` 的唯一性；多 tab 同时存在时会乱
 *   - ProseMirror 会在每次 re-render 时重建 DOM，手动写入的 id 会被覆盖
 *   - decoration 由 PM 维护，和 doc 状态一致，re-render 不丢
 */

import { $prose } from "@milkdown/utils";
import { Plugin, PluginKey } from "@milkdown/prose/state";
import { Decoration, DecorationSet } from "@milkdown/prose/view";
import type { EditorState } from "@milkdown/prose/state";
import type { Node as ProseNode } from "@milkdown/prose/model";

import { buildSlugs } from "./slug";

export const HEADING_SLUG_ATTR = "data-heading-slug";

export const headingAnchorPluginKey = new PluginKey<DecorationSet>(
  "stela-heading-anchor",
);

function computeDecorations(state: EditorState): DecorationSet {
  const positions: number[] = [];
  const texts: string[] = [];
  state.doc.forEach((node: ProseNode, offset: number) => {
    if (node.type.name === "heading") {
      positions.push(offset);
      texts.push(node.textContent);
    }
  });
  if (positions.length === 0) return DecorationSet.empty;
  const slugs = buildSlugs(texts);
  const decos = positions.map((pos, i) => {
    const node = state.doc.nodeAt(pos);
    if (!node) return null;
    return Decoration.node(pos, pos + node.nodeSize, {
      [HEADING_SLUG_ATTR]: slugs[i]!,
    });
  });
  return DecorationSet.create(
    state.doc,
    decos.filter((d): d is Decoration => d !== null),
  );
}

export const headingAnchorPlugin = $prose(() => {
  return new Plugin<DecorationSet>({
    key: headingAnchorPluginKey,
    state: {
      init: (_config, state) => computeDecorations(state),
      apply: (tr, old, _oldState, newState) => {
        if (!tr.docChanged) return old;
        return computeDecorations(newState);
      },
    },
    props: {
      decorations(state) {
        return this.getState(state);
      },
    },
  });
});
