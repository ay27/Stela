/**
 * AI 自然语言 → SQL 索引 filter JSON（plan Part D）。
 *
 * 边界很关键："AI 只翻译，不作答"——这里只负责把自然语言问题转成
 * `SqlIndexFilter`，真正的命中判定完全交给 `sql-index.ts` 的确定性倒排索引求
 * 交集。因此本模块对模型输出的信任级别等同于任何不可信的 renderer 输入：
 * 用 zod 校验 shape，untrusted 的表名/列名允许原样透传（找不到就是 0 命中，
 * 不会产生"看起来命中但其实是幻觉"的结果）。
 */

import { z } from "zod";

import type { SqlIndexFacets, SqlIndexFilter, SqlIndexOperation } from "@shared/types";

const OPERATION_VALUES = [
  "select",
  "insert",
  "replace",
  "update",
  "delete",
  "upsert",
  "ddl",
  "other",
] as const satisfies readonly SqlIndexOperation[];

const modelFilterSchema = z
  .object({
    operations: z.array(z.enum(OPERATION_VALUES)).optional(),
    readTable: z.string().min(1).max(256).nullable().optional(),
    writeTable: z.string().min(1).max(256).nullable().optional(),
    writeColumn: z
      .object({
        table: z.string().min(1).max(256),
        column: z.string().min(1).max(256),
      })
      .nullable()
      .optional(),
    unmatched: z.array(z.string().max(256)).optional(),
  })
  .partial();

export interface ParsedSqlQuery {
  filter: SqlIndexFilter;
  warnings: string[];
}

function truncateList(values: string[], max: number): string {
  if (values.length === 0) return "(none)";
  const shown = values.slice(0, max);
  const suffix = values.length > max ? ` ...(+${values.length - max} more)` : "";
  return shown.join(", ") + suffix;
}

export function buildSqlQueryParsePrompt(
  facets: SqlIndexFacets,
  locale: "zh" | "en" = "zh",
): { system: string; instructions: string } {
  const zh = locale === "zh";
  const system = zh
    ? `你是一个把自然语言问题翻译成结构化 SQL 检索条件的助手。你**只做翻译，不作答、不猜测表结构**。
你必须只输出一个 JSON 对象，不要输出任何解释文字、不要用 markdown 代码块包裹。
JSON schema：
{
  "operations"?: string[]  // 取值只能是 select/insert/replace/update/delete/upsert/ddl/other 的子集
  "readTable"?: string     // 被查询/读取的表名，只从下面「已知表」列表里选，找不到匹配就不要填
  "writeTable"?: string    // 被写入(insert/update/delete)的表名，同上
  "writeColumn"?: { "table": string, "column": string } // 被写入的具体字段，table/column 都要从已知列表里选
  "unmatched"?: string[]   // 用户提到但在已知表/列里找不到对应项的词，原样列出
}
只填用户问题里明确提到的字段，没提到的字段完全不要出现在 JSON 里。`
    : `You translate a natural-language question into a structured SQL search filter. You ONLY translate — you never answer the question or guess schema.
Output ONLY a single JSON object, no prose, no markdown code fences.
JSON schema:
{
  "operations"?: string[]  // subset of select/insert/replace/update/delete/upsert/ddl/other
  "readTable"?: string     // table being read, must come from the "known tables" list below; omit if no match
  "writeTable"?: string    // table being written (insert/update/delete), same constraint
  "writeColumn"?: { "table": string, "column": string } // specific written column, both from known lists
  "unmatched"?: string[]   // terms the user mentioned that have no match in known tables/columns, listed verbatim
}
Only include fields explicitly implied by the question; omit everything else.`;

  const instructions = zh
    ? `已知表:${truncateList(facets.tables, 200)}\n已知列名:${truncateList(facets.columns, 200)}\n已知操作类型:${truncateList(facets.operations, 8)}`
    : `Known tables: ${truncateList(facets.tables, 200)}\nKnown columns: ${truncateList(facets.columns, 200)}\nKnown operations: ${truncateList(facets.operations, 8)}`;

  return { system, instructions };
}

/** 从模型原始文本输出中提取第一个 JSON 对象（容忍模型偶尔仍包了 markdown 代码块）。 */
function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("model output does not contain a JSON object");
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

export function parseModelFilterOutput(text: string): ParsedSqlQuery {
  const raw = extractJsonObject(text);
  const parsed = modelFilterSchema.parse(raw);
  const filter: SqlIndexFilter = {};
  if (parsed.operations && parsed.operations.length > 0) {
    filter.operations = parsed.operations;
  }
  if (parsed.readTable) filter.readTable = parsed.readTable;
  if (parsed.writeTable) filter.writeTable = parsed.writeTable;
  if (parsed.writeColumn) filter.writeColumn = parsed.writeColumn;
  return { filter, warnings: parsed.unmatched ?? [] };
}
