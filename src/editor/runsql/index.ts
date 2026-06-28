import { $view } from "@milkdown/utils";
import type { MilkdownPlugin } from "@milkdown/ctx";
import type { NodeViewConstructor } from "@milkdown/prose/view";

import { CodeBlockNodeView } from "./codeblock-nodeview";
import { remarkDetailMerge } from "./remark-detail-merge";
import { stelaCodeBlockSchema } from "./stela-codeblock-schema";

/**
 * RunSQL 编辑器扩展集合。负责把 mdast `<detail>` 吸附到 codeBlock attrs，并把
 * `code_block` NodeView 替换为 [./codeblock-nodeview.ts](./codeblock-nodeview.ts)。
 *
 * 注册顺序很重要：
 *  - `stelaCodeBlockSchema` 必须在 commonmark preset 之后 use，靠 id 同名覆盖默认 schema
 *  - `remarkDetailMerge` 是普通 `MilkdownPlugin`，**同步阶段**直接 push 进
 *    `remarkPluginsCtx`；不能用 `$remark()`，否则会被 `schema` plugin 抢跑、reduce
 *    时拿不到我们的 transformer，详见 docs/memory.md 2026-04-19 条目
 *  - `stelaCodeBlockView` 绑在新 schema.node 上，注册到 SchemaCtx 的 viewCtx
 *
 * 第二个泛型显式 `NodeViewConstructor` 是因为 `$view` 在 `$Node | $Mark` 联合上推断
 * 会误归到 MarkView。
 */
const codeBlockView: NodeViewConstructor = (node, view, getPos) =>
  new CodeBlockNodeView(node, view, getPos);

export const stelaCodeBlockView = $view<
  typeof stelaCodeBlockSchema.node,
  NodeViewConstructor
>(stelaCodeBlockSchema.node, () => codeBlockView);

export const runSqlPlugins: MilkdownPlugin[] = [
  stelaCodeBlockSchema,
  remarkDetailMerge,
  stelaCodeBlockView,
].flat();

