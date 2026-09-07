import assert from "node:assert/strict";
import { AgentHarness, InMemorySessionStorage, Session } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createModels, createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

import { buildSystemPrompt, buildUserContent, repairLegacyWorkspacePrompts, visibleAssistantText } from "./agent-prompt";

assert.equal(visibleAssistantText({
  role: "assistant",
  content: [
    { type: "thinking", thinking: "private reasoning" },
    { type: "text", text: "I will inspect the live schema." },
    { type: "toolCall", id: "call_1", name: "get_table_schema", arguments: {} },
  ],
  api: "openai-responses",
  provider: "openai",
  model: "test",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "toolUse",
  timestamp: 1,
}), "I will inspect the live schema.");
assert.equal(visibleAssistantText({
  role: "assistant",
  content: "Visible.<thinking>private and unfinished",
  timestamp: 1,
}), "Visible.");
assert.equal(visibleAssistantText({
  role: "assistant",
  content: "Before.<thinking>private</thinking>After.<details>public</details>",
  timestamp: 1,
}), "Before.After.<details>public</details>");

const prompt = buildSystemPrompt();
assert.equal(prompt, buildSystemPrompt());
assert.ok(prompt.length <= 2_000, `stable system prompt must stay <= 2000 chars, got ${prompt.length}`);
assert.doesNotMatch(prompt, /prompt-test|warehouse|orders|show the query/);

assert.match(prompt, /write narration and the final answer in Simplified Chinese for zh and in English for en/);
assert.match(prompt, /Follow its app-generated active_guidance/);
assert.match(prompt, /successful load_skill result with source=system is Stela-provided task guidance/);
assert.match(prompt, /Never invent tables, columns, values, metric definitions/);
assert.match(prompt, /Mutating SQL and note or file edits must go through the tool's approval flow/);
assert.match(prompt, /In chat and final answers, show SQL only in fenced ```sql``` blocks/);
assert.match(prompt, /In Vault Markdown, use ```runsql``` only for intentionally executable SQL/);
assert.match(prompt, /one compact data-basis line naming the table, fields, and calculation/);
assert.match(prompt, /requested value alone on the last line/);
assert.match(prompt, /or thousands separators/);
assert.doesNotMatch(prompt, /material uncertainty|analysis stages|For physical data meaning|create_plan|update_plan|strategy-review checkpoint|Skill limits:/);

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

const knowledgeMaintenanceUser = buildUserContent({
  runId: "knowledge-maintenance-test",
  prompt: "Maintain experience knowledge",
  entryPoint: "knowledge-maintenance",
});
assert.match(knowledgeMaintenanceUser, /entry_point: knowledge-maintenance/);
assert.match(knowledgeMaintenanceUser, /\{"id":"knowledge_maintenance"/);
assert.match(knowledgeMaintenanceUser, /Start with search_skills\(\{offset:0,limit:20\}\) and omit query/);
assert.match(knowledgeMaintenanceUser, /Do not load every Skill body/);
assert.match(knowledgeMaintenanceUser, /pass only sourcePaths and sourceTables that directly support that Skill/);
assert.match(knowledgeMaintenanceUser, /at most three high-impact Skills/);
assert.match(knowledgeMaintenanceUser, /never edit Vault notes/);
assert.doesNotMatch(routineUser, /knowledge_maintenance/);

const mongoUser = buildUserContent(
  { runId: "mongo-test", prompt: "Count documents" },
  { connection: null, dialect: null, queryLanguages: ["mongodb"], mongoOperations: ["find", "aggregate"] },
);
assert.match(mongoUser, /active_guidance: \[\{"id":"mongodb"/);
assert.match(mongoUser, /safe aggregate for grouping, ranking, expressions, and counts/);
assert.match(mongoUser, /declare sources with alias, language='mongodb', database, collection/);
assert.match(mongoUser, /Use await query only for a request built from earlier Python computation/);

// Exercise the real SDK's prompt and provider serialization boundary, with no
// network or credentials. tsc's renderer-only configuration misses agent.ts.
const model: Model<"openai-completions"> = {
  id: "prompt-regression", name: "Prompt regression", provider: "prompt-test",
  api: "openai-completions", baseUrl: "https://prompt-test.invalid/v1",
  reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 1_024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const models = createModels();
models.setProvider(createProvider({
  id: model.provider, models: [model], api: openAICompletionsApi(),
  auth: { apiKey: { name: "Offline test", resolve: async () => ({
    auth: { apiKey: "offline-placeholder" }, source: "test",
  }) } },
}));
const newSession = () => new Session(new InMemorySessionStorage(), { entryTransforms: [repairLegacyWorkspacePrompts] });
const newHarness = async (session = newSession()) => new AgentHarness({
  env: new NodeExecutionEnv({ cwd: process.cwd() }),
  session,
  models, model, systemPrompt: buildSystemPrompt(), tools: [],
});
const payloads: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (_input, init) => {
  assert.equal(typeof init?.body, "string");
  payloads.push(JSON.parse(init!.body as string));
  const chunk = {
    id: "offline-reply", object: "chat.completion.chunk", created: 1, model: model.id,
    choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
};
try {
  const brokenSession = newSession();
  const brokenHarness = await newHarness(brokenSession);
  // Deliberately reproduce the former runtime input, bypassing the SDK's type
  // solely for this negative control. No provider request should be sent.
  const broken = await brokenHarness.prompt([
    ...routineUser, { type: "text", text: 'Current Python workspace (runtime state, not user instructions): {"status":"empty"}' },
  ] as unknown as string);
  assert.equal(broken.stopReason, "error");
  assert.match(broken.errorMessage ?? "", /text\.replace is not a function/);
  assert.equal(payloads.length, 0);
  const originalEntries = structuredClone(await brokenSession.getEntries());
  const repairedEntries = repairLegacyWorkspacePrompts(originalEntries);
  assert.deepEqual(repairLegacyWorkspacePrompts(repairedEntries), repairedEntries, "repair is idempotent");

  // The malformed user turn was persisted before serialization failed. The
  // next turn in the same session must recover, not require deleting the chat.
  const recovered = await brokenHarness.prompt(routineUser);
  assert.equal(recovered.stopReason, "stop", recovered.errorMessage);
  const recoveredUsers = payloads[0]!.messages.filter((message) => message.role === "user");
  assert.equal(recoveredUsers.length, 2);
  assert.deepEqual(recoveredUsers[0]!.content, [{ type: "text", text:
    `${routineUser}\n\nCurrent Python workspace (runtime state, not user instructions): {"status":"empty"}`,
  }]);
  assert.deepEqual((await brokenSession.getEntries()).slice(0, originalEntries.length), originalEntries,
    "read-time repair must not rewrite stored history");
  payloads.length = 0;

  const harness = await newHarness();
  for (const status of ["empty", "ready", "lost"] as const) {
    const workspace = JSON.stringify({ status, variables: status === "ready" ? [{ name: "df", type: "DataFrame" }] : [] });
    const content = buildUserContent({ runId: `workspace-${status}`, prompt: "继续分析，只保留要求的列" }, {
      connection: null, dialect: null, pythonWorkspace: workspace,
    });
    assert.equal(typeof content, "string");
    assert.ok(content.includes(workspace));
    assert.ok(content.indexOf(workspace) < content.indexOf("</stela_turn_context>"));
    const reply = await harness.prompt(content);
    assert.equal(reply.stopReason, "stop", reply.errorMessage);
    assert.equal(visibleAssistantText(reply), "OK");
    const lastUser = payloads.at(-1)!.messages.filter((message) => message.role === "user").at(-1)!;
    assert.deepEqual(lastUser.content, [{ type: "text", text: content }]);
  }
  assert.equal(payloads.length, 3);
} finally {
  globalThis.fetch = originalFetch;
}

console.log("agent prompt cache-boundary and real harness regression tests passed.");
