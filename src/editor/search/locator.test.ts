/**
 * locator 单测。
 *
 *     npx tsx src/editor/search/locator.test.ts
 *
 * 覆盖三条 RevealLoc 分支：
 *   - keyword + nthInFile：PM doc.descendants 找第 N 个匹配
 *   - slug：复用 buildSlugs 在 heading 文本上找
 *   - line：lineMap 提供时按行号兜底
 * 同时验证 keyword 路径在索引越界时返回 null（让 caller 走 line fallback）。
 */

import { fileURLToPath } from "node:url";

import { Schema } from "@milkdown/prose/model";
import { EditorState } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";

import { findKeywordMatches, resolveReveal } from "./locator";
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
      attrs: { language: { default: "" } },
      toDOM: () => ["pre", ["code", 0]] as const,
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

  // 1) keyword: 三段段落都含 "foo"，按 doc 顺序 nthInFile=0/1/2 对应递增 pos
  {
    const view = mockView({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "foo bar" }] },
        { type: "paragraph", content: [{ type: "text", text: "baz foo" }] },
        { type: "paragraph", content: [{ type: "text", text: "foo foo" }] },
      ],
    });
    const matches = findKeywordMatches(view, "foo", false);
    out.push(
      expect(
        "keyword: doc.descendants finds 4 matches",
        matches.length === 4,
        `got ${matches.length}`,
      ),
    );
    out.push(
      expect(
        "keyword: matches sorted by pos asc",
        matches.every((m, i) => i === 0 || m.from > matches[i - 1].from),
      ),
    );

    const r0 = resolveReveal(view, null, {
      kind: "keyword",
      keyword: "foo",
      nthInFile: 0,
      caseSensitive: false,
    });
    out.push(
      expect(
        "keyword: nthInFile=0 → first match",
        r0?.from === matches[0].from && r0?.to === matches[0].to,
      ),
    );

    const r2 = resolveReveal(view, null, {
      kind: "keyword",
      keyword: "foo",
      nthInFile: 2,
      caseSensitive: false,
    });
    out.push(
      expect(
        "keyword: nthInFile=2 → third match",
        r2?.from === matches[2].from,
      ),
    );

    const r9 = resolveReveal(view, null, {
      kind: "keyword",
      keyword: "foo",
      nthInFile: 99,
      caseSensitive: false,
    });
    out.push(
      expect(
        "keyword: out-of-range nthInFile → null (caller falls back)",
        r9 === null,
      ),
    );

    const caseHit = resolveReveal(view, null, {
      kind: "keyword",
      keyword: "FOO",
      nthInFile: 0,
      caseSensitive: false,
    });
    out.push(
      expect(
        "keyword: case insensitive matches lowercase doc",
        caseHit?.from === matches[0].from,
      ),
    );

    const caseMiss = resolveReveal(view, null, {
      kind: "keyword",
      keyword: "FOO",
      nthInFile: 0,
      caseSensitive: true,
    });
    out.push(
      expect("keyword: case sensitive misses lower-case doc", caseMiss === null),
    );
  }

  // 2) slug: heading "Hello World" → slug "hello-world"
  {
    const view = mockView({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 1 },
          content: [{ type: "text", text: "Hello World" }],
        },
        { type: "paragraph", content: [{ type: "text", text: "body text" }] },
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Hello World" }],
        },
      ],
    });
    const r = resolveReveal(view, null, { kind: "slug", slug: "hello-world" });
    out.push(expect("slug: finds first heading", r !== null && r.kind === "slug"));

    const r2 = resolveReveal(view, null, {
      kind: "slug",
      slug: "hello-world-1",
    });
    out.push(
      expect(
        "slug: dedup suffix points to second heading",
        r2 !== null && r2.from > (r?.from ?? 0),
      ),
    );

    const miss = resolveReveal(view, null, {
      kind: "slug",
      slug: "no-such-slug",
    });
    out.push(expect("slug: missing slug → null", miss === null));
  }

  // 3) line: lineMap 提供时按行号落到对应顶层 block
  {
    const body = `Paragraph A.

Paragraph B.

Paragraph C.`;
    const view = mockView({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Paragraph A." }] },
        { type: "paragraph", content: [{ type: "text", text: "Paragraph B." }] },
        { type: "paragraph", content: [{ type: "text", text: "Paragraph C." }] },
      ],
    });
    const lm = buildLineMap(body, view);
    const r1 = resolveReveal(view, lm, { kind: "line", bodyLine: 1 });
    const r3 = resolveReveal(view, lm, { kind: "line", bodyLine: 3 });
    const r5 = resolveReveal(view, lm, { kind: "line", bodyLine: 5 });
    out.push(
      expect(
        "line: bodyLine 1/3/5 落到三段段落的 pmPos 升序",
        r1 !== null &&
          r3 !== null &&
          r5 !== null &&
          r1.from < r3.from &&
          r3.from < r5.from,
      ),
    );
    out.push(
      expect("line: bodyLine=2 (空行) → 落回第一段", r1?.from === resolveReveal(view, lm, { kind: "line", bodyLine: 2 })?.from),
    );
    out.push(
      expect(
        "line: lineMap=null → null",
        resolveReveal(view, null, { kind: "line", bodyLine: 1 }) === null,
      ),
    );
  }

  // 4) code_block 内的 SQL 文本也能被 keyword 搜到（RunSQL 主路径）
  {
    const view = mockView({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Intro." }] },
        {
          type: "code_block",
          attrs: { language: "runsql" },
          content: [{ type: "text", text: "SELECT * FROM users" }],
        },
      ],
    });
    const r = resolveReveal(view, null, {
      kind: "keyword",
      keyword: "users",
      nthInFile: 0,
      caseSensitive: false,
    });
    out.push(
      expect(
        "code_block: SQL 文本内 keyword 可命中",
        r !== null && r.kind === "keyword",
      ),
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
    console.error(`\nsearch/locator tests FAILED (${failed}).`);
    process.exit(1);
  }
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  fileURLToPath(import.meta.url) === process.argv[1]
) {
  main();
}
