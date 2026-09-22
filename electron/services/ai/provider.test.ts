import { Type } from "@earendil-works/pi-ai";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AiReasoningEffort, AiSettings } from "@shared/types";

import { loadAppSettings, patchAppSettings } from "../settings-store";
import { createTransportForProfile } from "./provider";

function customSettings(reasoningEffort: AiReasoningEffort): AiSettings {
  const profile = {
    id: "custom-test",
    name: "Custom test",
    vendorId: "custom",
    model: "reasoning-model",
    baseUrl: "https://example.com/v1",
    contextWindow: 128_000 as const,
    reasoningEffort,
    hasApiKey: true,
  };
  return {
    providerMode: "openai-compatible",
    activeProfileId: profile.id,
    profiles: [profile],
    inlineCompletionEnabled: false,
    completionProfileId: null,
    baseUrl: profile.baseUrl,
    model: profile.model,
    hasApiKey: true,
    contextWindow: profile.contextWindow,
    agentMaxIterations: 200,
    agentWallClockMs: 300_000,
    agentAllowMutations: false,
    agentAutoApplyEdits: false,
    automaticSkillMaintenanceEnabled: true,
  };
}

{
  const transport = createTransportForProfile(customSettings("medium"), "test-key");
  assert.equal(transport.model.reasoning, true);
  assert.equal(transport.model.compat?.supportsReasoningEffort, true);
  assert.equal(transport.reasoning.requested, "medium");
  assert.equal(transport.reasoning.effective, "medium");
  assert.deepEqual(transport.reasoning.supported, [
    "off", "minimal", "low", "medium", "high", "xhigh", "max",
  ]);
}

{
  const transport = createTransportForProfile(customSettings("off"), "test-key");
  assert.equal(transport.model.reasoning, true);
  assert.equal(transport.model.thinkingLevelMap?.off, "none");
  assert.equal(transport.reasoning.effective, "off");
}

const root = await mkdtemp(path.join(os.tmpdir(), "stela-reasoning-profile-"));
try {
  await mkdir(path.join(root, ".stela"), { recursive: true });
  await writeFile(path.join(root, ".stela", "settings.json"), JSON.stringify({
    ai: {
      providerMode: "openai-compatible",
      activeProfileId: "legacy-custom",
      profiles: [{
        id: "legacy-custom",
        name: "Legacy custom",
        vendorId: "custom",
        model: "legacy-model",
        baseUrl: "https://example.com/v1",
        contextWindow: 128_000,
        hasApiKey: false,
      }],
    },
  }));
  const migrated = await loadAppSettings(root);
  assert.equal(migrated.ai.profiles[0]?.reasoningEffort, "medium");
  assert.equal(migrated.ai.profiles[0]?.customApi, "chat-completions");
  await patchAppSettings(root, { ai: { profiles: [{ ...migrated.ai.profiles[0], customApi: "responses" }] } });
  assert.equal((await loadAppSettings(root)).ai.profiles[0].customApi, "responses");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("ai provider reasoning tests passed.");

// Inspect real serializers without making network calls.
const completions = await import('@earendil-works/pi-ai/api/openai-completions');
const responses = await import('@earendil-works/pi-ai/api/openai-responses');
for (const customApi of ['chat-completions', 'responses'] as const) {
  for (const effort of ['off', 'high'] as const) {
    const settings = customSettings(effort);
    settings.profiles[0].customApi = customApi;
    const { model } = createTransportForProfile(settings, 'offline-key');
    assert.equal(model.api, customApi === 'responses' ? 'openai-responses' : 'openai-completions');
    let payload: Record<string, unknown> = {};
    const options = { apiKey: 'offline-key', reasoning: effort, onPayload: (value: unknown) => {
      payload = value as Record<string, unknown>; throw new Error('offline: before HTTP');
    } };
    const context = { messages: [{ role: 'user' as const, content: 'hello', timestamp: 0 }] };
    if (model.api === 'openai-responses') await responses.streamSimple(model as import('@earendil-works/pi-ai').Model<'openai-responses'>, context, options).result();
    else await completions.streamSimple(model as import('@earendil-works/pi-ai').Model<'openai-completions'>, context, options).result();
    assert.equal(customApi === 'responses' ? (payload.reasoning as { effort: string }).effort : payload.reasoning_effort, effort === 'off' ? 'none' : effort);
  }
}

// Feed the actual Responses parser a tool call, then replay its result on the next request.
const testTools = [{ name: 'lookup', description: 'Lookup a record', parameters: Type.Object({ id: Type.Number() }) }];
const originalFetch = globalThis.fetch;
const settings = customSettings('off');
settings.profiles[0].customApi = 'responses';
const model = createTransportForProfile(settings, 'offline-key').model as import('@earendil-works/pi-ai').Model<'openai-responses'>;
let round = 0;
try {
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /\/v1\/responses$/);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.reasoning.effort, 'none');
    assert.equal(body.tools[0].type, 'function');
    assert.equal(body.tools[0].name, 'lookup');
    if (round++) assert.ok(body.input.some((item: { type: string; call_id: string; output: string }) => item.type === 'function_call_output' && item.call_id === 'call_test' && item.output.includes('42')));
    const item = round === 1
      ? { type: 'function_call', id: 'fc_test', call_id: 'call_test', name: 'lookup', arguments: '{"id":1}' }
      : { type: 'message', id: 'msg_test', role: 'assistant', content: [{ type: 'output_text', text: '42', annotations: [] }] };
    const events = [
      { type: 'response.output_item.added', output_index: 0, item },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: `resp_${round}`, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ];
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  };
  const first = await responses.streamSimple(model, { tools: testTools, messages: [{ role: 'user', content: 'lookup', timestamp: 0 }] }, { apiKey: 'offline-key', reasoning: 'off' }).result();
  assert.equal(first.stopReason, 'toolUse', first.errorMessage);
  const call = first.content.find(item => item.type === 'toolCall');
  assert.ok(call && call.type === 'toolCall');
  assert.deepEqual(call.arguments, { id: 1 });
  const second = await responses.streamSimple(model, { tools: testTools, messages: [first, { role: 'toolResult', toolCallId: call.id, toolName: 'lookup', content: [{ type: 'text', text: '42' }], isError: false, timestamp: 1 }] }, { apiKey: 'offline-key', reasoning: 'off' }).result();
  assert.equal(second.stopReason, 'stop', second.errorMessage);
  assert.deepEqual(second.content.map(item => item.type === 'text' ? item.text : ''), ['42']);
  assert.equal(round, 2);
} finally { globalThis.fetch = originalFetch; }
console.log('Custom protocols: explicit off/high payloads, Responses streaming and tool-result replay passed.');
