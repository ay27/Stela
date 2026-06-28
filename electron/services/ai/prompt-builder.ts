import type { AiActionKind, AiSchemaTargetContext } from "@shared/types";

import type { AiContextBundle } from "./context-builder";

function schemaTargetsForPrompt(
  targets: AiSchemaTargetContext[],
): Array<Pick<AiSchemaTargetContext, "connectionName" | "database" | "table" | "columns" | "ddlSnippet">> {
  return targets.map(({ connectionName, database, table, columns, ddlSnippet }) => ({
    connectionName,
    database,
    table,
    columns,
    ddlSnippet,
  }));
}

function instructionFor(action: AiActionKind): string {
  switch (action) {
    case "rewrite-sql":
      return "Rewrite the current SQL block. If the user instruction is empty, fix obvious syntax errors and improve performance/readability without changing intent.";
    case "ask-sql":
      return "Answer the user's question about the current SQL block. Do not rewrite or apply changes unless explicitly asked in the answer.";
    case "generate-sql":
      return "Generate SQL that answers the user's request. Prefer read-only SELECT queries unless explicitly asked otherwise.";
    case "explain-sql":
      return "Explain what the SQL does, including filters, joins, grouping, and likely assumptions.";
    case "optimize-sql":
      return "Suggest a safer or faster SQL rewrite. Explain index/schema assumptions.";
    case "debug-query":
      return "Diagnose the failed query. Be direct: identify where it failed, why it failed, and how to fix it. Provide a corrected SQL draft if possible.";
    case "explain-result":
      return "Explain the result set in business-friendly language using only the provided sampled rows and metadata.";
    case "summarize-diff":
      return "Summarize changes between result versions. Call out added, removed, changed, and schema changes.";
    case "find-anomalies":
      return "Look for anomalies in the sampled rows and explain why they may matter.";
    case "write-analysis":
      return "Write a concise Markdown analysis paragraph suitable for insertion into the note.";
    case "rewrite-selection":
      return "Rewrite the selected Markdown for clarity while preserving meaning.";
    case "add-limitations":
      return "Add assumptions, methodology, and limitations for the current analysis.";
    case "explain-table":
      return "Explain the table purpose and important columns from the schema context.";
    case "suggest-joins":
      return "Suggest likely joins involving this table. Be explicit when a join is an inference.";
    case "generate-data-dictionary":
      return "Generate a compact Markdown data dictionary for the table and columns.";
    case "find-related-queries":
      return "List related previous queries and explain why they are relevant.";
  }
}

function languageInstruction(locale: string | undefined): string {
  return locale === "zh"
    ? "Respond in Simplified Chinese."
    : "Respond in English.";
}

function outputRulesFor(action: AiActionKind): string[] {
  const shared = [
    "Keep the answer short and direct.",
    "Avoid long introductions, generic caveats, and repeated context.",
    "Use Markdown bullets when they make the answer easier to scan.",
  ];
  if (action === "rewrite-sql") {
    return [
      "Use only the current RunSQL block, the user's rewrite instruction, the SQL dialect, the provided schema targets, and the error message if provided.",
      "Do not use note Markdown, result rows, result metadata, or unrelated run history for this rewrite.",
      "Return only the rewritten SQL in one fenced sql block.",
      "Do not include prose unless the SQL cannot be rewritten.",
    ];
  }
  if (action === "ask-sql") {
    return [
      ...shared,
      "Answer the user's question directly.",
      "Do not rewrite the SQL unless the user asks for a rewrite in the question.",
    ];
  }
  if (action === "debug-query") {
    return [
      ...shared,
      "For SQL errors, answer in this order: where it failed, how to fix it, corrected SQL.",
      "If the error is a syntax error, focus on the exact syntax issue instead of explaining the whole query.",
    ];
  }
  if (action === "generate-sql" || action === "optimize-sql") {
    return [
      ...shared,
      "Prioritize the SQL block. Keep explanation to at most three bullets.",
    ];
  }
  if (action === "explain-result" || action === "summarize-diff" || action === "find-anomalies") {
    return [
      ...shared,
      "Focus only on the most important findings supported by the provided sample.",
    ];
  }
  return shared;
}

function requestContextForPrompt(bundle: AiContextBundle) {
  const ctx = bundle.request.context;
  if (bundle.request.action === "rewrite-sql") {
    return {
      source: ctx.source,
      connectionName: ctx.connectionName,
      sql: ctx.sql,
      selectedText: ctx.selectedText,
      errorMessage: ctx.errorMessage,
      userInstruction: ctx.userInstruction,
    };
  }
  const {
    schemas: _schemas,
    schema: _schema,
    connector: _connector,
    ...rest
  } = ctx;
  return rest;
}

export function buildPrompt(bundle: AiContextBundle): { system: string; user: string } {
  const action = bundle.request.action;
  const connector = bundle.request.context.connector ?? null;
  const dialect = connector?.dialect ?? connector?.displayName ?? connector?.kind ?? null;
  return {
    system: [
      "You are Stela AI, an assistant for SQL data notes.",
      languageInstruction(bundle.request.locale),
      dialect
        ? `SQL dialect: ${dialect}. Follow the syntax and functions of this connector.`
        : "SQL dialect: unknown. Do not invent dialect-specific syntax unless the context proves it.",
      "Use search-first structured context: SQL symbols, schema, current note, result samples, and exact run history.",
      "Do not claim access to rows or schema that were not provided.",
      "Do not recommend auto-running mutation SQL. Mark INSERT/UPDATE/DELETE/DDL as requiring human review.",
      "Return concise Markdown. When returning SQL, put it in fenced sql blocks.",
      ...outputRulesFor(action),
    ].join("\n"),
    user: JSON.stringify(
      {
        task: instructionFor(action),
        action,
        locale: bundle.request.locale ?? "en",
        connector,
        contextSummary: bundle.summary,
        sqlSymbols: bundle.symbols,
        ...(bundle.schemaTargets.length > 0
          ? { schemaTargets: schemaTargetsForPrompt(bundle.schemaTargets) }
          : {}),
        requestContext: requestContextForPrompt(bundle),
        relatedRuns:
          action === "rewrite-sql"
            ? []
            : bundle.relatedRuns.map((run) => ({
                runId: run.runId,
                status: run.status,
                connectionName: run.connectionName,
                notePath: run.notePath,
                rowCount: run.rowCount,
                message: run.message,
                sql: run.sql,
              })),
      },
      null,
      2,
    ),
  };
}

