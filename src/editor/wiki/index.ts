/**
 * v0.3 双链 `[[wiki]]` 编辑器扩展（M1：解析 + 跳转）。
 *
 * 注册顺序：
 *   1. `wikiLinkSchema`   —— 用 `$node` 注册新行内 atom 节点 `stela_wiki_link`
 *   2. `remarkWikiLink`   —— 在 `remarkPluginsCtx` 同步 push 一个 transformer，
 *                            解析阶段把 `[[…]]` 文本切成 mdast `wikiLink` 节点；
 *                            schema 的 parseMarkdown 接管转 prose
 *   3. `wikiLinkView`     —— 把 NodeView 绑到新节点类型上
 *
 * 与 RunSQL 体系的关系：完全独立。RunSQL 通过覆盖 `code_block` schema；wiki link
 * 是新增节点类型，不动现有 schema。
 */
import { $view } from "@milkdown/utils";
import type { MilkdownPlugin } from "@milkdown/ctx";
import type { NodeViewConstructor } from "@milkdown/prose/view";

import { remarkWikiLink } from "./remark-wiki-link";
import { wikiAutocompletePlugin } from "./wiki-autocomplete-plugin";
import { wikiLinkSchema } from "./wiki-link-schema";
import { WikiLinkNodeView } from "./wiki-link-nodeview";

const wikiLinkViewCtor: NodeViewConstructor = (node, view) =>
  new WikiLinkNodeView(node, view);

// 注意：`$node()` 直接返回 `$Node`（含 `.type` getter），不像 `$nodeSchema` 那样
// 还包一层 `.node`。因此 `$view` 的第一个泛型 / 参数都直接用 wikiLinkSchema 自己。
export const wikiLinkView = $view<typeof wikiLinkSchema, NodeViewConstructor>(
  wikiLinkSchema,
  () => wikiLinkViewCtor,
);

export const wikiLinkPlugins: MilkdownPlugin[] = [
  wikiLinkSchema,
  remarkWikiLink,
  wikiLinkView,
  wikiAutocompletePlugin,
].flat();

export { clearWikiResolverCache, resolveWikiTarget } from "./wiki-resolver";
export { WIKI_LINK_NODE_NAME } from "./wiki-link-schema";
