/**
 * source-map 单测。
 *
 *     npx tsx src/editor/search/source-map.test.ts
 *
 * 测什么：
 *   - 普通段落 / heading / list / code_block 的 mdast↔PM 1:1 配对
 *   - runsql code + <detail> 被 detail-merge 合并后，mdast/PM 数量一致
 *   - lineToEntry 的二分查找在边界 / 空行 / 块中间都落到正确 entry
 *   - frontmatter 不进入本测——调用方在传入前已剥掉
 */

import { fileURLToPath } from "node:url";

import { Schema } from "@milkdown/prose/model";
import { EditorState } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";

import { buildLineMap } from "./source-map";

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

function expect(name: string, ok: boolean, detail?: string): Check {
  return { name, ok, detail };
}

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      content: "text*",
      group: "block",
      toDOM: () => ["p", 0] as const,
    },
    heading: {
      content: "text*",
      group: "block",
      attrs: { level: { default: 1 } },
      toDOM: (node) => [`h${node.attrs.level}`, 0] as const,
    },
    code_block: {
      content: "text*",
      group: "block",
      code: true,
      attrs: { language: { default: "" }, detailRaw: { default: null } },
      toDOM: () => ["pre", ["code", 0]] as const,
    },
    bullet_list: {
      content: "list_item+",
      group: "block",
      toDOM: () => ["ul", 0] as const,
    },
    list_item: {
      content: "paragraph block*",
      toDOM: () => ["li", 0] as const,
    },
    text: { group: "inline" },
  },
});

function mockView(docJson: unknown): EditorView {
  const doc = schema.nodeFromJSON(docJson);
  const state = EditorState.create({ doc, schema });
  return { state } as unknown as EditorView;
}

function run(): Check[] {
  const out: Check[] = [];

  // 1) 普通段落 + heading + paragraph 1:1 对齐
  {
    const body = `# Title

First paragraph.

Second paragraph.`;
    // 对应 PM:
    //   heading(1) [pos=0, size=Title+2]
    //   paragraph  [pos=…]
    //   paragraph  [pos=…]
    const view = mockView({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 1 },
          content: [{ type: "text", text: "Title" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "First paragraph." }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Second paragraph." }],
        },
      ],
    });
    const lm = buildLineMap(body, view);
    out.push(
      expect(
        "basic: 3 entries (heading + 2 paragraphs)",
        lm.entries.length === 3,
        `got ${lm.entries.length}`,
      ),
    );
    out.push(
      expect(
        "basic: source lines [1, 3, 5]",
        lm.entries[0].sourceLine === 1 &&
          lm.entries[1].sourceLine === 3 &&
          lm.entries[2].sourceLine === 5,
        `got [${lm.entries.map((e) => e.sourceLine).join(", ")}]`,
      ),
    );
    out.push(
      expect(
        "basic: lineToEntry(2) (blank line) → heading entry",
        lm.lineToEntry(2)?.sourceLine === 1,
      ),
    );
    out.push(
      expect(
        "basic: lineToEntry(3) → first paragraph",
        lm.lineToEntry(3)?.sourceLine === 3,
      ),
    );
    out.push(
      expect(
        "basic: lineToEntry(99) clamped to last entry",
        lm.lineToEntry(99)?.sourceLine === 5,
      ),
    );
  }

  // 2) detail-merge：runsql code + <detail> 合并后，mdast / PM 都是 2 个块
  {
    const body = [
      "Intro paragraph.",
      "",
      "```runsql",
      "SELECT 1",
      "```",
      "<detail>",
      "  <run-date>2026-01-01</run-date>",
      "</detail>",
    ].join("\n");

    const view = mockView({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Intro paragraph." }],
        },
        {
          type: "code_block",
          attrs: { language: "runsql", detailRaw: "<detail>…</detail>" },
          content: [{ type: "text", text: "SELECT 1" }],
        },
      ],
    });
    const lm = buildLineMap(body, view);
    out.push(
      expect(
        "detail-merge: 2 paired entries",
        lm.entries.length === 2,
        `got ${lm.entries.length}`,
      ),
    );
    out.push(
      expect(
        "detail-merge: paragraph at line 1, code at line 3",
        lm.entries[0].sourceLine === 1 && lm.entries[1].sourceLine === 3,
        `got [${lm.entries.map((e) => e.sourceLine).join(", ")}]`,
      ),
    );
    out.push(
      expect(
        "detail-merge: lineToEntry(6) (inside <detail>) → code block",
        lm.lineToEntry(6)?.sourceLine === 3,
      ),
    );
  }

  // 3) list（顶层一个 bullet_list 节点）
  {
    const body = `- item one
- item two
- item three`;
    const view = mockView({
      type: "doc",
      content: [
        {
          type: "bullet_list",
          content: [
            {
              type: "list_item",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "item one" }],
                },
              ],
            },
            {
              type: "list_item",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "item two" }],
                },
              ],
            },
            {
              type: "list_item",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "item three" }],
                },
              ],
            },
          ],
        },
      ],
    });
    const lm = buildLineMap(body, view);
    out.push(
      expect("list: 1 entry (the whole list)", lm.entries.length === 1),
    );
    out.push(
      expect(
        "list: lineToEntry(2) → the list block at line 1",
        lm.lineToEntry(2)?.sourceLine === 1,
      ),
    );
  }

  // 4) lineToPmPos 返回非叶 block 的内容起点 = pmPos + 1
  {
    const body = "Hello world";
    const view = mockView({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Hello world" }],
        },
      ],
    });
    const lm = buildLineMap(body, view);
    out.push(
      expect(
        "lineToPmPos: paragraph content start at pos 1",
        lm.lineToPmPos(1) === 1,
        `got ${lm.lineToPmPos(1)}`,
      ),
    );
  }

  // 5) 空 body
  {
    const view = mockView({
      type: "doc",
      content: [{ type: "paragraph" }],
    });
    const lm = buildLineMap("", view);
    out.push(
      expect(
        "empty body: entries length defined (mdast parses as no children, PM has one paragraph) → warns + 0 paired",
        lm.entries.length === 0,
      ),
    );
    out.push(
      expect("empty body: lineToEntry(1) returns null", lm.lineToEntry(1) === null),
    );
  }

  return out;
}

function main(): void {
  const checks = run();
  let failed = 0;
  for (const c of checks) {
    if (c.ok) {
      console.log(`[ok]   ${c.name}`);
    } else {
      failed += 1;
      console.log(`[FAIL] ${c.name}${c.detail ? `\n       ${c.detail}` : ""}`);
    }
  }
  if (failed > 0) {
    console.error(`\nsearch/source-map tests FAILED (${failed}).`);
    process.exit(1);
  }
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  fileURLToPath(import.meta.url) === process.argv[1]
) {
  main();
}
