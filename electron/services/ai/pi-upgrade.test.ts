import assert from 'node:assert/strict';
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

  await storage.native.close(BACKGROUND_CONTEXT);
  await reopened.native.close(BACKGROUND_CONTEXT);
  console.log('Pi migration: read-only v3 import, continued conversation, backup, v4 reopen, UI writes, atomic embedded publication passed.');
} finally { await fs.rm(root, { recursive: true, force: true }); }
