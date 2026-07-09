import assert from "node:assert/strict";

import type { AiSettings } from "@shared/types";

import { callAgentTurn, callFimCompletions } from "./provider";

const settings = {
  providerMode: "openai-compatible",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  hasApiKey: true,
  sendResultSamples: true,
  maxSampleRows: 20,
  inlineCompletionEnabled: true,
  fimBaseUrl: "https://api.deepseek.com/beta/",
  fimModel: "deepseek-v4-pro",
} satisfies AiSettings;

const originalFetch = globalThis.fetch;

try {
  let capturedUrl = "";
  let capturedBody: Record<string, unknown> | null = null;
  let capturedAuth = "";

  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    capturedAuth = new Headers(init?.headers).get("authorization") ?? "";
    return new Response(
      JSON.stringify({ choices: [{ text: "customer_id" }] }),
      { status: 200 },
    );
  };

  const testApiKey = "sk-test";

  const text = await callFimCompletions({
    settings,
    apiKey: testApiKey,
    prompt: "SELECT ",
    suffix: " FROM orders",
  });

  assert.equal(text, "customer_id");
  assert.equal(capturedUrl, "https://api.deepseek.com/beta/completions");
  assert.equal(capturedAuth, ["Bearer", testApiKey].join(" "));
  assert.deepEqual(capturedBody, {
    model: "deepseek-v4-pro",
    prompt: "SELECT ",
    suffix: " FROM orders",
    max_tokens: 96,
    temperature: 0.2,
    stream: false,
  });

  await assert.rejects(
    () =>
      callFimCompletions({
        settings: { ...settings, inlineCompletionEnabled: false },
        apiKey: testApiKey,
        prompt: "SELECT ",
        suffix: "",
      }),
    /AI inline completion is disabled/,
  );

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ choices: [] }), { status: 200 });
  await assert.rejects(
    () =>
      callFimCompletions({
        settings,
        apiKey: testApiKey,
        prompt: "SELECT ",
        suffix: "",
      }),
    /AI provider returned an empty response/,
  );
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

console.log("ai provider FIM tests passed.");
