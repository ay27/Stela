/**
 * MCP 工具契约自测：
 *
 * - 所有公开工具都有 description + zod inputSchema
 * - 工具名字稳定（外部 LLM client 会硬编码）
 * - inputSchema 是 zod ZodObject
 * - listToolNames 覆盖所有 TOOL_HANDLERS key
 *
 * 不验证 handler 行为（依赖真实 vault），那是 e2e 测试范围。
 *
 * 运行：
 *
 *     npx tsx electron/services/mcp/tools.test.ts
 */

import { z } from "zod";

import {
  TOOL_HANDLERS,
  TOOL_SCHEMAS,
  listToolNames,
  type ToolName,
} from "./tools";

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

const checks: Check[] = [];

const EXPECTED_TOOLS: ToolName[] = [
  "search_notes",
  "read_note",
  "read_block",
  "list_runs",
  "query_result_page",
  "read_result_schema",
  "get_backlinks",
];

const names = listToolNames();

checks.push({
  name: "tool name set is stable",
  ok:
    names.length === EXPECTED_TOOLS.length &&
    EXPECTED_TOOLS.every((t) => names.includes(t)),
  detail: names.join(","),
});

for (const t of EXPECTED_TOOLS) {
  const def = TOOL_SCHEMAS[t];
  checks.push({
    name: `${t} has non-empty description`,
    ok: typeof def?.description === "string" && def.description.length > 10,
  });
  const isZodObject = def?.inputSchema instanceof z.ZodObject;
  checks.push({
    name: `${t} inputSchema is ZodObject`,
    ok: isZodObject,
  });
  checks.push({
    name: `${t} handler registered`,
    ok: typeof TOOL_HANDLERS[t] === "function",
  });
}

// search_notes 必填 query，可选 topK / mode
{
  const def = TOOL_SCHEMAS.search_notes;
  const ok1 = def.inputSchema.safeParse({ query: "hi" }).success;
  const ok2 = def.inputSchema.safeParse({ query: "" }).success;
  const ok3 = def.inputSchema.safeParse({ query: "hi", mode: "hybrid" }).success;
  const ok4 = def.inputSchema.safeParse({ query: "hi", mode: "garbage" }).success;
  checks.push({ name: "search_notes accepts {query}", ok: ok1 });
  checks.push({ name: "search_notes rejects empty query", ok: !ok2 });
  checks.push({ name: "search_notes accepts mode hybrid", ok: ok3 });
  checks.push({ name: "search_notes rejects mode garbage", ok: !ok4 });
}

// read_note 必填 path
{
  const def = TOOL_SCHEMAS.read_note;
  checks.push({
    name: "read_note rejects missing path",
    ok: !def.inputSchema.safeParse({}).success,
  });
  checks.push({
    name: "read_note accepts {path}",
    ok: def.inputSchema.safeParse({ path: "foo.md" }).success,
  });
}

// query_result_page 默认 offset/limit
{
  const def = TOOL_SCHEMAS.query_result_page;
  const parsed = def.inputSchema.safeParse({ runId: "r1" });
  checks.push({
    name: "query_result_page applies defaults",
    ok: parsed.success && parsed.data.offset === 0 && parsed.data.limit === 50,
    detail: JSON.stringify(parsed),
  });
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
