import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTransportForProfile, callChatCompletions, streamChatCompletions } from './provider';
import { PrivacySession } from './privacy-session';
import { DEFAULT_APP_SETTINGS } from '../../../src/contracts/settings';
import { executePython, respondPythonRuntime, setPythonRuntimeBroadcaster, queryForPythonJob, readPythonRuntimeInput, resetPythonWorkspace } from './python-runtime-broker';
import { configureQueryArtifactRoot, writeBufferedQueryArtifact } from '../query-artifacts';
import type { PythonExecutionRequest } from '../../shared/types';
import { IPC_EVENTS } from '../../shared/ipc-events';
import { AgentHarness } from './pi-harness';
import { Session } from './pi-session';

const settings = { ...DEFAULT_APP_SETTINGS.ai, privacyModeEnabled: true, providerMode: 'openai-compatible' as const,
  profiles: [{ ...DEFAULT_APP_SETTINGS.ai.profiles[0]!, baseUrl: 'https://privacy-fixture.invalid/v1', model: 'fixture' }] };
const privacy = new PrivacySession(true);
const savedFetch = globalThis.fetch;
const bodies: string[] = [];
globalThis.fetch = async (_url, init) => {
  const body = String(init?.body); bodies.push(body);
  assert(!body.includes('13812345678'), 'real phone crossed HTTP boundary');
  assert(!body.includes('alice@example.com'), 'real email crossed HTTP boundary');
  assert(!body.includes('"original"'), 'mapping crossed HTTP boundary');
  const token = body.match(/STELA_PII_[a-f0-9]{24}_[a-f0-9]{24}/)?.[0] ?? 'ok';
  return new Response([
    { id: 'test', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: token }, finish_reason: null }] },
    { id: 'test', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  ].map(v => `data: ${JSON.stringify(v)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
};
try {
  const { models, model } = createTransportForProfile(settings, 'local-test-key', undefined, privacy);
  const context = { messages: [{ role: 'user' as const, content: '电话13812345678，邮箱alice@example.com', timestamp: 0 }] };
  for (const method of ['complete', 'completeSimple'] as const) {
    const result = await models[method](model, context); assert.equal(result.stopReason, 'stop', result.errorMessage);
  }
  const harness = new AgentHarness({ session: new Session(), models, model, systemPrompt: 'Summarize user data.', tools: [] });
  await harness.prompt('电话13812345678，邮箱alice@example.com');
  await harness.compact();
  await harness.prompt('继续分析');
  const restored = await callChatCompletions({ settings, apiKey: 'local-test-key', system: 'Return the phone.', user: '电话13812345678' });
  assert.equal(restored, '13812345678');
  let completion = '';
  await streamChatCompletions({ settings, apiKey: 'local-test-key', profileId: 'default', system: 'Return the phone.', user: '电话13812345678', signal: new AbortController().signal, onDelta: text => { completion += text; } });
  assert.equal(completion, '13812345678');
  assert(bodies.length >= 7, 'foreground, compaction, continuation and standalone calls were captured');
} finally { globalThis.fetch = savedFetch; }

const root = await mkdtemp(path.join(os.tmpdir(), 'stela-private-broker-'));
try {
  configureQueryArtifactRoot(root);
  const source = await writeBufferedQueryArtifact({ vaultPath: root, sessionId: 'session', runId: 'source', columns: [{ name: 'phone', typeName: 'VARCHAR' }], rows: [['13812345678']] });
  assert(source);
  const requests: PythonExecutionRequest[] = []; let resets = 0;
  setPythonRuntimeBroadcaster((channel, payload) => {
    if (channel === IPC_EVENTS.AI_PYTHON_RUNTIME_REQUEST) requests.push(payload as PythonExecutionRequest);
    if (channel === IPC_EVENTS.AI_PYTHON_WORKSPACE_RESET) resets++;
    return true;
  });
  const waitRequest = async (count: number) => {
    const deadline = Date.now() + 10000;
    while (requests.length < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(requests.length, count); return requests[count - 1]!;
  };
  const finish = (job: PythonExecutionRequest) => respondPythonRuntime({ jobId: job.jobId, result: { ok: true, stdout: '', stdoutTruncated: false, value: { kind: 'none' }, elapsedMs: 1 } });
  const first = executePython({ vaultPath: root, sessionId: 'session', code: 'result=1', artifacts: {} });
  const raw = await waitRequest(1); finish(raw); await first;
  const second = executePython({ vaultPath: root, sessionId: 'session', privacy, code: 'result="13812345678"', artifacts: { customers: source }, runQuery: async () => source });
  const safe = await waitRequest(2);
  assert.notEqual(safe.workspaceId, raw.workspaceId); assert.equal(resets, 1);
  assert(!safe.code.includes('13812345678')); assert(!JSON.stringify(safe).includes('"entries"'));
  assert.equal(safe.inputs[0]!.runId, 'source', 'provenance retains original run id');
  const dynamic = await queryForPythonJob({ jobId: safe.jobId, connectionName: 'test', request: '{}' });
  const chunk = await readPythonRuntimeInput({ jobId: safe.jobId, alias: dynamic.alias, offset: 0, length: 10000 });
  assert(Buffer.from(chunk.data).subarray(0, 4).equals(Buffer.from('PAR1')), 'dynamic query also uses sanitized Parquet');
  finish(safe); await second;
  const third = executePython({ vaultPath: root, sessionId: 'session', code: 'result=1', artifacts: {} });
  const disabled = await waitRequest(3); assert.notEqual(disabled.workspaceId, safe.workspaceId); finish(disabled); await third;
  await resetPythonWorkspace(root, 'session');
} finally { setPythonRuntimeBroadcaster(null); await rm(root, { recursive: true, force: true }); }
console.log(`privacy integration: ${bodies.length} real provider payloads, Pi compaction, completion and Python mode changes passed`);
