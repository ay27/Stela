import assert from "node:assert/strict";

import { buildSystemPrompt, buildUserContent } from "./agent-prompt";

const prompt = buildSystemPrompt();
assert.equal(prompt, buildSystemPrompt());
assert.ok(prompt.length <= 6_000, `stable system prompt must stay <= 6000 chars, got ${prompt.length}`);
assert.doesNotMatch(prompt, /prompt-test|warehouse|orders|show the query/);

assert.match(prompt, /for zh, write all conversational narration and the final answer in Simplified Chinese/);
assert.match(prompt, /for en, write them in English/);
assert.match(prompt, /active_guidance array is operational guidance for that run only/);
assert.match(prompt, /never invent tables, columns, row values, metric definitions/);
assert.match(prompt, /For physical data meaning/);
assert.match(prompt, /For business meaning/);
assert.match(prompt, /Work only on uncertainties that can materially change the requested answer/);
assert.match(prompt, /Each tool call must either compute a requested result or resolve a material uncertainty/);
assert.match(prompt, /Use analysis stages conditionally, not as a checklist/);
assert.match(prompt, /Locate sources only when they are unknown/);
assert.match(prompt, /Challenge the working conclusion only when evidence contradicts it/);
assert.match(prompt, /Do not investigate adjacent questions or non-material limitations unless the user asks/);
assert.match(prompt, /Do not plan a routine locate -> schema -> query lookup/);
assert.match(prompt, /Use search_sql_usage only when established joins, filters, write direction, or business conventions matter/);
assert.match(prompt, /In chat and final answers, show SQL only in fenced ```sql``` blocks/);
assert.match(prompt, /In Vault Markdown, use ```runsql``` only for intentionally executable SQL/);
assert.match(prompt, /End query-backed answers with one compact data-basis line/);
assert.match(prompt, /strategy-review checkpoint may appear/);
assert.doesNotMatch(prompt, /Use preset trend|When entry_point is canvas-refresh|Skill limits:/);

const routineUser = buildUserContent(
  { runId: "routine", prompt: "How many rows?", locale: "en" },
  {
    connection: null,
    dialect: null,
    queryLanguages: ["sql"],
    contextSources: {
      vault_notes: "empty",
      skills: "empty",
      sql_history: "empty",
      canvas: "empty",
      clarification: "unavailable",
    },
  },
);
assert.match(routineUser, /active_guidance: \[\]/);
assert.ok(routineUser.indexOf("active_guidance:") < routineUser.indexOf("resource_catalog:"));
assert.ok(routineUser.indexOf("active_guidance:") < routineUser.indexOf("<user_request>"));

const user = buildUserContent(
  {
    runId: "prompt-test",
    prompt: "show the query",
    entryPoint: "runsql-fix",
    locale: "zh",
    connectionName: "warehouse",
    workspaceContext: { kind: "note", path: "reports/orders.md" },
    mentionedTables: ["analytics.orders"],
    attachments: [{
      kind: "runsql",
      label: "broken query",
      sql: "select * from analytics.orders",
      rewriteTargetId: "target-1",
      errorMessage: "unknown column secret=abcd",
    }],
  },
  {
    connection: { kind: "duckdb" } as never,
    dialect: "DuckDB SQL",
    availableConnections: [
      { name: "archive", kind: "postgresql", dialect: "PostgreSQL" },
      { name: "warehouse", kind: "duckdb", dialect: "DuckDB SQL" },
    ],
    skillMetadata: "orders metric",
    queryLanguages: ["sql"],
    contextSources: {
      vault_notes: "available",
      skills: "available",
      sql_history: "available",
      canvas: "unknown",
      clarification: "available",
    },
  },
);
assert.match(user, /^<stela_turn_context>/);
assert.match(user, /entry_point: runsql-fix/);
assert.match(user, /active_connection: warehouse \(kind: duckdb, dialect: DuckDB SQL, query_languages: sql, mongo_operations: find\)/);
assert.match(user, /available_connections: \[\{"name":"archive","kind":"postgresql","dialect":"PostgreSQL"\}/);
assert.match(user, /active_workspace_resource: \{"kind":"note","path":"reports\/orders.md"\}/);
assert.match(user, /"rewriteTargetId":"target-1"/);
assert.match(user, /context_sources: \{"vault_notes":"available"/);
assert.match(user, /active_guidance: \[\{"id":"runsql_rewrite"/);
assert.match(user, /\{"id":"skills"/);
assert.doesNotMatch(user, /\{"id":"mongodb"/);
assert.match(user, /Attached RunSQL and selection bodies are bounded current-turn evidence/);
assert.match(user, /only when missing context could materially change the answer/);
assert.doesNotMatch(user, /Inspect table schemas and read note\/Canvas paths with tools before relying/);
assert.match(user, /Execution error:/);
assert.match(user, /"kind":"resource","resourceId":"resource_table_/);
assert.match(user, /<user_request>\n\n\{"version":1,"segments":/);
assert.match(user, /<\/user_request>$/);

const canvasRefreshUser = buildUserContent({
  runId: "canvas-refresh-test",
  prompt: "Refresh the Canvas",
  entryPoint: "canvas-refresh",
  canvasRefresh: { path: "reports/revenue.stela.canvas", sourceId: "daily" },
  locale: "en",
});
assert.match(canvasRefreshUser, /entry_point: canvas-refresh/);
assert.match(canvasRefreshUser, /canvas_refresh: \{"path":"reports\/revenue\.stela\.canvas","sourceId":"daily"\}/);
assert.match(canvasRefreshUser, /active_guidance: \[\{"id":"canvas_refresh"/);
assert.doesNotMatch(canvasRefreshUser, /\{"id":"canvas_context"/);

const canvasWorkspaceUser = buildUserContent(
  {
    runId: "canvas-workspace-test",
    prompt: "Explain this",
    workspaceContext: { kind: "canvas", path: "reports/revenue.stela.canvas" },
  },
);
assert.match(canvasWorkspaceUser, /active_guidance: \[\{"id":"canvas_context"/);

const mongoUser = buildUserContent(
  { runId: "mongo-test", prompt: "Count documents" },
  { connection: null, dialect: null, queryLanguages: ["mongodb"], mongoOperations: ["find", "aggregate"] },
);
assert.match(mongoUser, /active_guidance: \[\{"id":"mongodb"/);
assert.match(mongoUser, /safe aggregate for grouping, ranking, expressions, and counts/);

console.log("agent prompt cache-boundary tests passed.");
