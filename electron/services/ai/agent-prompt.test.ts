import assert from "node:assert/strict";

import { buildSystemPrompt, buildUserContent } from "./agent-prompt";

const prompt = buildSystemPrompt("STATIC SKILL LIMITS");
assert.equal(prompt, buildSystemPrompt("STATIC SKILL LIMITS"));
assert.doesNotMatch(prompt, /prompt-test|warehouse|orders|show the query/);

assert.match(prompt, /for zh, write all conversational narration and the final answer in Simplified Chinese/);
assert.match(prompt, /for en, write them in English/);
assert.match(prompt, /conversation and final-answer text, SQL MUST use fenced ```sql```/);
assert.match(prompt, /never label it ```runsql```/);
assert.match(prompt, /Only Markdown content being written into a vault note may use executable fenced ```runsql```/);
assert.match(prompt, /Never preserve already fetched numbers or rows by turning them into SELECT literals/);
assert.match(prompt, /strategy-review checkpoint may appear/);
assert.match(prompt, /Use preset trend/);
assert.match(prompt, /use a flow card for processes/);
assert.match(prompt, /Omit Flow node positions because layout is user-owned/);
assert.match(prompt, /When entry_point is canvas-refresh/);
assert.match(prompt, /exactly one final update_analysis_canvas call/);
assert.match(prompt, /prefer one database-side aggregation over repeated preview probes/);
assert.match(prompt, /Preserve source values exactly/);
assert.match(prompt, /connector-declared safe aggregate requests/);

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

console.log("agent prompt cache-boundary tests passed.");
