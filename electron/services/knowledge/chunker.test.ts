/**
 * Knowledge chunker 自运行测试。
 *
 * 覆盖目标：
 *   - frontmatter 被剥除，不污染索引
 *   - 按 heading 切 section，slug 与 vault-index 同款 + 去重后缀
 *   - 长段落按 token 上界滑窗，相邻窗口带 overlap
 *   - fenced code block 内的 # 不会被误识别为 heading
 *   - hashSourceContent 是稳定的
 *   - extractRunsqlBlocks 能配对 fence + <detail>，并向 chunker 输出 runsql chunk
 *
 * 运行：
 *
 *     npx tsx electron/services/knowledge/chunker.test.ts
 */

import {
  chunkSource,
  extractRunsqlBlocks,
  hashSourceContent,
} from "./chunker";

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

function expect(name: string, ok: boolean, detail?: string): Check {
  return { name, ok, detail };
}

const checks: Check[] = [];

// 1. frontmatter 剥除
{
  const md = `---\ntitle: hello\n---\n\n# Intro\n\nfoo bar\n`;
  const chunks = chunkSource({ relPath: "a.md", content: md });
  checks.push(
    expect(
      "frontmatter stripped",
      chunks.length > 0 && !chunks.some((c) => c.content.includes("title: hello")),
      JSON.stringify(chunks.map((c) => c.content)),
    ),
  );
  checks.push(
    expect(
      "heading slug from first heading",
      chunks[0]!.headingSlug === "intro" && chunks[0]!.headingText === "Intro",
      `${chunks[0]!.headingSlug} / ${chunks[0]!.headingText}`,
    ),
  );
}

// 2. heading slug 去重
{
  const md = `# Notes\n\nfirst\n\n# Notes\n\nsecond\n`;
  const chunks = chunkSource({ relPath: "dup.md", content: md });
  const slugs = chunks.map((c) => c.headingSlug);
  checks.push(
    expect(
      "duplicate heading slugs get suffix",
      slugs.includes("notes") && slugs.includes("notes-1"),
      slugs.join(","),
    ),
  );
}

// 3. fenced code 内的 # 不算 heading
{
  const md = `# Real\n\nreal paragraph body that survives stripping.\n\n\`\`\`python\n# not a heading\nprint(1)\n\`\`\`\n\n# After\n\nafter paragraph body that also survives.\n`;
  const chunks = chunkSource({ relPath: "fence.md", content: md });
  const headingSlugs = chunks.map((c) => c.headingSlug);
  checks.push(
    expect(
      "fenced # ignored",
      headingSlugs.includes("real") && headingSlugs.includes("after"),
      headingSlugs.join(","),
    ),
  );
}

// 4. 长段落滑窗 + overlap
//
// 注意：当前 chunker 段落级 packing 不会拆"单个超长段落"（防止句子腰斩）。
// 我们通过多个中等长度段落（每段 ~50 token）触发跨窗口 overlap。
{
  const para = (label: string) =>
    `段落 ${label}：` +
    "本段约一百字的文本，用于触发 chunker 的滑窗机制，确保跨窗口 overlap 行为可测。".repeat(
      2,
    );
  const md =
    `# Long\n\n` +
    Array.from({ length: 12 }, (_, i) => para(String(i))).join("\n\n");
  const chunks = chunkSource({ relPath: "long.md", content: md });
  checks.push(
    expect("long content split", chunks.length >= 2, `chunks=${chunks.length}`),
  );
  if (chunks.length >= 2) {
    // overlap 实际是把上一窗口尾部约 OVERLAP_TOKENS / TOKENS_PER_CHAR (=64) 个 char 带到下窗口
    // 取一个有辨识度的尾片段做近似检测。
    const tail = chunks[0]!.content.slice(-12).trim();
    checks.push(
      expect(
        "consecutive chunks share overlap",
        tail.length > 0 && chunks[1]!.content.includes(tail.slice(0, 6)),
        `tail=${tail} next=${chunks[1]!.content.slice(0, 60)}`,
      ),
    );
  }
}

// 5. hashSourceContent 稳定
{
  const a = hashSourceContent("hello world\n");
  const b = hashSourceContent("hello world\n");
  const c = hashSourceContent("hello world!\n");
  checks.push(expect("source hash deterministic", a === b, `${a} vs ${b}`));
  checks.push(expect("source hash differs on change", a !== c, `${a} vs ${c}`));
}

// 6. extractRunsqlBlocks 解析 fence + detail
{
  const md = [
    "# Page",
    "",
    "before context paragraph",
    "",
    "```runsql",
    "SELECT 1 AS one",
    "```",
    "",
    '<detail block-id="abc-123">',
    "  <row-count>1</row-count>",
    "  <elapsed>12ms</elapsed>",
    "  <first-row>{\"one\": 1}</first-row>",
    "</detail>",
    "",
  ].join("\n");
  const blocks = extractRunsqlBlocks(md);
  checks.push(expect("extracts one block", blocks.length === 1, JSON.stringify(blocks)));
  if (blocks[0]) {
    checks.push(
      expect("captures sql", blocks[0].sql.trim() === "SELECT 1 AS one"),
    );
    checks.push(
      expect("captures markdownContext", blocks[0].markdownContext.includes("before")),
    );
    checks.push(
      expect("captures blockId", blocks[0].blockId === "abc-123"),
    );
    checks.push(
      expect(
        "captures detail fields",
        blocks[0].detail?.rowCount === 1 && blocks[0].detail?.elapsed === "12ms",
        JSON.stringify(blocks[0].detail),
      ),
    );
  }
}

// 7. runsql chunk 进入 chunkSource 输出
{
  const md = "# Page\n\nabout sql\n";
  const chunks = chunkSource({
    relPath: "rs.md",
    content: md,
    title: "Page",
    runsqlBlocks: [
      {
        blockId: "b1",
        markdownContext: "about sql",
        sql: "SELECT count(*) FROM t",
        detail: { rowCount: 42, elapsed: "5ms" },
      },
    ],
  });
  const rs = chunks.find((c) => c.sourceKind === "runsql");
  checks.push(expect("runsql chunk emitted", !!rs));
  if (rs) {
    checks.push(
      expect(
        "runsql chunk content includes SQL marker",
        rs.content.includes("--- SQL ---") && rs.content.includes("SELECT count(*)"),
      ),
    );
    checks.push(
      expect(
        "runsql chunk content includes Stats",
        rs.content.includes("--- Stats ---") && rs.content.includes("rows=42"),
      ),
    );
    checks.push(expect("runsql chunk preserves blockId", rs.blockId === "b1"));
  }
}

let pass = 0;
let fail = 0;
for (const c of checks) {
  if (c.ok) {
    pass += 1;
    console.log(`PASS  ${c.name}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${c.name}  ${c.detail ?? ""}`);
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
