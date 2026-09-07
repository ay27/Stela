import assert from "node:assert/strict";
import { mock } from "node:test";
import { setImmediate as flush } from "node:timers/promises";
import { createModels, createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { withGenerationRecovery, type IGenerationDiagnostic } from "./generation-recovery";
import { canCloseout, closeoutGeneration } from "./generation-closeout";

const model: Model<"openai-completions"> = { id: "offline", name: "offline", provider: "offline", api: "openai-completions",
  baseUrl: "https://offline.invalid", reasoning: true, input: ["text"], contextWindow: 10000, maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const reply = (content: AssistantMessage["content"] = [{ type: "text", text: "Incomplete: committed result is 42." }]): AssistantMessage => ({
  role: "assistant", content, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop",
  usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
const models = createModels();
const events: IGenerationDiagnostic[] = [];
async function advance(ms: number) { mock.timers.tick(ms); await flush(); }

mock.timers.enable({ apis: ["Date", "setTimeout"] });
try {
  let active = createAssistantMessageEventStream();
  models.streamSimple = () => active;
  const pending = withGenerationRecovery(models, { onDiagnostic: e => events.push(e) }).streamSimple(model, { messages: [] }).result();
  for (let i = 0; i < 4; i++) {
    active.push({ type: "thinking_delta", contentIndex: 0, delta: "working", partial: reply() });
    await flush();
    await advance(60_000);
  }
  active.end(reply());
  assert.equal((await pending).stopReason, "stop", "active reasoning beyond 180 seconds is not killed");
  assert.equal(events.at(-1)?.deltaCount, 4);
  assert.equal(events.at(-1)?.lastEventMs, 180_000);
  assert.equal(events.at(-1)?.usageCompleteness, "complete");

  for (const [option, cause] of [["responseTimeoutMs", "response_timeout"], ["firstDeltaTimeoutMs", "first_delta_timeout"],
    ["deadlineMs", "generation_deadline"]] as const) {
    active = createAssistantMessageEventStream();
    const task = withGenerationRecovery(models, { [option]: 100, onDiagnostic: e => events.push(e) }).streamSimple(model, { messages: [] }).result();
    await advance(101);
    assert.match((await task).errorMessage ?? "", new RegExp(cause));
    assert.equal(events.at(-1)?.stopCause, cause);
    assert.equal(events.at(-1)?.usageCompleteness, "unknown");
    active.end(reply()); // Simulates a provider ignoring AbortSignal; no result is committed.
  }

  active = createAssistantMessageEventStream();
  const stalled = withGenerationRecovery(models, { idleTimeoutMs: 100, onDiagnostic: e => events.push(e) }).streamSimple(model, { messages: [] }).result();
  active.push({ type: "thinking_delta", contentIndex: 0, delta: "a", partial: reply() });
  await flush(); await advance(90);
  active.push({ type: "toolcall_delta", contentIndex: 0, delta: "{", partial: reply() });
  await flush(); await advance(90);
  active.push({ type: "text_delta", contentIndex: 0, delta: "", partial: reply() });
  await flush(); await advance(11);
  assert.match((await stalled).errorMessage ?? "", /idle_timeout/);
  assert.equal(events.at(-1)?.deltaCount, 2, "empty delta does not reset idle clock");
  assert.equal(events.at(-1)?.usageCompleteness, "partial", "known partial usage survives a timeout");
  active.end(reply());

  active = createAssistantMessageEventStream();
  const cancel = new AbortController();
  const cancelled = withGenerationRecovery(models, { signal: cancel.signal, onDiagnostic: e => events.push(e) }).streamSimple(model, { messages: [] }).result();
  cancel.abort();
  assert.equal((await cancelled).stopReason, "aborted");
  assert.equal(events.at(-1)?.stopCause, "caller_cancelled");
  active.end(reply());

  // The recovery window starts after an arbitrarily long first generation.
  let calls = 0;
  const first = createAssistantMessageEventStream(), second = createAssistantMessageEventStream();
  models.streamSimple = () => ++calls === 1 ? first : second;
  const recovery = withGenerationRecovery(models, { recoveryWindowMs: 100, retryDelayMs: 0,
    onDiagnostic: e => events.push(e) }).streamSimple(model, { messages: [] }).result();
  await advance(240_000);
  first.end({ ...reply(), stopReason: "error", errorMessage: "terminated" });
  await flush(); await advance(101);
  assert.match((await recovery).errorMessage ?? "", /recovery_deadline/);
  assert.ok(calls <= 2);
  second.end(reply());
} finally { mock.timers.reset(); }

for (const failure of ["Provider finish_reason: sensitive", "unauthorized", "quota exhausted", "invalid schema"]) {
  assert.equal(canCloseout({ failure, hasEvidence: true, remainingMs: 1000, cancelled: false }), false);
}
assert.equal(canCloseout({ failure: "terminated", hasEvidence: false, remainingMs: 1000, cancelled: false }), false);
assert.equal(canCloseout({ failure: "task_timeout", hasEvidence: true, remainingMs: 0, cancelled: false }), false);
assert.equal(canCloseout({ failure: "Service unavailable", failureStatus: 503, hasEvidence: true, remainingMs: 1000, cancelled: false }), true);
assert.equal(canCloseout({ failure: "Forbidden", failureStatus: 403, hasEvidence: true, remainingMs: 1000, cancelled: false }), false);

let closeoutCalls = 0;
models.streamSimple = (_model, context, options) => {
  closeoutCalls++;
  assert.equal(context.tools?.length, 0);
  assert.equal(options?.maxRetries, 0);
  const result = createAssistantMessageEventStream(); result.end(reply()); return result;
};
const input = { models, model, context: { messages: [] }, failure: "terminated", hasEvidence: true, remainingMs: 1000 };
assert.equal((await closeoutGeneration(input)).status, "completed");
assert.equal(closeoutCalls, 1);
const cancel = new AbortController(); cancel.abort();
assert.equal((await closeoutGeneration({ ...input, signal: cancel.signal })).status, "cancelled");
assert.equal(closeoutCalls, 1);
models.streamSimple = () => {
  closeoutCalls++;
  const result = createAssistantMessageEventStream(); result.end({ ...reply(), stopReason: "error", errorMessage: "terminated" }); return result;
};
assert.equal((await closeoutGeneration(input)).status, "failed");
assert.equal(closeoutCalls, 2, "closeout never retries a transient provider error");
models.streamSimple = () => {
  const result = createAssistantMessageEventStream(); result.end({ ...reply([{ type: "toolCall", id: "forbidden", name: "query", arguments: {} }]), stopReason: "toolUse" }); return result;
};
assert.equal((await closeoutGeneration(input)).status, "failed", "provider-generated tool calls are rejected, never dispatched");
const inFlightCancel = new AbortController();
const inFlight = createAssistantMessageEventStream();
let cancelledCloseoutCalls = 0;
models.streamSimple = () => { cancelledCloseoutCalls++; return inFlight; };
const inFlightResult = closeoutGeneration({ ...input, signal: inFlightCancel.signal });
inFlightCancel.abort();
assert.equal((await inFlightResult).status, "cancelled");
assert.equal(cancelledCloseoutCalls, 1, "cancelling closeout does not launch a replacement request");
inFlight.end(reply());
console.log("generation lifecycle: long thinking streams, opt-in timeouts, cancellation, recovery window, usage uncertainty and tool-free closeout passed");
