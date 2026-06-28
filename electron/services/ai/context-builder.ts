import type {
  AiCompleteRequest,
  AiRequestContext,
  AiResultContext,
  AiSchemaTargetContext,
  RunRecord,
} from "@shared/types";

import * as resultStore from "../result-store";
import { redactForPrompt } from "./redaction";
import { extractSqlSymbols, type SqlSymbols } from "./sql-symbols";

const NOTE_CHAR_BUDGET = 12_000;
const SQL_CHAR_BUDGET = 16_000;
const HISTORY_LIMIT = 12;
const SCHEMA_DDL_BUDGET = 4_000;

export interface AiContextBundle {
  request: AiCompleteRequest;
  symbols: SqlSymbols;
  schemaTargets: AiSchemaTargetContext[];
  relatedRuns: RunRecord[];
  summary: string[];
}

function truncateText(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n\n[truncated ${value.length - max} chars]`;
}

function identifierScore(sql: string, symbols: SqlSymbols, run: RunRecord): number {
  const haystack = `${run.sql}\n${run.connectionName}\n${run.notePath ?? ""}`.toLowerCase();
  let score = 0;
  for (const table of symbols.tables) {
    if (haystack.includes(table.toLowerCase())) score += 5;
  }
  for (const column of symbols.referencedColumns) {
    if (haystack.includes(column.toLowerCase())) score += 2;
  }
  if (sql && run.sql.trim() === sql.trim()) score += 8;
  if (run.status === "ok") score += 2;
  if (run.status === "err") score += 1;
  score += Math.max(0, 2 - (Date.now() - run.startedAt) / (30 * 24 * 60 * 60 * 1000));
  return score;
}

function rankedRelatedRuns(ctx: AiRequestContext, symbols: SqlSymbols): RunRecord[] {
  const sql = ctx.sql ?? "";
  try {
    return resultStore
      .listRuns()
      .map((run) => ({
        run,
        score:
          identifierScore(sql, symbols, run) +
          (ctx.connectionName && run.connectionName === ctx.connectionName ? 6 : 0) +
          (ctx.notePath && run.notePath === ctx.notePath ? 4 : 0),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.run.startedAt - a.run.startedAt)
      .slice(0, HISTORY_LIMIT)
      .map((item) => item.run);
  } catch {
    return [];
  }
}

function capRows(result: AiResultContext | null | undefined, maxRows: number): AiResultContext | null {
  if (!result) return null;
  const rows = result.rows?.slice(0, Math.max(0, maxRows));
  return { ...result, rows };
}

function capSchemaTargets(schemas: AiSchemaTargetContext[] | null | undefined): AiSchemaTargetContext[] {
  return (schemas ?? []).slice(0, 8).map((schema) => ({
    ...schema,
    columns: schema.columns?.slice(0, 120),
    ddlSnippet: truncateText(schema.ddlSnippet, SCHEMA_DDL_BUDGET),
  }));
}

function collectSchemaTargets(ctx: AiRequestContext): AiSchemaTargetContext[] {
  if (ctx.schemas && ctx.schemas.length > 0) {
    return capSchemaTargets(ctx.schemas);
  }
  if (ctx.schema) {
    return capSchemaTargets([ctx.schema]);
  }
  return [];
}

export function buildAiContext(
  request: AiCompleteRequest,
  maxSampleRows: number,
): AiContextBundle {
  const ctx = request.context;
  const sql = truncateText(ctx.sql, SQL_CHAR_BUDGET);
  const symbols = extractSqlSymbols(sql ?? "");
  const schemaTargets = collectSchemaTargets(ctx);
  const safeRequest: AiCompleteRequest = redactForPrompt({
    ...request,
    context: {
      ...ctx,
      sql,
      noteMarkdown: truncateText(ctx.noteMarkdown, NOTE_CHAR_BUDGET),
      selectedText: truncateText(ctx.selectedText, NOTE_CHAR_BUDGET),
      result: capRows(ctx.result, maxSampleRows),
      schemas: schemaTargets,
    },
  });
  const relatedRuns = redactForPrompt(rankedRelatedRuns(ctx, symbols));
  const summary = [
    `source=${ctx.source}`,
    `action=${request.action}`,
    ctx.connectionName ? `connection=${ctx.connectionName}` : "",
    relatedRuns.length > 0 ? `relatedRuns=${relatedRuns.length}` : "",
  ].filter(Boolean);
  return { request: safeRequest, symbols, schemaTargets, relatedRuns, summary };
}

