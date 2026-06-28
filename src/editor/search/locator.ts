/**
 * 统一 reveal 定位器。
 *
 * 把"打开文件并定位到 X"的多种来源（搜索面板 keyword、TOC slug、命令面板 line）收敛
 * 为单一返回类型 `{ from, to } | null`。所有调用方拿到 PM pos 范围后用
 *   view.dispatch(tr.setSelection(Selection.near(doc.resolve(from))).scrollIntoView())
 * 滚动；不再走 DOM `scrollIntoView`、不再算 host 内绝对坐标、不再启发式块映射。
 *
 * 三条路径的取舍：
 *   1. `keyword + nthInFile` 主路径：走 live PM doc，编辑后仍然准；
 *   2. `slug` 次路径：复用 [heading-anchor](../heading-anchor/index.ts) 同款 slug 算法，
 *      在 live PM doc 上找 heading；
 *   3. `line+column` 兜底：用 [./source-map.ts](./source-map.ts) 的 LineMap 落到对应
 *      顶层 block 起点；编辑后会过期，但所有上游 caller 都会在 dirty 时改走 keyword 路径。
 *
 * 设计原则：永远不抛错。命中失败一律返回 null，调用方决定要不要静默丢弃 / 给 console 提示。
 */

import type { Node as ProseNode } from "@milkdown/prose/model";
import type { EditorView } from "@milkdown/prose/view";

import { buildSlugs } from "@/editor/heading-anchor/slug";

import type { LineMap, LineMapEntry } from "./source-map";

export interface RevealRange {
  /** PM 起点 pos（inclusive）。 */
  from: number;
  /** PM 终点 pos（exclusive，等于 from 表示空选区）。 */
  to: number;
  /**
   * 该 range 命中的顶层 block 的 PM pos。flash 闪动需要给整个 block 加 class。
   * 对 keyword 路径，从 `view.state.doc.resolve(from).before(1)` 反推（顶层 block 始终是
   * depth=1 的 ancestor）；对 line/slug 路径直接给 entry.pmPos 或 heading pos。
   */
  blockPos: number;
  /**
   * 来源 RevealLoc 的 kind，便于 UI 决定视觉层级：
   *   - keyword：精确到字符级，active 装饰用 inline 高亮
   *   - line：精确到 block 级，active 装饰整块描边
   *   - slug：同 line
   */
  kind: "keyword" | "slug" | "line";
}

export type RevealLoc =
  | { kind: "line"; bodyLine: number; bodyColumn?: number }
  | { kind: "slug"; slug: string }
  | {
      kind: "keyword";
      keyword: string;
      nthInFile: number;
      caseSensitive?: boolean;
    };

/**
 * 在 PM doc 内顺序找到所有 `keyword` 命中（按 doc pos 升序）。
 *
 * 走 `doc.descendants` 的 text node，每个 text node 内做 `indexOf` 累积。**不跨 text node
 * 匹配**——marks 边界（bold/italic/code）会把同一段源码切成多个 text node，跨边界的
 * 命中暂时丢失；与 vault 行级搜索一致，绝大多数 markdown 文本不会触发。
 */
export function findKeywordMatches(
  view: EditorView,
  keyword: string,
  caseSensitive: boolean,
): RevealRange[] {
  if (!keyword) return [];
  const needle = caseSensitive ? keyword : keyword.toLowerCase();
  if (needle.length === 0) return [];

  const matches: RevealRange[] = [];
  view.state.doc.descendants((node: ProseNode, pos: number) => {
    if (!node.isText) return true;
    const text = node.text ?? "";
    const hay = caseSensitive ? text : text.toLowerCase();
    let cursor = 0;
    while (cursor <= hay.length) {
      const idx = hay.indexOf(needle, cursor);
      if (idx < 0) break;
      const from = pos + idx;
      const to = from + needle.length;
      matches.push({
        from,
        to,
        blockPos: blockPosOf(view, from),
        kind: "keyword",
      });
      cursor = idx + Math.max(1, needle.length);
    }
    return true;
  });
  return matches;
}

/**
 * 在 PM doc 内按 slug 找到对应 heading。slug 计算复用 heading-anchor 的同款算法，
 * 确保与 `data-heading-slug` 装饰一致。
 */
function findHeadingBySlug(
  view: EditorView,
  slug: string,
): RevealRange | null {
  const positions: number[] = [];
  const texts: string[] = [];
  view.state.doc.forEach((node: ProseNode, offset: number) => {
    if (node.type.name === "heading") {
      positions.push(offset);
      texts.push(node.textContent);
    }
  });
  if (positions.length === 0) return null;
  const slugs = buildSlugs(texts);
  const i = slugs.indexOf(slug);
  if (i < 0) return null;
  const pos = positions[i];
  const node = view.state.doc.nodeAt(pos);
  if (!node) return null;
  const contentStart = node.isLeaf ? pos : pos + 1;
  return {
    from: contentStart,
    to: contentStart,
    blockPos: pos,
    kind: "slug",
  };
}

function lineEntryToRange(
  view: EditorView,
  entry: LineMapEntry,
): RevealRange {
  const node = view.state.doc.nodeAt(entry.pmPos);
  const contentStart = node && !node.isLeaf ? entry.pmPos + 1 : entry.pmPos;
  return {
    from: contentStart,
    to: contentStart,
    blockPos: entry.pmPos,
    kind: "line",
  };
}

/**
 * 找出 `from` 所在的顶层 block 起始 pos。
 *
 * `doc.resolve(from)` 在 depth=0 就是 doc 自身，depth=1 是顶层 block。用 `before(1)`
 * 拿顶层 block 的起始 pos。极端情况（from 落在 doc boundary）退化为 0。
 */
function blockPosOf(view: EditorView, from: number): number {
  try {
    const $pos = view.state.doc.resolve(from);
    if ($pos.depth >= 1) return $pos.before(1);
  } catch {
    /* fall through */
  }
  return 0;
}

/**
 * 主入口：把 RevealLoc 解成 PM 范围。
 *
 * keyword 路径：找全部命中后取第 `nthInFile`。如果 PM 命中数比 vault 端少（典型场景：
 * `<detail>` 被合并、被 marks 切碎），会**回退**到 line+column 路径——前提是 caller
 * 同时提供了 fallback line（在 OpenFileOptions / PendingReveal 里 line/column 与
 * keyword/nthInFile 并存）。caller 决定要不要拼，locator 只暴露纯函数。
 */
export function resolveReveal(
  view: EditorView,
  lineMap: LineMap | null,
  loc: RevealLoc,
): RevealRange | null {
  switch (loc.kind) {
    case "keyword": {
      const matches = findKeywordMatches(
        view,
        loc.keyword,
        loc.caseSensitive ?? false,
      );
      if (matches.length === 0) return null;
      // 严格按索引返回。如果 nthInFile 超过 PM 内可见的命中数（例如 vault 命中
      // 落在 `<detail>` 行、被 remark-detail-merge 吸走，PM doc 没该文本），返回
      // null 让 caller 走 line 兜底——不要悄悄 clamp 到最后一个匹配，否则 active
      // 高亮会画在错误的位置。
      if (loc.nthInFile < 0 || loc.nthInFile >= matches.length) return null;
      return matches[loc.nthInFile] ?? null;
    }
    case "slug":
      return findHeadingBySlug(view, loc.slug);
    case "line": {
      if (!lineMap) return null;
      const entry = lineMap.lineToEntry(loc.bodyLine);
      if (!entry) return null;
      return lineEntryToRange(view, entry);
    }
    default: {
      const _exhaustive: never = loc;
      return _exhaustive;
    }
  }
}
