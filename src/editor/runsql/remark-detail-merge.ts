/**
 * Remark transformer：把紧跟 ` ```runsql ` 代码块后的 `<detail>` HTML 块吸附到 code
 * 节点的 `data` 上，得到的形态是单个 `code` 节点 + 三条额外字段：
 *   - `data.detailRaw`：原始 `<detail>...</detail>` 文本，用于无损 round-trip
 *   - `data.detail`：解析后的结构化 DetailMeta，给 RunSQL UI 使用
 *   - `data.blockId`：detail 内 `<block-id>` 解析结果，没有就空串
 *
 * 我们没有自定义 mdast 节点（保持 mdast 仍然是合法的 commonmark mdast），只是借助
 * mdast 的 `data` 槽位把元信息携带到 ProseMirror 转换阶段；commonmark 的 `code_block`
 * schema 在本工程被 [./stela-codeblock-schema.ts](./stela-codeblock-schema.ts) 扩展过，
 * parseMarkdown runner 会把 `data.detail*` 取下来灌进 prose 节点 attrs。
 *
 * 实现细节（踩过的坑）：曾经用 `$remark()` 包装，发现 schema plugin（reduce remark
 * processor）和 `$remark` plugin 都 `await InitReady`，按 microtask 排队顺序往往是
 * schema 先 resume；schema 只 reduce 一次，得到的 processor 里就**没有**我们的
 * transformer，结果 mdast 的 `code.data` 永远是空。这里改为最朴素的 MilkdownPlugin：
 * 在 plugin 同步阶段直接 `ctx.update(remarkPluginsCtx, ...)`，确保 schema reduce 之前
 * transformer 已就位。
 */
import type { MilkdownPlugin } from "@milkdown/ctx";
import { remarkPluginsCtx } from "@milkdown/core";
import type { RemarkPlugin } from "@milkdown/transformer";
import type { Code, Html, Root, RootContent } from "mdast";

import { matchDetail, parseDetail } from "./detail-meta";
import type { DetailMeta } from "@/core/types";

interface MergedCodeData {
  detail?: DetailMeta;
  detailRaw?: string;
  blockId?: string;
}

const detailMergeTransformer = () => (tree: Root) => {
  const children = tree.children as RootContent[];
  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    if (!isRunsqlCode(node)) continue;

    const next = children[i + 1];
    if (!next || next.type !== "html") continue;
    const matched = matchDetail((next as Html).value);
    if (!matched) continue;

    const detail = parseDetail(matched.inner);
    const data = (node.data ?? {}) as MergedCodeData;
    data.detailRaw = matched.full;
    data.detail = detail;
    data.blockId = detail.blockId ?? "";
    node.data = data as Code["data"];

    children.splice(i + 1, 1);
  }
};

const remarkPluginEntry: RemarkPlugin = {
  plugin: detailMergeTransformer,
  options: {},
};

export const remarkDetailMerge: MilkdownPlugin = (ctx) => {
  ctx.update(remarkPluginsCtx, (rp) => {
    if (rp.includes(remarkPluginEntry)) return rp;
    return [...rp, remarkPluginEntry];
  });
  return () => {
    return () => {
      ctx.update(remarkPluginsCtx, (rp) =>
        rp.filter((x) => x !== remarkPluginEntry),
      );
    };
  };
};

function isRunsqlCode(node: RootContent): node is Code {
  return node.type === "code" && (node as Code).lang === "runsql";
}
