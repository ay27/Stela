import assert from "node:assert/strict";

import type { AiSettings } from "@shared/types";

import { callAgentTurn } from "./provider";

const settings = {
  providerMode: "openai-compatible",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  hasApiKey: true,
  sendResultSamples: true,
  maxSampleRows: 20,
  agentMaxIterations: 200,
  agentWallClockMs: 300_000,
  agentAllowMutations: false,
} satisfies AiSettings;

const originalFetch = globalThis.fetch;

try {
  // ---------- callAgentTurn ----------

  let capturedAgentBody: Record<string, unknown> | null = null;
  globalThis.fetch = async (_input, init) => {
    capturedAgentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "run_sql", arguments: '{"sql":"SELECT 1"}' },
                },
              ],
            },
          },
        ],
      }),
      { status: 200 },
    );
  };

  const tools = [
    {
      type: "function" as const,
      function: {
        name: "run_sql",
        description: "run a sql query",
        parameters: { type: "object", properties: { sql: { type: "string" } } },
      },
    },
  ];

  const turn = await callAgentTurn({
    settings,
    apiKey: "sk-test",
    messages: [{ role: "user", content: "hi" }],
    tools,
  });
  assert.equal(turn.content, null);
  assert.equal(turn.toolCalls.length, 1);
  assert.equal(turn.toolCalls[0]?.function.name, "run_sql");
  assert.equal((capturedAgentBody as Record<string, unknown>).tool_choice, "auto");
  assert.deepEqual((capturedAgentBody as Record<string, unknown>).tools, tools);

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "done" } }] }), {
      status: 200,
    });
  const finalTurn = await callAgentTurn({
    settings,
    apiKey: "sk-test",
    messages: [{ role: "user", content: "hi" }],
    tools,
  });
  assert.equal(finalTurn.content, "done");
  assert.deepEqual(finalTurn.toolCalls, []);

  await assert.rejects(
    () =>
      callAgentTurn({
        settings: { ...settings, providerMode: "disabled" },
        apiKey: "sk-test",
        messages: [],
        tools,
      }),
    /AI provider is disabled/,
  );
} finally {
  globalThis.fetch = originalFetch;
}

console.log("ai provider tests passed.");
