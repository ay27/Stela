/**
 * Source-line ↔ ProseMirror pos 双向映射。
 *
 * 背景：vault 搜索按磁盘原文产出 1-based `(line, column)`，而 Milkdown 渲染后只有
 * ProseMirror pos 才是唯一可靠的定位坐标。本模块负责"在 mount 完成的一瞬"把这两套
 * 坐标对齐：
 *
 *   1. 用 remark 把 markdown body 解析为 mdast；
 *   2. 应用 stela 自家的 remark-detail-merge 让顶层 block 列表与 Milkdown PM
 *      转换后的实际结构对齐（runsql code + `<detail>` 合并为一个 code 节点）；
 *   3. 把 mdast `tree.children[i].position.start.line` 与 `view.state.doc` 顶层
 *      第 i 个子节点的 `(pos, nodeSize)` 1:1 配对。
 *
 * 仅做"顶层 block 起点的对齐"。列内偏移（同一段落里的第 N 个字符）不在本表内做，
 * 由 locator 在拿到 entry 后按 `node.textContent` 兜底走，且 keyword 路径根本绕开
 * 行号——所以本表的精度对主用例（按 keyword + nthInFile 跳转）没有影响。
 *
 * 编辑后 line map 会过期：调用方（MilkdownEditor）只在 `initialRaw` / `reloadToken`
 * 变化时重建。这是已接受的取舍——编辑中的 keyword 路径走 live PM doc，仍然准。
 */

import type { Code, Html, Root, RootContent } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { EditorView } from "@milkdown/prose/view";

import { matchDetail } from "@/editor/runsql/detail-meta";

export interface LineMapEntry {
  /** 顶层 block 在 mdast / PM 中的 0-based 索引（配对成功部分一致）。 */
  index: number;
  /** 1-based body source line（不含 frontmatter）。 */
  sourceLine: number;
  /** mdast 节点的 end.line；用于二分查找时判断"行号是否仍在该块内"。 */
  sourceEndLine: number;
  /** PM doc 中该顶层 block 的起始 pos（即 `doc.forEach((node, offset)=>…)` 的 offset）。 */
  pmPos: number;
  /** PM 顶层 block 的 `nodeSize`；block 占据 `[pmPos, pmPos + pmNodeSize)`。 */
  pmNodeSize: number;
  /** PM 节点类型名（heading / paragraph / code_block / bullet_list / …）。 */
  pmType: string;
  /** mdast 节点类型（heading / paragraph / code / list / blockquote / html / …）。 */
  mdastType: string;
}

export interface LineMap {
  /** 顶层 block 表，按 sourceLine 升序。 */
  entries: LineMapEntry[];
  /** body 总行数（用于做范围保护）。 */
  bodyTotalLines: number;
  /**
   * 给定 1-based body 行号，返回该行所在的顶层 block entry。
   * 行号落在两个 block 之间的空行 → 归属上一个 block。
   * 行号越界 → 钳到首/尾 entry。
   */
  lineToEntry(bodyLine: number): LineMapEntry | null;
  /**
   * 给定 1-based body 行号，返回 PM 中该 block 起点的"内容位置"
   * （非叶节点为 pmPos+1，叶节点为 pmPos）。命中失败返回 null。
   */
  lineToPmPos(bodyLine: number): number | null;
  /**
   * 给定 1-based body `line + column`，尽力返回 PM pos。第一版仅按块定位，column
   * 用于将来扩展（marks/inline 在 PM 中常与源码 column 错位，需要专门处理）。
   */
  lineColumnToPmPos(
    bodyLine: number,
    bodyColumn?: number,
  ): { from: number; to: number } | null;
}

/**
 * 复制 [src/editor/runsql/remark-detail-merge.ts](src/editor/runsql/remark-detail-merge.ts)
 * 的核心逻辑（无副作用、不读 Milkdown ctx），在我们自己解析 mdast 时同样合并 `<detail>`，
 * 保证 mdast 顶层 children 数量与 PM doc 顶层 children 数量一致。
 */
function applyDetailMerge(tree: Root): void {
  const children = tree.children as RootContent[];
  for (let i = 0; i < children.length; i += 1) {
    const node = children[i];
    if (node.type !== "code" || (node as Code).lang !== "runsql") continue;
    const next = children[i + 1];
    if (!next || next.type !== "html") continue;
    const matched = matchDetail((next as Html).value);
    if (!matched) continue;
    children.splice(i + 1, 1);
  }
}

/**
 * 构建 LineMap。`body` 应该是已剥掉 frontmatter 的 markdown 正文（与 Milkdown
 * 实际接收的内容一致）。`view` 必须已经完成 mount。
 *
 * 失败（mdast 与 PM 顶层数量对不上）时仍返回一个尽力配对的表 + 一个 console.warn，
 * 不抛错——保证 reveal 失败时回退到 PM 自带搜索，不至于把编辑器整个崩掉。
 */
export function buildLineMap(body: string, view: EditorView): LineMap {
  const processor = unified().use(remarkParse);
  const tree = processor.parse(body) as Root;
  applyDetailMerge(tree);

  const mdastChildren = tree.children;
  const pmBlocks: Array<{ pos: number; size: number; type: string }> = [];
  view.state.doc.forEach((node, offset) => {
    pmBlocks.push({ pos: offset, size: node.nodeSize, type: node.type.name });
  });

  if (mdastChildren.length !== pmBlocks.length) {
    console.warn(
      "[stela] source-map: mdast/PM top-level block count mismatch",
      { mdastCount: mdastChildren.length, pmCount: pmBlocks.length },
    );
  }

  const pairCount = Math.min(mdastChildren.length, pmBlocks.length);
  const entries: LineMapEntry[] = [];
  for (let i = 0; i < pairCount; i += 1) {
    const m = mdastChildren[i];
    const p = pmBlocks[i];
    const startLine = m.position?.start.line ?? 1;
    const endLine = m.position?.end.line ?? startLine;
    entries.push({
      index: i,
      sourceLine: startLine,
      sourceEndLine: endLine,
      pmPos: p.pos,
      pmNodeSize: p.size,
      pmType: p.type,
      mdastType: m.type,
    });
  }

  const bodyTotalLines = body.split("\n").length;

  function lineToEntry(bodyLine: number): LineMapEntry | null {
    if (entries.length === 0) return null;
    const line = Math.max(1, Math.min(bodyTotalLines, bodyLine));
    let lo = 0;
    let hi = entries.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (entries[mid].sourceLine <= line) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return entries[ans] ?? null;
  }

  function lineToPmPos(bodyLine: number): number | null {
    const e = lineToEntry(bodyLine);
    if (!e) return null;
    return contentStartOf(view, e);
  }

  function lineColumnToPmPos(
    bodyLine: number,
    _bodyColumn?: number,
  ): { from: number; to: number } | null {
    const e = lineToEntry(bodyLine);
    if (!e) return null;
    const from = contentStartOf(view, e);
    const to = from;
    return { from, to };
  }

  return {
    entries,
    bodyTotalLines,
    lineToEntry,
    lineToPmPos,
    lineColumnToPmPos,
  };
}

/**
 * 返回 entry 对应顶层 block 的"内容起点"：非叶节点 = pmPos + 1，叶节点 = pmPos。
 * 用 `view.state.doc.nodeAt(pmPos)` 判断是否 leaf。
 */
function contentStartOf(view: EditorView, entry: LineMapEntry): number {
  const node = view.state.doc.nodeAt(entry.pmPos);
  if (!node) return entry.pmPos;
  return node.isLeaf ? entry.pmPos : entry.pmPos + 1;
}
