import assert from "node:assert/strict";

import type { AiProviderProfile } from "@shared/types";

import {
  completeNativeDeepSeekFim,
  usesNativeDeepSeekFim,
} from "./inline-completion-transport";

const profile: AiProviderProfile = {
  id: "completion",
  name: "DeepSeek",
  vendorId: "deepseek",
  model: "deepseek-v4-flash",
  baseUrl: "",
  contextWindow: 1_000_000,
  reasoningEffort: "max",
  hasApiKey: true,
};

assert.equal(usesNativeDeepSeekFim(profile), true);
assert.equal(usesNativeDeepSeekFim({ ...profile, vendorId: "custom" }), false);
assert.equal(usesNativeDeepSeekFim({ ...profile, model: "deepseek-v4-pro" }), false);

let capturedUrl = "";
let capturedBody: Record<string, unknown> | null = null;
const result = await completeNativeDeepSeekFim({
  apiKey: "secret",
  model: profile.model,
  prompt: "select ",
  suffix: " from users",
  signal: new AbortController().signal,
  fetchImpl: (async (input, init) => {
    capturedUrl = String(input);
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        choices: [{ text: "id", logprobs: { token_logprobs: [-0.2, -0.4] } }],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 1,
          prompt_cache_hit_tokens: 12,
          prompt_cache_miss_tokens: 8,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch,
});

assert.equal(capturedUrl, "https://api.deepseek.com/beta/completions");
assert.deepEqual(capturedBody, {
  model: "deepseek-v4-flash",
  prompt: "select ",
  suffix: " from users",
  max_tokens: 64,
  temperature: 0,
  logprobs: 5,
  stop: ["\n\n"],
  stream: false,
});
assert.equal(result.text, "id");
assert.equal(result.averageLogprob, -0.30000000000000004);
assert.deepEqual(result.usage, {
  promptTokens: 20,
  completionTokens: 1,
  cacheHitTokens: 12,
  cacheMissTokens: 8,
});

await assert.rejects(
  completeNativeDeepSeekFim({
    apiKey: "secret",
    model: profile.model,
    prompt: "select ",
    suffix: "",
    signal: new AbortController().signal,
    fetchImpl: (async () =>
      new Response(JSON.stringify({ error: { message: "unsupported" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch,
  }),
  /DeepSeek FIM failed: unsupported/,
);

console.log("inline completion transport tests passed.");
