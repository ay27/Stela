import assert from "node:assert/strict";
import { AgentHarness, InMemorySessionStorage, Session } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createModels, createProvider, createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { Type } from "@earendil-works/pi-ai";
import { withGenerationRecovery, isTransientGenerationError, type IGenerationDiagnostic } from "./generation-recovery";

const model: Model<"openai-completions"> = { id: "recovery-test", name: "Recovery", provider: "offline",
  api: "openai-completions", baseUrl: "https://offline.invalid", reasoning: false, input: ["text"],
  contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const message = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage => ({
  role: "assistant", content, stopReason, errorMessage, api: model.api, provider: model.provider, model: model.id,
  timestamp: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
const stream = (reply: AssistantMessage) => {
  const value = createAssistantMessageEventStream();
  value.push({ type: "start", partial: reply });
  const textIndex = reply.content.findIndex((c) => c.type === "text");
  if (textIndex >= 0) value.push({ type: "text_delta", contentIndex: textIndex, delta: "preview", partial: reply });
  if (reply.stopReason === "error" || reply.stopReason === "aborted") value.push({ type: "error", reason: reply.stopReason, error: reply });
  else value.push({ type: "done", reason: reply.stopReason, message: reply });
  value.end(reply); return value;
};

const models = createModels();
let calls = 0;
let tools = 0;
const diagnostics: IGenerationDiagnostic[] = [];
const previews: Array<AssistantMessage | null> = [];
models.streamSimple = (_model, context, options) => {
  calls++;
  assert.equal(options?.maxRetries, 0);
  if (calls === 1) return stream(message([{ type: "toolCall", id: "committed", name: "probe", arguments: {} }], "toolUse"));
  assert.equal(context.messages.filter((m) => m.role === "toolResult").length, 1, "completed tool remains in context exactly once");
  if (calls === 2) return stream(message([{ type: "text", text: "uncommitted preview" }, { type: "toolCall", id: "partial-must-not-run", name: "probe", arguments: {} }], "error", "terminated"));
  assert.equal(context.messages.some((m) => m.role === "assistant" && m.content.some((c) => c.type === "toolCall" && c.id === "partial-must-not-run")), false);
  return stream(message([{ type: "text", text: "verified" }], "stop"));
};
const harness = new AgentHarness({ model, models: withGenerationRecovery(models, { retryDelayMs: 0,
  onPreview: (m) => previews.push(m), onDiagnostic: (e) => diagnostics.push(e) }),
  env: new NodeExecutionEnv({ cwd: process.cwd() }), session: new Session(new InMemorySessionStorage()),
  tools: [{ name: "probe", label: "Probe", description: "Offline counter", parameters: Type.Object({}),
    execute: async () => { tools++; return { content: [{ type: "text", text: "evidence" }], details: {} }; } }],
});
const result = await harness.prompt("Use probe once, then answer.");
assert.equal(result.stopReason, "stop");
assert.equal(calls, 3);
assert.equal(tools, 1, "neither completed tools nor incomplete stream tools are replayed");
assert.equal(result.usage.totalTokens, 4, "failed and successful generation attempts counted once");
assert.equal(diagnostics.filter((e) => e.retry).length, 1);
assert.equal(previews[0]?.content[0]?.type, "text");
assert.equal(previews[1], null, "failed ephemeral preview is cleared before retry");
assert.equal(previews.at(-1)?.content[0]?.type, "text", "successful generation still previews");

for (const error of ["Provider finish_reason: sensitive", "quota exhausted", "invalid schema", "unauthorized", "aborted"]) {
  let attempts = 0;
  models.streamSimple = () => { attempts++; return stream(message([], "error", error)); };
  const output = await withGenerationRecovery(models, { retryDelayMs: 0 }).streamSimple(model, { messages: [] }).result();
  assert.equal(attempts, 1, error);
  assert.equal(output.stopReason, "error");
}
assert.equal(isTransientGenerationError("terminated"), true);
assert.equal(isTransientGenerationError("bad request", 400), false);
assert.equal(isTransientGenerationError("busy", 503), true);
assert.equal(isTransientGenerationError("quota", 429), false);
let attempts = 0;
models.streamSimple = () => { attempts++; return stream(message([], "error", "terminated")); };
assert.equal((await withGenerationRecovery(models, { retryDelayMs: 0 }).streamSimple(model, { messages: [] }).result()).stopReason, "error");
assert.equal(attempts, 3);
const abort = new AbortController();
abort.abort();
attempts = 0;
assert.equal((await withGenerationRecovery(models, { signal: abort.signal }).streamSimple(model, { messages: [] }).result()).stopReason, "aborted");
assert.equal(attempts, 0, "cancel does not start or retry a provider request");

const cancelDuringBackoff = new AbortController();
attempts = 0;
const cancelled = await withGenerationRecovery(models, { signal: cancelDuringBackoff.signal,
  onDiagnostic: (e) => { if (e.retry) cancelDuringBackoff.abort(); },
}).streamSimple(model, { messages: [] }).result();
assert.equal(cancelled.stopReason, "aborted");
assert.equal(attempts, 1);
models.streamSimple = () => { attempts++; return stream(message([{ type: "text", text: "ok" }], "stop")); };
attempts = 0;
const unaffected = await withGenerationRecovery(models, {
  onPreview: () => { throw new Error("UI failure"); }, onDiagnostic: () => { throw new Error("metrics failure"); },
}).streamSimple(model, { messages: [] }).result();
assert.equal(unaffected.stopReason, "stop");
assert.equal(attempts, 1, "presentation/metrics failures never repeat inference");

// Real SDK serialization + HTTP stream failure, not just a mock Models surface.
const httpModels = createModels();
httpModels.setProvider(createProvider({ id: model.provider, models: [model], api: openAICompletionsApi(),
  auth: { apiKey: { name: "offline", resolve: async () => ({ auth: { apiKey: "offline-placeholder" }, source: "test" }) } } }));
const previousFetch = globalThis.fetch;
let httpCalls = 0;
const httpDiagnostics: IGenerationDiagnostic[] = [];
try {
  globalThis.fetch = async () => {
    httpCalls++;
    const chunk = { id: "offline", object: "chat.completion.chunk", created: 1, model: model.id,
      choices: [{ index: 0, delta: { role: "assistant", content: httpCalls === 1 ? "incomplete" : "complete" }, finish_reason: httpCalls === 1 ? null : "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    const body = `data: ${JSON.stringify(chunk)}\n\n`;
    const headers = { "content-type": "text/event-stream", "x-request-id": `offline-${httpCalls}`, "set-cookie": "PRIVATE_HEADER" };
    if (httpCalls > 1) return new Response(body + "data: [DONE]\n\n", { headers });
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      setTimeout(() => controller.error(new TypeError("terminated")), 20);
    } }), { headers });
  };
  const httpReply = await withGenerationRecovery(httpModels, { retryDelayMs: 0,
    onDiagnostic: (event) => httpDiagnostics.push(event),
  }).streamSimple(model, { messages: [{ role: "user", content: "fixture", timestamp: 1 }] }).result();
  assert.equal(httpReply.stopReason, "stop");
  assert.equal(httpCalls, 2);
  assert.equal(httpDiagnostics[0]?.status, 200);
  assert.equal(httpDiagnostics[0]?.requestId, "offline-1");
  assert.equal(httpDiagnostics[0]?.retry, true);
  assert.doesNotMatch(JSON.stringify(httpDiagnostics), /PRIVATE_HEADER|offline-placeholder/);
} finally { globalThis.fetch = previousFetch; }
console.log("generation recovery: real harness preserves tools, isolates failed content, accounts usage, bounds retries, honors cancellation");
