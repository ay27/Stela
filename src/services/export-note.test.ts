/**
 * export-note 单元测试。
 *
 * 跑：
 *
 *     npx tsx src/services/export-note.test.ts
 *
 * 覆盖三个层次：
 *   1. `parseRunsqlBlocks` —— markdown 文本扫描
 *   2. `renderMarkdownTable` / `renderResultBlock` —— GFM 表格渲染
 *   3. `exportNoteToMarkdown` —— 主流程（依赖注入 fake）
 */

import { fileURLToPath } from "node:url";

import type { ColumnDef } from "@/contracts";
import type { DetailMeta } from "@/core/types";
import type { ResultLoaderDeps } from "@/services/result-loader";
import {
  exportNoteToMarkdown,
  finalizeExportMarkdown,
  normalizeExportHtmlTags,
  unescapeMilkdownLiterals,
  parseRunsqlBlocks,
  renderMarkdownTable,
  renderResultBlock,
  rewriteRunsqlFencesToSql,
} from "./export-note";

// ─── 轻量 assert 工具 ─────────────────────────────────────────────────────────

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

function expect(name: string, ok: boolean, detail?: string): Check {
  return { name, ok, detail };
}

// ─── parseRunsqlBlocks ────────────────────────────────────────────────────────

const DETAIL_SNIPPET = `<detail>
   <run-date>2026-04-03 12:23:34</run-date>
   <elapsed>12s</elapsed>
   <row-count>3</row-count>
   <first-row>{"id":1}</first-row>
   <result-ref-id>run_abc</result-ref-id>
</detail>`;

const MD_SINGLE = `# Hello

Some prose.

\`\`\`runsql
SELECT 1
\`\`\`
${DETAIL_SNIPPET}

More prose.
`;

const MD_MULTI = `\`\`\`runsql
SELECT 1
\`\`\`
${DETAIL_SNIPPET}

\`\`\`runsql
SELECT 2
\`\`\`
${DETAIL_SNIPPET.replace("run_abc", "run_xyz").replace("12:23:34", "12:24:00")}
`;

const MD_NO_DETAIL = `# Hello

\`\`\`runsql
SELECT 1
\`\`\`

More prose.
`;

const MD_NOT_RUNSQL = `# Just prose

\`\`\`python
print("hi")
\`\`\`

\`\`\`
plain fence
\`\`\`
`;

const MD_EMPTY_BETWEEN = `\`\`\`runsql
SELECT 1
\`\`\`


${DETAIL_SNIPPET}
`;

const MD_WITH_BR = `# Hello

Some prose.

<br />

\`\`\`runsql
SELECT 1
\`\`\`
${DETAIL_SNIPPET}
`;

async function testNormalizeExportHtmlTags(): Promise<Check[]> {
  const out: Check[] = [];

  out.push(
    expect(
      "br: standalone line removed",
      normalizeExportHtmlTags("para\n\n<br />\n\n## h") === "para\n\n\n## h",
    ),
  );
  out.push(
    expect(
      "br: inline → hard break",
      normalizeExportHtmlTags("line1<br />line2") === "line1  \nline2",
    ),
  );
  out.push(
    expect(
      "br: variant without slash",
      normalizeExportHtmlTags("a<br> b") === "a  \n b",
    ),
  );
  out.push(
    expect(
      "finalize: runsql + br",
      finalizeExportMarkdown("```runsql\nx\n```\n<br />") === "```sql\nx\n```\n",
    ),
  );
  out.push(
    expect(
      "br: table row strips br placeholders",
      normalizeExportHtmlTags(
        "| a | <br /> | <br /> |\n| b | c | d |",
      ) === "| a |  |  |\n| b | c | d |",
    ),
  );

  return out;
}

async function testUnescapeMilkdownLiterals(): Promise<Check[]> {
  const out: Check[] = [];

  out.push(
    expect(
      "unescape: prose underscores",
      unescapeMilkdownLiterals("shapegen\\_part") === "shapegen_part",
    ),
  );
  out.push(
    expect(
      "unescape: keeps inline code",
      unescapeMilkdownLiterals("use `foo\\_bar` here") === "use `foo\\_bar` here",
    ),
  );
  out.push(
    expect(
      "unescape: keeps fenced code",
      unescapeMilkdownLiterals("```\nghp\\_ok\n```") === "```\nghp\\_ok\n```",
    ),
  );

  return out;
}

async function testRewriteRunsqlFencesToSql(): Promise<Check[]> {
  const out: Check[] = [];

  out.push(
    expect(
      "rewrite: opening fence",
      rewriteRunsqlFencesToSql("```runsql\nSELECT 1\n```") === "```sql\nSELECT 1\n```",
    ),
  );
  out.push(
    expect(
      "rewrite: multiple blocks",
      rewriteRunsqlFencesToSql("```runsql\nA\n```\n\n```runsql\nB\n```").split("```runsql").length === 1,
    ),
  );
  out.push(
    expect(
      "rewrite: leaves other langs",
      rewriteRunsqlFencesToSql("```python\nx\n```") === "```python\nx\n```",
    ),
  );

  return out;
}

async function testParseRunsqlBlocks(): Promise<Check[]> {
  const out: Check[] = [];

  // 单个 RunSQL 块
  {
    const blocks = parseRunsqlBlocks(MD_SINGLE);
    out.push(expect("single: exactly 1 block", blocks.length === 1));
    if (blocks.length > 0) {
      out.push(
        expect(
          "single: resultRefId parsed",
          blocks[0].detail.resultRefId === "run_abc",
        ),
      );
      out.push(
        expect("single: rowCount = 3", blocks[0].detail.rowCount === 3),
      );
      // detailRaw 应该包含 <detail> 标签
      out.push(
        expect(
          "single: detailRaw contains tag",
          blocks[0].detailRaw.includes("<detail>"),
        ),
      );
      // 替换后内容重建检验：detailStart~detailEnd 切出来 === detailRaw
      const slice = MD_SINGLE.slice(
        blocks[0].detailStart,
        blocks[0].detailEnd,
      );
      out.push(expect("single: slice equals detailRaw", slice === blocks[0].detailRaw));
    }
  }

  // 两个 RunSQL 块
  {
    const blocks = parseRunsqlBlocks(MD_MULTI);
    out.push(expect("multi: 2 blocks found", blocks.length === 2));
    if (blocks.length === 2) {
      out.push(
        expect(
          "multi: first ref = run_abc",
          blocks[0].detail.resultRefId === "run_abc",
        ),
      );
      out.push(
        expect(
          "multi: second ref = run_xyz",
          blocks[1].detail.resultRefId === "run_xyz",
        ),
      );
      // 两个块的 detailStart 不同
      out.push(
        expect(
          "multi: different starts",
          blocks[0].detailStart !== blocks[1].detailStart,
        ),
      );
    }
  }

  // 无 detail → 0 blocks
  {
    const blocks = parseRunsqlBlocks(MD_NO_DETAIL);
    out.push(expect("no-detail: 0 blocks", blocks.length === 0));
  }

  // 非 RunSQL fenced block → 0 blocks
  {
    const blocks = parseRunsqlBlocks(MD_NOT_RUNSQL);
    out.push(expect("non-runsql: 0 blocks", blocks.length === 0));
  }

  // 空行分隔允许
  {
    const blocks = parseRunsqlBlocks(MD_EMPTY_BETWEEN);
    out.push(expect("empty-lines: 1 block", blocks.length === 1));
    if (blocks.length > 0) {
      const slice = MD_EMPTY_BETWEEN.slice(
        blocks[0].detailStart,
        blocks[0].detailEnd,
      );
      out.push(
        expect(
          "empty-lines: slice equals detailRaw",
          slice === blocks[0].detailRaw,
          `slice='${slice}' detailRaw='${blocks[0].detailRaw}'`,
        ),
      );
    }
  }

  // 纯 prose → 0 blocks
  {
    const blocks = parseRunsqlBlocks("# Just text\n\nHello world.\n");
    out.push(expect("pure-prose: 0 blocks", blocks.length === 0));
  }

  return out;
}

// ─── renderMarkdownTable ──────────────────────────────────────────────────────

async function testRenderMarkdownTable(): Promise<Check[]> {
  const out: Check[] = [];

  const cols: ColumnDef[] = [
    { name: "id", typeName: "INT" },
    { name: "name", typeName: "VARCHAR" },
  ];

  // 基础两行
  {
    const table = renderMarkdownTable(cols, [[1, "alice"], [2, "bob"]]);
    out.push(expect("table: has header", table.startsWith("| id | name |")));
    out.push(expect("table: has sep row", table.includes("| --- | --- |")));
    out.push(expect("table: has data row", table.includes("| 1 | alice |")));
  }

  // NULL 值
  {
    const table = renderMarkdownTable(cols, [[null, null]]);
    out.push(expect("null: renders *NULL*", table.includes("*NULL*")));
  }

  // 管道符转义
  {
    const table = renderMarkdownTable(
      [{ name: "val", typeName: "TEXT" }],
      [["a|b"]],
    );
    out.push(expect("pipe-escape: | → \\|", table.includes("a\\|b")));
  }

  // 换行替换为空格
  {
    const table = renderMarkdownTable(
      [{ name: "val", typeName: "TEXT" }],
      [["a\nb"]],
    );
    out.push(expect("newline: replaced with space", table.includes("a b")));
  }

  // 空列 → 空字符串
  {
    const table = renderMarkdownTable([], []);
    out.push(expect("empty: empty string", table === ""));
  }

  return out;
}

// ─── renderResultBlock ────────────────────────────────────────────────────────

async function testRenderResultBlock(): Promise<Check[]> {
  const out: Check[] = [];

  const detail: DetailMeta = {
    runDate: "2026-04-03 12:23",
    elapsed: "12s",
    rowCount: 100,
    firstRow: { id: 1 },
    resultRefId: "run_abc",
  };

  const cols: ColumnDef[] = [
    { name: "id", typeName: "INT" },
    { name: "name", typeName: "VARCHAR" },
  ];

  // 有结果集 + 截断提示
  {
    const block = renderResultBlock(detail, cols, [[1, "alice"]], 100, 10);
    out.push(expect("result: has blockquote header", block.includes("> Result")));
    out.push(
      expect("result: shows cap / total", block.includes("first 10 / 100 rows")),
    );
    out.push(expect("result: has table", block.includes("| id | name |")));
    out.push(expect("result: has run-date", block.includes("2026-04-03 12:23")));
    out.push(expect("result: has elapsed", block.includes("12s")));
  }

  // 全部行（cap = null），且 rows = total → 不显示"前 N /"
  {
    const block = renderResultBlock(detail, cols, [[1, "alice"]], 100, null);
    out.push(expect("all-rows: no cap prefix", !block.includes("前 ")));
    out.push(expect("all-rows: shows total", block.includes("100 rows total")));
  }

  // 无结果集（mutation）
  {
    const block = renderResultBlock(detail, [], [], 0, 10);
    out.push(expect("mutation: no-result message", block.includes("No result set")));
    out.push(expect("mutation: no table", !block.includes("| --- |")));
  }

  return out;
}

// ─── exportNoteToMarkdown 主流程 ──────────────────────────────────────────────

function makeLoaderDeps(
  schema: ColumnDef[],
  rows: unknown[][],
  total: number,
): ResultLoaderDeps {
  return {
    storage: {
      getSchema: async () => schema,
      queryPage: async (_, offset, limit) => ({
        offset,
        limit,
        rows: rows.slice(offset, offset + limit),
        total,
      }),
    },
    journal: {
      importRun: async () => false,
    },
  };
}

async function testExportNoteToMarkdown(): Promise<Check[]> {
  const out: Check[] = [];

  const cols: ColumnDef[] = [{ name: "id", typeName: "INT" }];
  const rows: unknown[][] = [[1], [2], [3]];

  // 正常导出：detail 被 markdown table 替换
  {
    let savedContent = "";
    const result = await exportNoteToMarkdown({
      filePath: "/vault/note.md",
      rowCap: 10,
      deps: {
        readFile: async () => MD_SINGLE,
        loaderDeps: makeLoaderDeps(cols, rows, 3),
        saveMarkdown: async (_name, content) => {
          savedContent = content;
          return { canceled: false, path: "/out/note-export.md" };
        },
      },
    });
    out.push(expect("main: not canceled", !result.canceled));
    out.push(expect("main: savedPath set", result.savedPath === "/out/note-export.md"));
    out.push(expect("main: 0 failed blocks", result.failedBlocks === 0));
    out.push(expect("main: detail replaced", !savedContent.includes("<detail>")));
    out.push(expect("main: table present", savedContent.includes("| id |")));
    out.push(expect("main: prose preserved", savedContent.includes("Some prose.")));
    out.push(expect("main: runsql fence → sql", savedContent.includes("```sql\nSELECT 1")));
    out.push(expect("main: no runsql fence", !savedContent.includes("```runsql")));
    out.push(expect("main: no br tag", !savedContent.includes("<br")));
  }

  // 含 <br /> 的原文 → 导出后清除
  {
    let savedContent = "";
    await exportNoteToMarkdown({
      filePath: "/vault/br.md",
      rowCap: 10,
      deps: {
        readFile: async () => MD_WITH_BR,
        loaderDeps: makeLoaderDeps(cols, rows, 3),
        saveMarkdown: async (_name, content) => {
          savedContent = content;
          return { canceled: false, path: "/out/br-export.md" };
        },
      },
    });
    out.push(expect("br-export: no br tag", !savedContent.includes("<br")));
    out.push(expect("br-export: prose preserved", savedContent.includes("Some prose.")));
  }

  // 用户取消 Save Dialog
  {
    const result = await exportNoteToMarkdown({
      filePath: "/vault/note.md",
      rowCap: 10,
      deps: {
        readFile: async () => MD_SINGLE,
        loaderDeps: makeLoaderDeps(cols, rows, 3),
        saveMarkdown: async () => ({ canceled: true, path: null }),
      },
    });
    out.push(expect("cancel: result.canceled = true", result.canceled === true));
    out.push(expect("cancel: savedPath null", result.savedPath === null));
  }

  // 无 RunSQL 块 → 原文直接导出，无替换
  {
    let savedContent = "";
    const result = await exportNoteToMarkdown({
      filePath: "/vault/note.md",
      rowCap: 10,
      deps: {
        readFile: async () => MD_NO_DETAIL,
        loaderDeps: makeLoaderDeps([], [], 0),
        saveMarkdown: async (_name, content) => {
          savedContent = content;
          return { canceled: false, path: "/out/note-export.md" };
        },
      },
    });
    out.push(expect("no-blocks: not canceled", !result.canceled));
    out.push(expect("no-blocks: 0 failedBlocks", result.failedBlocks === 0));
    out.push(
      expect(
        "no-blocks: runsql fence → sql",
        savedContent.includes("```sql\nSELECT 1") && !savedContent.includes("```runsql"),
      ),
    );
  }

  // 数据加载失败 → 保留原 <detail> + failedBlocks = 1
  {
    let savedContent = "";
    const result = await exportNoteToMarkdown({
      filePath: "/vault/note.md",
      rowCap: 10,
      deps: {
        readFile: async () => MD_SINGLE,
        loaderDeps: {
          storage: {
            getSchema: async () => {
              throw new Error("db error");
            },
            queryPage: async (_runId, offset, limit) => ({
              offset,
              limit,
              rows: [],
              total: 0,
            }),
          },
          journal: {
            importRun: async () => {
              throw new Error("no remote");
            },
          },
        },
        saveMarkdown: async (_name, content) => {
          savedContent = content;
          return { canceled: false, path: "/out/note-export.md" };
        },
      },
    });
    out.push(expect("data-fail: failedBlocks = 1", result.failedBlocks === 1));
    out.push(
      expect("data-fail: original detail preserved", savedContent.includes("<detail>")),
    );
    out.push(
      expect("data-fail: warning added", savedContent.includes("Result data missing")),
    );
  }

  // 多块：两块都有数据，第二块失败
  {
    let savedContent = "";
    let callCount = 0;
    const result = await exportNoteToMarkdown({
      filePath: "/vault/multi.md",
      rowCap: 10,
      deps: {
        readFile: async () => MD_MULTI,
        loaderDeps: {
          storage: {
            getSchema: async () => {
              callCount++;
              if (callCount > 1) throw new Error("second block fails");
              return cols;
            },
            queryPage: async (_runId, offset, limit) => ({
              offset,
              limit,
              rows,
              total: rows.length,
            }),
          },
          journal: {
            importRun: async () => {
              throw new Error("no remote");
            },
          },
        },
        saveMarkdown: async (_name, content) => {
          savedContent = content;
          return { canceled: false, path: "/out/multi-export.md" };
        },
      },
    });
    out.push(expect("multi-partial: failedBlocks = 1", result.failedBlocks === 1));
    out.push(
      expect(
        "multi-partial: first block has table",
        savedContent.includes("| id |"),
      ),
    );
    out.push(
      expect(
        "multi-partial: second block has warning",
        savedContent.includes("Result data missing"),
      ),
    );
  }

  return out;
}

// ─── 多历史导出 ───────────────────────────────────────────────────────────────

const DETAIL_WITH_BLOCK = `<detail>
   <block-id>blk1</block-id>
   <run-date>2026-06-18 10:35</run-date>
   <elapsed>679ms</elapsed>
   <row-count>1</row-count>
   <first-row>{"total":300}</first-row>
   <result-ref-id>run_new</result-ref-id>
</detail>`;

const MD_BLOCK_HISTORY = `# 监控

\`\`\`runsql
SELECT count(*) AS total, sum(done) AS done
\`\`\`
${DETAIL_WITH_BLOCK}
`;

/** 按 runId 返回不同结果的 loaderDeps（单行监控，total/done 各异）。 */
function makePerRunLoaderDeps(
  byRun: Record<string, { schema: ColumnDef[]; rows: unknown[][] }>,
): ResultLoaderDeps {
  return {
    storage: {
      getSchema: async (runId) => byRun[runId]?.schema ?? [],
      queryPage: async (runId, offset, limit) => {
        const rows = byRun[runId]?.rows ?? [];
        return { offset, limit, rows: rows.slice(offset, offset + limit), total: rows.length };
      },
    },
    journal: { importRun: async () => false },
  };
}

function fakeRun(runId: string, startedAt: number, rowCount: number) {
  return {
    runId,
    blockId: "blk1",
    sql: "SELECT ...",
    status: "ok" as const,
    message: null,
    startedAt,
    elapsedMs: 600,
    rowCount,
    connectionName: "c",
    notePath: null,
  };
}

async function testExportMultiHistory(): Promise<Check[]> {
  const out: Check[] = [];

  const cols: ColumnDef[] = [
    { name: "total", typeName: "INT" },
    { name: "done", typeName: "INT" },
  ];
  const loaderDeps = makePerRunLoaderDeps({
    run_new: { schema: cols, rows: [[300, 142]] },
    run_old: { schema: cols, rows: [[300, 141]] },
  });
  const runs = [
    fakeRun("run_new", 1_700_000_200_000, 1),
    fakeRun("run_old", 1_700_000_100_000, 1),
  ];

  // recent + diff 摘要
  {
    let saved = "";
    const result = await exportNoteToMarkdown({
      filePath: "/vault/mon.md",
      rowCap: 10,
      runScope: { kind: "recent", count: 5 },
      includeDiffSummary: true,
      deps: {
        readFile: async () => MD_BLOCK_HISTORY,
        loaderDeps,
        listRunsByBlockId: async () => runs,
        saveMarkdown: async (_n, content) => {
          saved = content;
          return { canceled: false, path: "/out/mon-export.md" };
        },
      },
    });
    out.push(expect("multi-history: not canceled", !result.canceled));
    out.push(expect("multi-history: latest marker", saved.includes("**Latest**")));
    out.push(expect("multi-history: details fold", saved.includes("<details>")));
    out.push(
      expect(
        "multi-history: older count",
        saved.includes("Execution history (1 older runs)"),
      ),
    );
    out.push(expect("multi-history: diff header", saved.includes("Diff from previous version")));
    out.push(
      expect(
        "multi-history: diff changed col",
        saved.includes("| done | 141 | 142 | changed |"),
        saved,
      ),
    );
  }

  // latest 范围：行为与旧版一致（无 details / 无 diff）
  {
    let saved = "";
    await exportNoteToMarkdown({
      filePath: "/vault/mon.md",
      rowCap: 10,
      runScope: { kind: "latest" },
      deps: {
        readFile: async () => MD_BLOCK_HISTORY,
        loaderDeps,
        listRunsByBlockId: async () => runs,
        saveMarkdown: async (_n, content) => {
          saved = content;
          return { canceled: false, path: "/out/mon-export.md" };
        },
      },
    });
    out.push(expect("latest-scope: no details", !saved.includes("<details>")));
    out.push(expect("latest-scope: no diff", !saved.includes("与上一版 diff")));
    out.push(expect("latest-scope: has table", saved.includes("| total | done |")));
  }

  return out;
}

// ─── 主函数 ───────────────────────────────────────────────────────────────────

async function main() {
  const sections: [string, () => Promise<Check[]>][] = [
    ["normalizeExportHtmlTags", testNormalizeExportHtmlTags],
    ["unescapeMilkdownLiterals", testUnescapeMilkdownLiterals],
    ["rewriteRunsqlFencesToSql", testRewriteRunsqlFencesToSql],
    ["parseRunsqlBlocks", testParseRunsqlBlocks],
    ["renderMarkdownTable", testRenderMarkdownTable],
    ["renderResultBlock", testRenderResultBlock],
    ["exportNoteToMarkdown (主流程)", testExportNoteToMarkdown],
    ["exportNoteToMarkdown (多历史)", testExportMultiHistory],
  ];

  let failed = 0;
  for (const [title, fn] of sections) {
    const checks = await fn();
    console.log(`\n▶ ${title}`);
    for (const c of checks) {
      if (c.ok) {
        console.log(`  ✓ ${c.name}`);
      } else {
        failed++;
        console.log(`  ✗ ${c.name}`);
        if (c.detail) console.log(`      ${c.detail}`);
      }
    }
  }

  if (failed > 0) {
    console.error(`\nexport-note tests FAILED (${failed}).`);
    process.exit(1);
  }
  console.log("\nAll export-note checks passed.");
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1]
) {
  void main();
}
