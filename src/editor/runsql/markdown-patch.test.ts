/**
 * runsql markdown patch 单测。
 *
 *     npx tsx src/editor/runsql/markdown-patch.test.ts
 *
 * 覆盖：
 *   - parseRunsqlFences：识别所有 runsql fence，包括没有 <detail> 的首次执行块
 *   - patchRunsqlDetail：按 blockId 替换已有 detail
 *   - patchRunsqlDetail：按 blockIndex 给无 detail 的块插入 detail
 *   - patchRunsqlDetail：重复 SQL 时按 blockIndex 命中正确块
 */

import {
  parseRunsqlFences,
  patchRunsqlDetail,
} from "./markdown-patch";

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

function expect(name: string, ok: boolean, detail?: string): Check {
  return { name, ok, detail };
}

const DETAIL_A = `<detail>
   <block-id>blk_a</block-id>
   <run-date>2026-04-03 12:23:34</run-date>
   <elapsed>12s</elapsed>
   <row-count>3</row-count>
   <first-row>{"id":1}</first-row>
   <result-ref-id>run_a</result-ref-id>
</detail>`;

const DETAIL_B = `<detail>
   <block-id>blk_b</block-id>
   <run-date>2026-04-03 12:24:00</run-date>
   <elapsed>8ms</elapsed>
   <row-count>1</row-count>
   <first-row>{"id":2}</first-row>
   <result-ref-id>run_b</result-ref-id>
</detail>`;

const DETAIL_NEW = `<detail>
   <block-id>blk_new</block-id>
   <run-date>2026-04-03 12:25:00</run-date>
   <elapsed>4ms</elapsed>
   <row-count>1</row-count>
   <first-row>{"answer":42}</first-row>
   <result-ref-id>run_new</result-ref-id>
</detail>`;

const MD_MIXED = `# Note

\`\`\`runsql
SELECT 1
\`\`\`
${DETAIL_A}

\`\`\`python
print("ignore")
\`\`\`

\`\`\`runsql
SELECT 2
\`\`\`

After missing detail.

\`\`\`runsql
SELECT 3
\`\`\`
${DETAIL_B}
`;

const results: Check[] = [];

{
  const fences = parseRunsqlFences(MD_MIXED);
  results.push(
    expect(
      "parseRunsqlFences: 返回所有 runsql 块，包含无 detail 块",
      fences.length === 3 &&
        fences[0].sql === "SELECT 1" &&
        fences[0].blockId === "blk_a" &&
        fences[1].sql === "SELECT 2" &&
        fences[1].detailStart === null &&
        fences[2].blockId === "blk_b",
      JSON.stringify(fences),
    ),
  );
}

{
  const patched = patchRunsqlDetail(MD_MIXED, {
    blockId: "blk_a",
    blockIndex: 0,
    sql: "SELECT 1",
    detailRaw: DETAIL_NEW,
  });
  results.push(
    expect(
      "patchRunsqlDetail: 按 blockId 替换已有 detail",
      patched.includes(DETAIL_NEW) &&
        !patched.includes("<result-ref-id>run_a</result-ref-id>") &&
        patched.includes("<result-ref-id>run_b</result-ref-id>"),
    ),
  );
}

{
  const patched = patchRunsqlDetail(MD_MIXED, {
    blockId: "blk_new",
    blockIndex: 1,
    sql: "SELECT 2",
    detailRaw: DETAIL_NEW,
  });
  results.push(
    expect(
      "patchRunsqlDetail: 无 detail 块在 fence 后插入 detail",
      patched.includes("SELECT 2\n```\n\n<detail>") &&
        patched.includes("<block-id>blk_new</block-id>") &&
        patched.includes("After missing detail."),
    ),
  );
}

{
  const duplicated = `\`\`\`runsql
SELECT 1
\`\`\`
${DETAIL_A}

\`\`\`runsql
SELECT 1
\`\`\`
`;
  const patched = patchRunsqlDetail(duplicated, {
    blockId: "blk_new",
    blockIndex: 1,
    sql: "SELECT 1",
    detailRaw: DETAIL_NEW,
  });
  results.push(
    expect(
      "patchRunsqlDetail: 重复 SQL 时按 blockIndex 命中第二块",
      patched.indexOf("<result-ref-id>run_a</result-ref-id>") <
        patched.indexOf("<result-ref-id>run_new</result-ref-id>"),
      patched,
    ),
  );
}

let failed = 0;
for (const r of results) {
  if (r.ok) {
    console.log(`  ok  ${r.name}`);
  } else {
    failed += 1;
    console.log(`  !!! ${r.name}${r.detail ? `   -> ${r.detail}` : ""}`);
  }
}
console.log(
  `\nmarkdown-patch.test.ts: ${results.length - failed}/${results.length} passed`,
);
if (failed > 0) process.exit(1);
