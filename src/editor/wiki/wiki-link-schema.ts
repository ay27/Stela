/**
 * Wiki link inline node schema（v0.3 M1）。
 *
 * 表示 `[[target]]` 或 `[[target|alias]]`，作为 ProseMirror 行内 atom 节点存在；
 * 配合 [./remark-wiki-link.ts](./remark-wiki-link.ts) 把 mdast text 中匹配
 * 到的片段替换为 `wikiLink` 类型的 mdast 节点，再由本 schema 的 parseMarkdown
 * runner 接管转成 prose 节点。
 *
 * 序列化：toMarkdown 输出 `text` 类型 mdast 节点，内容为 `[[target|alias]]`
 * 字面量。这样 round-trip 不需要给 remark-stringify 注册新类型，下一次解析
 * 又会被 remark transformer 重新切回 wikiLink 节点。
 */
import { $node } from "@milkdown/utils";

interface WikiLinkMarkdownNode {
  type: "wikiLink";
  target?: string;
  alias?: string | null;
}

const ATTR_DATA_FLAG = "data-stela-wiki";
const ATTR_DATA_TARGET = "data-target";
const ATTR_DATA_ALIAS = "data-alias";
const ATTR_DATA_RESOLVED = "data-resolved";

export const WIKI_LINK_NODE_NAME = "stela_wiki_link";

export const wikiLinkSchema = $node(WIKI_LINK_NODE_NAME, () => ({
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  attrs: {
    target: { default: "" },
    alias: { default: null as string | null },
    // 渲染时由 NodeView 异步探测后写回的解析状态：
    //   "unknown"  初始 / 还没探测
    //   "resolved" 候选文件存在
    //   "missing"  候选文件都不存在
    // 仅 UI 用，toMarkdown 不会输出它。
    resolved: { default: "unknown" as "unknown" | "resolved" | "missing" },
  },
  parseDOM: [
    {
      tag: `span[${ATTR_DATA_FLAG}]`,
      getAttrs: (dom) => {
        if (!(dom instanceof HTMLElement)) return false;
        return {
          target: dom.getAttribute(ATTR_DATA_TARGET) ?? "",
          alias: dom.getAttribute(ATTR_DATA_ALIAS) ?? null,
          resolved: dom.getAttribute(ATTR_DATA_RESOLVED) ?? "unknown",
        };
      },
    },
  ],
  toDOM: (node) => {
    const target = node.attrs.target as string;
    const alias = node.attrs.alias as string | null;
    const resolved = node.attrs.resolved as string;
    return [
      "span",
      {
        [ATTR_DATA_FLAG]: "",
        [ATTR_DATA_TARGET]: target,
        ...(alias ? { [ATTR_DATA_ALIAS]: alias } : {}),
        [ATTR_DATA_RESOLVED]: resolved,
        class: `stela-wiki stela-wiki--${resolved}`,
        title: alias ? `${alias} → ${target}` : target,
      },
      alias && alias.length > 0 ? alias : target,
    ];
  },
  parseMarkdown: {
    match: (node) => node.type === "wikiLink",
    runner: (state, node, type) => {
      const wiki = node as unknown as WikiLinkMarkdownNode;
      const target = (wiki.target ?? "").trim();
      const alias = wiki.alias ? wiki.alias.trim() : null;
      // ParserState.addNode 签名：(nodeType, attrs?, content?) —— 注意它不是
      // SerializerState.addNode（后者是 type:string + 4 个参数），两边别串。
      state.addNode(type, {
        target,
        alias: alias && alias.length > 0 ? alias : null,
        resolved: "unknown",
      });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === WIKI_LINK_NODE_NAME,
    runner: (state, node) => {
      const target = (node.attrs.target as string) ?? "";
      const alias = node.attrs.alias as string | null;
      const literal =
        alias && alias.length > 0 ? `[[${target}|${alias}]]` : `[[${target}]]`;
      // mdast `text` 节点直接把 [[…]] 当字面量保留；下次解析时由 remark
      // transformer 再次切成 wikiLink 节点。这样既不必给 remark stringify
      // 注册新类型，又不会和 commonmark 链接 / 强调等已有语法冲突——
      // [[ 和 ]] 不是 commonmark 的特殊字符，stringify 会按字面输出。
      state.addNode("text", undefined, literal);
    },
  },
}));
