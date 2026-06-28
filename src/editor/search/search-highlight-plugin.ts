/**
 * 搜索关键字 PM 装饰插件。
 *
 * 替换旧版"DOM TreeWalker + absolute span overlay"：
 *   - 纯 ProseMirror Decoration，跟随 doc 自动 reposition，编辑/输入不漂；
 *   - `Decoration.inline` 跨 text node 边界 OK（PM 自己分片渲染）；
 *   - 命中 active 单独描边，其余命中淡黄；3 秒由调用方派 `clearSearch` 清掉。
 *
 * 数据流：
 *   MilkdownEditor reveal effect
 *     → view.dispatch(tr.setMeta(key, { keyword, caseSensitive, activeFrom, activeTo }))
 *     → plugin.apply 重新扫 doc 收集 matches + 计算 decoration set
 *     → props.decorations 返回该 set
 *   docChanged 时 plugin.apply 也会自动重算 matches，避免编辑后高亮错位。
 *
 * 与 [./locator.ts](./locator.ts) 的 `findKeywordMatches` 走完全相同的扫描算法（按 text
 * node + indexOf），所以同一份 keyword 在 locator 和本 plugin 拿到的 match 列表顺序一致
 * （都是 PM doc pos 升序）——locator 给的 `nthInFile` 直接对应 plugin 这里的 active 索引。
 */

import { $prose } from "@milkdown/utils";
import type { EditorState } from "@milkdown/prose/state";
import { Plugin, PluginKey } from "@milkdown/prose/state";
import type { Node as ProseNode } from "@milkdown/prose/model";
import { Decoration, DecorationSet } from "@milkdown/prose/view";

export interface SearchHighlightState {
  keyword: string;
  caseSensitive: boolean;
  /** active 命中的精确 PM 范围（高亮加深一档 + 描边）。-1 = 无 active。 */
  activeFrom: number;
  activeTo: number;
  /**
   * 块级 active：keyword 路径找不到第 N 个匹配时，由 caller 给出顶层 block 的 pmPos +
   * nodeSize，把整块描边。用于 `<detail>` 命中 / 行号兜底等场景。
   */
  activeBlockFrom: number;
  activeBlockTo: number;
  /** 缓存的 inline 命中 range（按 doc 顺序）。 */
  matches: ReadonlyArray<{ from: number; to: number }>;
  /** 计算 matches 时的 doc 版本号；用于跳过同 doc 的重复扫描。 */
  docVersion: ProseNode | null;
}

export interface SearchHighlightMeta {
  /** 设置搜索状态；`keyword` 为空串视为 clear。 */
  set?: {
    keyword: string;
    caseSensitive?: boolean;
    activeFrom?: number;
    activeTo?: number;
    activeBlockFrom?: number;
    activeBlockTo?: number;
  };
  /** 显式 clear；与 `set: { keyword: "" }` 等价。 */
  clear?: true;
}

export const searchHighlightPluginKey = new PluginKey<SearchHighlightState>(
  "stela-search-highlight",
);

const EMPTY_STATE: SearchHighlightState = {
  keyword: "",
  caseSensitive: false,
  activeFrom: -1,
  activeTo: -1,
  activeBlockFrom: -1,
  activeBlockTo: -1,
  matches: [],
  docVersion: null,
};

const HIT_CLASS = "stela-search-hit";
const ACTIVE_CLASS = "stela-search-hit stela-search-hit--active";
const ACTIVE_BLOCK_CLASS = "stela-search-hit-block";

function scanMatches(
  state: EditorState,
  keyword: string,
  caseSensitive: boolean,
): Array<{ from: number; to: number }> {
  if (!keyword) return [];
  const needle = caseSensitive ? keyword : keyword.toLowerCase();
  if (needle.length === 0) return [];
  const out: Array<{ from: number; to: number }> = [];
  state.doc.descendants((node: ProseNode, pos: number) => {
    if (!node.isText) return true;
    const text = node.text ?? "";
    const hay = caseSensitive ? text : text.toLowerCase();
    let cursor = 0;
    while (cursor <= hay.length) {
      const idx = hay.indexOf(needle, cursor);
      if (idx < 0) break;
      const from = pos + idx;
      out.push({ from, to: from + needle.length });
      cursor = idx + Math.max(1, needle.length);
    }
    return true;
  });
  return out;
}

function buildDecorationSet(
  state: EditorState,
  s: SearchHighlightState,
): DecorationSet {
  if (
    s.matches.length === 0 &&
    s.activeBlockFrom < 0 &&
    s.activeBlockTo < 0
  ) {
    return DecorationSet.empty;
  }
  const decos: Decoration[] = [];
  for (const m of s.matches) {
    const isActive = m.from === s.activeFrom && m.to === s.activeTo;
    decos.push(
      Decoration.inline(m.from, m.to, {
        class: isActive ? ACTIVE_CLASS : HIT_CLASS,
      }),
    );
  }
  if (s.activeBlockFrom >= 0 && s.activeBlockTo > s.activeBlockFrom) {
    const node = state.doc.nodeAt(s.activeBlockFrom);
    if (node) {
      decos.push(
        Decoration.node(s.activeBlockFrom, s.activeBlockTo, {
          class: ACTIVE_BLOCK_CLASS,
        }),
      );
    }
  }
  return DecorationSet.create(state.doc, decos);
}

export const searchHighlightPlugin = $prose(() => {
  return new Plugin<SearchHighlightState>({
    key: searchHighlightPluginKey,
    state: {
      init: () => EMPTY_STATE,
      apply: (tr, old, _oldState, newState) => {
        const meta = tr.getMeta(searchHighlightPluginKey) as
          | SearchHighlightMeta
          | undefined;

        // 显式 clear
        if (meta?.clear) {
          return EMPTY_STATE;
        }

        // 设置 / 更新
        if (meta?.set) {
          const keyword = meta.set.keyword;
          const caseSensitive = meta.set.caseSensitive ?? false;
          if (!keyword) return EMPTY_STATE;
          const matches = scanMatches(newState, keyword, caseSensitive);
          return {
            keyword,
            caseSensitive,
            activeFrom: meta.set.activeFrom ?? -1,
            activeTo: meta.set.activeTo ?? -1,
            activeBlockFrom: meta.set.activeBlockFrom ?? -1,
            activeBlockTo: meta.set.activeBlockTo ?? -1,
            matches,
            docVersion: newState.doc,
          };
        }

        // 没 meta：doc 变化时同 keyword 重扫；否则透传。
        if (!tr.docChanged) return old;
        if (!old.keyword) return old;
        const matches = scanMatches(newState, old.keyword, old.caseSensitive);
        // 编辑后 active 范围会随 mapping 移动；直接用 tr.mapping 映射旧 active。
        const newActiveFrom =
          old.activeFrom >= 0 ? tr.mapping.map(old.activeFrom) : -1;
        const newActiveTo =
          old.activeTo >= 0 ? tr.mapping.map(old.activeTo) : -1;
        const newBlockFrom =
          old.activeBlockFrom >= 0 ? tr.mapping.map(old.activeBlockFrom) : -1;
        const newBlockTo =
          old.activeBlockTo >= 0 ? tr.mapping.map(old.activeBlockTo) : -1;
        return {
          ...old,
          matches,
          activeFrom: newActiveFrom,
          activeTo: newActiveTo,
          activeBlockFrom: newBlockFrom,
          activeBlockTo: newBlockTo,
          docVersion: newState.doc,
        };
      },
    },
    props: {
      decorations(state) {
        const s = this.getState(state);
        if (!s) return null;
        return buildDecorationSet(state, s);
      },
    },
  });
});

/**
 * 工具：在外部 dispatch 一次 setSearch，避免每个调用方重复 setMeta。
 */
export function setSearch(
  meta: NonNullable<SearchHighlightMeta["set"]>,
): SearchHighlightMeta {
  return { set: meta };
}

export function clearSearch(): SearchHighlightMeta {
  return { clear: true };
}
