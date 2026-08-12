import assert from "node:assert/strict";

import { buildSystemPrompt, buildUserContent } from "./agent-prompt";

const prompt = buildSystemPrompt("STATIC SKILL LIMITS");
assert.equal(prompt, buildSystemPrompt("STATIC SKILL LIMITS"));
assert.doesNotMatch(prompt, /prompt-test|warehouse|orders|show the query/);

assert.match(prompt, /conversation and final-answer text, SQL MUST use fenced ```sql```/);
assert.match(prompt, /never label it ```runsql```/);
assert.match(prompt, /Only Markdown content being written into a vault note may use executable fenced ```runsql```/);
assert.match(prompt, /Never preserve already fetched numbers or rows by turning them into SELECT literals/);
assert.match(prompt, /Use preset trend/);
assert.match(prompt, /use a flow card for processes/);
assert.match(prompt, /Omit Flow node positions because layout is user-owned/);

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
    skillMetadata: "orders metric",
  },
);
assert.match(user, /^<stela_turn_context>/);
assert.match(user, /entry_point: runsql-fix/);
assert.match(user, /active_connection: warehouse \(kind: duckdb, dialect: DuckDB SQL\)/);
assert.match(user, /active_workspace_resource: \{"kind":"note","path":"reports\/orders.md"\}/);
assert.match(user, /"rewriteTargetId":"target-1"/);
assert.match(user, /Execution error:/);
assert.match(user, /"kind":"resource","resourceId":"resource_table_/);
assert.match(user, /<user_request>\n\n\{"version":1,"segments":/);
assert.match(user, /<\/user_request>$/);

console.log("agent prompt cache-boundary tests passed.");
