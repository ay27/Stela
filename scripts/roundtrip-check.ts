/**
 * Stela markdown round-trip 健康检查。
 *
 * 现阶段我们 *不* 在 Node 里启 Milkdown 的整套 ProseMirror 视图（jsdom 对 contenteditable
 * 的支持不全，会跑出一堆假阳性），而是把"上下两层 Stela 自己的转换"独立验证：
 *
 *   1. 文件层：splitFrontmatter / joinFrontmatter 是规范化等价 —— 任意原文，做一次切分再
 *      拼回，再切分一次，结构必须稳定（即第二次往后所有的中间产物都不再变化）。
 *   2. 块层：detail-meta 的 parse → serialize → parse 必须幂等，且字符串可还原。
 *   3. 端到端契约：splitFrontmatter 后的 body，必须满足"runsql fence 与 <detail> 块之间有
 *      空行"、"</detail> 后有空行"这两个 Milkdown remark-parse 正常分块所需的前置条件，
 *      否则 HTML block 会吞掉后续节点。
 *
 * Milkdown 内部的 mdast ↔ ProseMirror 转换我们信任 commonmark preset；只要 mdast 上层
 * `<detail>` 已经被 [src/editor/runsql/remark-detail-merge.ts](../src/editor/runsql/remark-detail-merge.ts)
 * 吸附到 code 节点的 `data` 上，反向序列化就能由
 * [src/editor/runsql/stela-codeblock-schema.ts](../src/editor/runsql/stela-codeblock-schema.ts)
 * 的 toMarkdown runner 把 `<detail>` 还原回 mdast html 节点，最终经 remark-stringify 输出。
 *
 * 运行：`npm test`（即 `tsx scripts/roundtrip-check.ts`）。
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  joinFrontmatter,
  splitFrontmatter,
} from "../src/core/markdown";
import {
  matchDetail,
  parseDetail,
  serializeDetail,
} from "../src/editor/runsql/detail-meta";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

function expect(name: string, ok: boolean, detail?: string): Check {
  return { name, ok, detail };
}

function checkSplitJoinIdempotent(raw: string): Check[] {
  const { frontmatter, body } = splitFrontmatter(raw);
  const rebuilt = joinFrontmatter(frontmatter, body);
  const second = splitFrontmatter(rebuilt);

  return [
    expect(
      "frontmatter 切分稳定（第二次切分得到的 frontmatter 与第一次相同）",
      second.frontmatter === frontmatter,
      `expected:\n${frontmatter}\ngot:\n${second.frontmatter}`,
    ),
    expect(
      "body 经 join → split 后保持不变（规范化幂等）",
      second.body === body,
      diffPreview(body, second.body),
    ),
  ];
}

function checkBodyShape(body: string): Check[] {
  // 规范化要求 1：``` 紧贴 <detail 已经被插入空行
  const fenceTouchesDetail = /\n```[ \t]*\n<detail[\s>]/.test(body);
  // 规范化要求 2：</detail> 后必须紧跟空行（或文件结束）
  const detailEndNoBlank = /<\/detail>[ \t]*\n(?!\n|$)/.test(body);
  // 规范化要求 3：legacy `\n---\n---\n` 已被吃掉
  const legacySep = /(?:^|\n)---\n---(?:\n|$)/.test(body);

  return [
    expect(
      "fence 与 <detail> 之间已插入空行（避免 HTML block 解析失败）",
      !fenceTouchesDetail,
    ),
    expect(
      "</detail> 后保留空行（避免 HTML block 吞掉后续块）",
      !detailEndNoBlank,
    ),
    expect("legacy `\\n---\\n---\\n` 块分隔符已折叠", !legacySep),
  ];
}

function checkDetailRoundtrip(body: string): Check[] {
  const checks: Check[] = [];
  const re = /<detail>[\s\S]*?<\/detail>/gi;
  let i = 0;
  for (const m of body.matchAll(re)) {
    i++;
    const matched = matchDetail(m[0]);
    if (!matched) {
      checks.push(expect(`detail #${i}: matchDetail 命中`, false));
      continue;
    }
    const meta = parseDetail(matched.inner);
    const reSerialized = serializeDetail(meta);
    const reMatched = matchDetail(reSerialized);
    if (!reMatched) {
      checks.push(
        expect(`detail #${i}: serialize 输出可被 matchDetail 重新识别`, false),
      );
      continue;
    }
    const meta2 = parseDetail(reMatched.inner);
    checks.push(
      expect(
        `detail #${i}: parse → serialize → parse 字段幂等`,
        JSON.stringify(meta) === JSON.stringify(meta2),
        `meta1: ${JSON.stringify(meta)}\nmeta2: ${JSON.stringify(meta2)}`,
      ),
    );
    checks.push(
      expect(
        `detail #${i}: rowCount 解析为数字`,
        typeof meta.rowCount === "number" && !Number.isNaN(meta.rowCount),
        `meta: ${JSON.stringify(meta)}`,
      ),
    );
  }
  if (i === 0) {
    checks.push(expect("body 内含 <detail> 块（sample 应有至少一个）", false));
  }
  return checks;
}

function checkRunsqlFenceCount(body: string, expected: number): Check {
  const matches = body.match(/```runsql[\s\S]*?```/g) ?? [];
  return expect(
    `body 内 runsql code fence 数量 = ${expected}`,
    matches.length === expected,
    `actual=${matches.length}`,
  );
}

function diffPreview(a: string, b: string): string {
  if (a === b) return "";
  let i = 0;
  const min = Math.min(a.length, b.length);
  while (i < min && a[i] === b[i]) i++;
  const at = i;
  const aSlice = a.slice(Math.max(0, at - 20), at + 40);
  const bSlice = b.slice(Math.max(0, at - 20), at + 40);
  return `first diff at offset ${at}\n  expected: ${JSON.stringify(aSlice)}\n  actual:   ${JSON.stringify(bSlice)}`;
}

function main() {
  const samplePath = resolve(projectRoot, "sample.md");
  const raw = readFileSync(samplePath, "utf-8");

  const { frontmatter, body } = splitFrontmatter(raw);

  const allChecks: Check[] = [
    expect(
      "frontmatter 以 `type: stela-data-note` 开头",
      frontmatter.includes("type: stela-data-note"),
    ),
    expect("frontmatter 含 connection_name", frontmatter.includes("connection_name:")),
    checkRunsqlFenceCount(body, 3),
    ...checkBodyShape(body),
    ...checkDetailRoundtrip(body),
    ...checkSplitJoinIdempotent(raw),
  ];

  let ok = true;
  for (const c of allChecks) {
    const tag = c.ok ? "[ok]   " : "[FAIL] ";
    console.log(tag + c.name);
    if (!c.ok && c.detail) {
      console.log(c.detail.split("\n").map((l) => "       " + l).join("\n"));
      ok = false;
    } else if (!c.ok) {
      ok = false;
    }
  }

  if (!ok) {
    console.error("\nRound-trip check FAILED.");
    process.exit(1);
  }
  console.log("\nRound-trip check OK.");
}

main();
