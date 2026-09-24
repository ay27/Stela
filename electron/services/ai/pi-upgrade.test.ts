import assert from 'node:assert/strict';
import { Type } from '@earendil-works/pi-ai';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BACKGROUND_CONTEXT, ok } from '@earendil-works/pi-agent-core';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import { createModels, createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { JsonlSessionStorage, Session, type IJournalIO } from './pi-session';
import { AgentHarness } from './pi-harness';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stela-pi-upgrade-'));
const timestamp = '2026-09-01T00:00:00.000Z';
const legacy = [
  { type: 'session', version: 3, id: 'legacy', cwd: root, timestamp },
  { type: 'message', id: 'old-user', parentId: null, timestamp, message: { role: 'user', content: 'Historical context', timestamp: 1 } },
  { type: 'custom', id: 'old-plan', parentId: 'old-user', timestamp, customType: 'execution_plan', data: { runId: 'old', plan: { version: 1 } } },
].map(value => JSON.stringify(value)).join('\n') + '\n';
const model: Model<'openai-completions'> = { id: 'offline', name: 'offline', provider: 'offline', api: 'openai-completions', baseUrl: 'https://offline.invalid',
  reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const models = createModels();
let calls = 0;
let verifyHistory = true;
models.streamSimple = (_model, input) => {
  if (verifyHistory) assert.ok(input.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('Historical context')));
  calls++;
  const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'continued' }], api: model.api, provider: model.provider, model: model.id,
    timestamp: Date.now(), stopReason: 'stop', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const stream = createAssistantMessageEventStream();
  stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: 'stop', message }); stream.end(message); return stream;
};
try {
  const file = path.join(root, 'legacy.jsonl');
  await fs.writeFile(file, legacy);
  const env = new NodeExecutionEnv({ cwd: root });
  const storage = await JsonlSessionStorage.open(env, file);
  assert.equal((await storage.getEntries()).length, 2);
  assert.equal(await fs.readFile(file, 'utf8'), legacy, 'read does not migrate');
  assert.equal(calls, 0, 'import does not call providers or tools');
  const session = new Session(storage);
  const harness = new AgentHarness({ session, models, model });
  harness.subscribe(async event => { if (event.type === 'message_end') await storage.appendCustomEntry('ui_event', { completed: true }); });
  assert.equal((await harness.prompt('Continue')).stopReason, 'stop');
  assert.equal(await fs.readFile(`${file}.pre-pi087.bak`, 'utf8'), legacy);
  assert.equal(JSON.parse((await fs.readFile(file, 'utf8')).split('\n')[0]).v, 4);
  const reopened = await JsonlSessionStorage.open(env, file);
  const entries = await reopened.getEntries();
  assert.ok(entries.some(entry => entry.type === 'custom' && entry.customType === 'ui_event'), 'UI writes survive lane commits');
  assert.ok(entries.some(entry => entry.type === 'custom' && entry.customType === 'execution_plan'));
  await new AgentHarness({ session: new Session(reopened), models, model }).prompt('Continue again');
  assert.equal(await fs.readFile(`${file}.pre-pi087.bak`, 'utf8'), legacy, 'backup is immutable across subsequent writes');

  // The embedded journal must publish all migration writes together, through its owner.
  let embedded = legacy;
  let failPublication = true;
  const publications: string[] = [];
  const io: IJournalIO = {
    readTextFile: async () => ok(embedded), readTextLines: async () => ok(embedded.split('\n')),
    writeFile: async (_file, value) => {
      if (failPublication) throw new Error('simulated disk failure');
      embedded = String(value); publications.push(embedded); return ok(undefined);
    },
    appendFile: async (_file, value) => { embedded += String(value); return ok(undefined); },
  };
  const embeddedFile = path.join(root, 'chat.stela.chat');
  const before = await JsonlSessionStorage.open(io, embeddedFile);
  assert.equal(embedded, legacy);
  await assert.rejects(before.appendCustomEntry('probe', {}), /simulated disk failure/);
  assert.equal(embedded, legacy, 'failed atomic publication leaves source untouched');
  failPublication = false;
  const retry = await JsonlSessionStorage.open(io, embeddedFile);
  await retry.appendCustomEntry('probe', {});
  assert.equal(publications.length, 1);
  assert.equal(JSON.parse(embedded.split('\n')[0]).v, 4);
  const restored = await JsonlSessionStorage.open(io, embeddedFile);
  assert.equal((await restored.getEntries()).length, 3);
  const cancelled = new AgentHarness({ session: new Session(), models, model });
  const callsBeforeCancel = calls;
  await cancelled.abort();
  await assert.rejects(cancelled.prompt('Do not execute'), /cancelled/);
  assert.equal(calls, callsBeforeCancel);

  verifyHistory = false;
  const compactSession = new Session();
  for (let turn = 0; turn < 6; turn++) {
    await compactSession.appendMessage({ role: 'user', content: 'Historical evidence '.repeat(12000), timestamp: turn });
    await compactSession.appendMessage({ role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: turn,
      content: [{ type: 'text', text: 'Retain the verified conclusion.' }], stopReason: 'stop',
      usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  }
  const compactHarness = new AgentHarness({ session: compactSession, models, model });
  await compactHarness.compact('Preserve verified conclusions');
  assert.ok((await compactSession.getBranch()).some(entry => entry.type === 'compaction'));
  assert.ok(JSON.stringify(await compactSession.buildContext()).includes('continued'), 'summary is projected into the next context');
  assert.equal((await compactHarness.prompt('Continue after compaction')).stopReason, 'stop');

  // Native threshold scheduling must work without Stela calling compact().
  const autoStorage = await JsonlSessionStorage.create(env, path.join(root, 'automatic.jsonl'), { sessionId: 'automatic', cwd: root });
  const autoSession = new Session(autoStorage);
  for (let turn = 0; turn < 6; turn++) {
    await autoSession.appendMessage({ role: 'user', content: 'Verified SQL evidence '.repeat(2000), timestamp: turn });
    await autoSession.appendMessage({ role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: turn,
      content: [{ type: 'text', text: 'Verified conclusion' }], stopReason: 'stop',
      usage: { input: 35000, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 35001, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  }
  const autoHarness = new AgentHarness({ session: autoSession, models, model: { ...model, contextWindow: 48000 } });
  const compactions: string[] = [];
  const autoUsage: number[] = [];
  const beforeAutoCalls = calls;
  autoHarness.subscribe(async event => {
    if (event.type === 'usage') autoUsage.push(event.row.usage.totalTokens);
    if (event.type === 'compaction_start') compactions.push(`start:${event.reason}`);
    if (event.type === 'compaction_end') {
      compactions.push(`end:${event.status}`);
      await autoSession.appendCustomEntry('ui_event', { compaction: event.status });
    }
  });
  assert.equal((await autoHarness.prompt('Continue the analysis')).stopReason, 'stop');
  assert.deepEqual(compactions, ['start:threshold', 'end:completed']);
  assert.ok(autoUsage.length >= 2, 'summary and normal generation both report native usage');
  assert.equal(autoUsage.reduce((sum, value) => sum + value, 0), (calls - beforeAutoCalls) * 2);
  assert.equal(autoHarness.getSnapshot()?.operation, null);
  assert.equal(autoHarness.getSnapshot()?.lastResult?.status, 'completed');
  const autoReopened = await JsonlSessionStorage.open(env, path.join(root, 'automatic.jsonl'));
  assert.ok((await autoReopened.getEntries()).some(entry => entry.type === 'compaction'));
  assert.ok((await autoReopened.getEntries()).some(entry => entry.type === 'custom' && entry.customType === 'ui_event'));
  await autoStorage.native.close(BACKGROUND_CONTEXT);
  await autoReopened.native.close(BACKGROUND_CONTEXT);

  // Provider overflow is recovered inside the same native run, without a synthetic user turn.
  const overflowSession = new Session();
  for (let turn = 0; turn < 4; turn++) {
    await overflowSession.appendMessage({ role: 'user', content: 'Prior evidence '.repeat(6000), timestamp: turn });
    await overflowSession.appendMessage({ role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: turn,
      content: [{ type: 'text', text: 'Prior conclusion' }], stopReason: 'stop',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  }
  const overflowModels = createModels();
  let overflowCalls = 0;
  overflowModels.streamSimple = (m, input, options) => {
    if (++overflowCalls !== 1) return models.streamSimple(m, input, options);
    const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      content: [], stopReason: 'error', errorMessage: 'maximum context length exceeded',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'error', reason: 'error', error: message }); stream.end(message); return stream;
  };
  const overflowHarness = new AgentHarness({ session: overflowSession, models: overflowModels, model });
  const overflowEvents: string[] = [];
  overflowHarness.subscribe(event => { if (event.type === 'compaction_start') overflowEvents.push(event.reason); });
  assert.equal((await overflowHarness.prompt('Finish using the existing evidence')).stopReason, 'stop');
  assert.deepEqual(overflowEvents, ['overflow']);
  assert.ok(overflowCalls >= 3, 'failed generation, native summary and resumed generation');
  assert.ok(!JSON.stringify(await overflowSession.getBranch()).includes('The previous request exceeded'));

  const toolSession = new Session();
  for (let turn = 0; turn < 3; turn++) {
    await toolSession.appendMessage({ role: 'user', content: 'Earlier query context '.repeat(500), timestamp: turn });
    await toolSession.appendMessage({ role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: turn,
      content: [{ type: 'text', text: 'Earlier conclusion' }], stopReason: 'stop',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  }
  const toolModels = createModels();
  let requestedTool = false;
  let executions = 0;
  toolModels.streamSimple = (m, input, options) => {
    if (requestedTool) return models.streamSimple(m, input, options);
    requestedTool = true;
    const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      content: [{ type: 'toolCall', id: 'query-once', name: 'read_evidence', arguments: {} }], stopReason: 'toolUse',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: 'toolUse', message }); stream.end(message); return stream;
  };
  const toolHarness = new AgentHarness({ session: toolSession, models: toolModels, model: { ...model, contextWindow: 48000 },
    tools: [{ name: 'read_evidence', label: 'Read evidence', description: 'Read evidence once', parameters: Type.Object({}),
      execute: async () => { executions++; return { content: [{ type: 'text' as const, text: 'Evidence rows '.repeat(16000) }], details: {} }; } }],
  });
  const toolOrder: string[] = [];
  toolHarness.subscribe(event => {
    if (event.type === 'tool_execution_end') toolOrder.push('tool');
    if (event.type === 'compaction_end' && event.status === 'completed') toolOrder.push('compact');
  });
  assert.equal((await toolHarness.prompt('Analyze the evidence')).stopReason, 'stop');
  assert.equal(executions, 1, 'automatic compaction must not replay tools');
  assert.deepEqual(toolOrder, ['tool', 'compact'], 'native scheduling compacts within a tool run');

  // Cancelling a native summary must stop the run and never report successful compaction.
  const cancelSession = new Session();
  for (const entry of await toolSession.getBranch()) {
    if (entry.type === 'message') await cancelSession.appendMessage(entry.message);
  }
  await cancelSession.appendMessage({ role: 'user', content: 'More evidence '.repeat(16000), timestamp: Date.now() });
  const cancelModels = createModels();
  let summaryStarted = false;
  const cancelEvents: string[] = [];
  cancelModels.streamSimple = (_m, _input, options) => {
    assert.ok(summaryStarted, 'cancellation targets native compaction');
    assert.ok(options?.signal);
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      content: [], stopReason: 'aborted',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    options.signal.addEventListener('abort', () => {
      stream.push({ type: 'error', reason: 'aborted', error: message }); stream.end(message);
    }, { once: true });
    queueMicrotask(() => { void cancelHarness.abort(); });
    return stream;
  };
  const cancelHarness = new AgentHarness({ session: cancelSession, models: cancelModels, model: { ...model, contextWindow: 48000 } });
  cancelHarness.subscribe(event => {
    if (event.type === 'compaction_start') summaryStarted = true;
    if (event.type === 'compaction_end') cancelEvents.push(event.status);
  });
  assert.equal((await cancelHarness.prompt('Continue')).stopReason, 'aborted');
  assert.ok(!cancelEvents.includes('completed'));

  await storage.native.close(BACKGROUND_CONTEXT);
  await reopened.native.close(BACKGROUND_CONTEXT);
  console.log('Pi migration and native compaction: threshold, overflow, tool continuation without replay, cancellation and persistence passed.');
} finally { await fs.rm(root, { recursive: true, force: true }); }
