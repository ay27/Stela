/**
 * Remark transformer：把 mdast 树中 text 节点里的 `[[target]]` /
 * `[[target|alias]]` 片段切出来，替换为自定义类型 `wikiLink` 的 mdast 节点，
 * 配合 [./wiki-link-schema.ts](./wiki-link-schema.ts) 的 parseMarkdown runner
 * 转换为 ProseMirror 行内 atom 节点。
 *
 * 实现：用 `mdast-util-find-and-replace`，能自动跳过 `code` / `inlineCode`
 * 节点（在 ignore 列表里），不会误把代码块内的 `[[` 误读为 wiki link。
 *
 * 注册方式与 remark-detail-merge 一致——同步阶段 push 到 `remarkPluginsCtx`，
 * 否则会被 schema reduce 抢跑（详见 [./../runsql/remark-detail-merge.ts](../runsql/remark-detail-merge.ts) 注释）。
 */
import type { MilkdownPlugin } from "@milkdown/ctx";
import { remarkPluginsCtx } from "@milkdown/core";
import type { RemarkPlugin } from "@milkdown/transformer";
import type { PhrasingContent, Root } from "mdast";
import { findAndReplace } from "mdast-util-find-and-replace";

// 允许中文 / 空格 / `/` / `.` / `-` / `_` 等常见字符；禁止 `[` `]` `|` `\n`。
// 区分两个捕获组：target 与可选 alias。整体非贪婪。
//
// 注意：findAndReplace 会把每个 text 节点单独喂进来，匹配前已经做过 escape 处理。
const WIKI_RE = /\[\[([^\[\]\|\r\n]+?)(?:\|([^\[\]\r\n]+?))?\]\]/g;

interface WikiLinkMdast {
  type: "wikiLink";
  target: string;
  alias: string | null;
  data: {
    /** mdast→hast 时的占位；hast 转 HTML 我们走 prose 渲染层不依赖这里。 */
    hName: "span";
    hProperties: { className: string[]; "data-stela-wiki": "" };
    hChildren: Array<{ type: "text"; value: string }>;
  };
}

const wikiLinkTransformer = () => (tree: Root) => {
  findAndReplace(
    tree,
    [
      [
        WIKI_RE,
        (_match: string, rawTarget: string, rawAlias?: string) => {
          const target = (rawTarget ?? "").trim();
          if (!target) return false;
          const alias = rawAlias ? rawAlias.trim() : "";
          const display = alias.length > 0 ? alias : target;
          const node: WikiLinkMdast = {
            type: "wikiLink",
            target,
            alias: alias.length > 0 ? alias : null,
            data: {
              hName: "span",
              hProperties: {
                className: ["stela-wiki"],
                "data-stela-wiki": "",
              },
              hChildren: [{ type: "text", value: display }],
            },
          };
          // wikiLink 不在 mdast 标准 PhrasingContent 联合里，但
          // findAndReplace 内部只是把回调返回值塞进 parent.children；
          // 后续也只有我们自己的 schema parseMarkdown 匹配它，安全。
          return node as unknown as PhrasingContent;
        },
      ],
    ],
    { ignore: ["code", "inlineCode"] },
  );
};

const remarkPluginEntry: RemarkPlugin = {
  plugin: wikiLinkTransformer,
  options: {},
};

export const remarkWikiLink: MilkdownPlugin = (ctx) => {
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
