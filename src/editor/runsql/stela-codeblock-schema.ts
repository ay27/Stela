/**
 * 把 commonmark 内置的 `code_block` 节点 schema 扩展为携带 detail 元信息的版本：
 *   - 多三个 attrs：`detail`、`detailRaw`、`blockId`
 *   - parseMarkdown：从 mdast `code` 节点的 `data` 槽取出 detail*，写入 prose attrs
 *   - toMarkdown：除了正常输出 fenced code，还会在 attrs.detailRaw 存在时追加一个 html
 *     节点，让 remark stringify 输出 `<detail>...</detail>`，与原文保持等价
 *
 * 用法：在 commonmark preset 之后、`$view(codeBlockSchema.node, ...)` 之前 use 这个
 * schema 覆盖（同 id 后注册者覆盖前注册者）。
 */
import { codeBlockSchema } from "@milkdown/preset-commonmark";
import type { Code } from "mdast";

import type { DetailMeta } from "@/core/types";

interface CodeData {
  detail?: DetailMeta | null;
  detailRaw?: string | null;
  blockId?: string;
}

export const stelaCodeBlockSchema = codeBlockSchema.extendSchema(
  (prev) => (ctx) => {
    const orig = prev(ctx);
    return {
      ...orig,
      attrs: {
        ...orig.attrs,
        detail: { default: null },
        detailRaw: { default: null },
        blockId: { default: "" },
        // 临时 UI 属性：runState 用于驱动 Run 按钮的 idle/running/error 渲染。
        // toMarkdown 不输出它，所以 round-trip 不会受影响；parseMarkdown 也不会写它。
        runState: { default: "idle" },
      },
      parseMarkdown: {
        ...orig.parseMarkdown,
        runner: (state, node, type) => {
          const code = node as unknown as Code;
          const language = code.lang ?? "";
          const value = (code.value as string | null) ?? null;
          const data = (code.data ?? {}) as CodeData;
          state.openNode(type, {
            language,
            detail: data.detail ?? null,
            detailRaw:
              typeof data.detailRaw === "string" ? data.detailRaw : null,
            blockId: typeof data.blockId === "string" ? data.blockId : "",
            runState: "idle",
          });
          if (value) state.addText(value);
          state.closeNode();
        },
      },
      toMarkdown: {
        ...orig.toMarkdown,
        runner: (state, node) => {
          const value = node.content.firstChild?.text || "";
          state.addNode("code", undefined, value, {
            lang: node.attrs.language,
          });
          const detailRaw = node.attrs.detailRaw as string | null | undefined;
          if (detailRaw) {
            state.addNode("html", undefined, detailRaw);
          }
        },
      },
    };
  },
);
