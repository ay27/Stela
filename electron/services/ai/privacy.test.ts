import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage, type Models, type Model } from '@earendil-works/pi-ai';
import { PrivacySession } from './privacy-session';
import { withPrivacy } from './privacy-transport';
import { restorePrivateSql } from './privacy-query';
import { configureQueryArtifactRoot, writeBufferedQueryArtifact, privateQueryArtifact, readQueryArtifactChunk } from '../query-artifacts';
import { DuckDBInstance } from '@duckdb/node-api';
import { promises as fs } from 'node:fs';
import { privacyStateSchema } from '../../shared/ai-privacy';

const compact = new PrivacySession(true);
const codes = Array.from({ length: 4096 }, (_, index) => compact.importIdentity(`identity-${index}`, 'text'));
assert.equal(new Set(codes).size, 4096);
assert(codes.every(code => /^PII_[0-9A-F]{3}$/.test(code)));
const fourth = compact.importIdentity('identity-4096', 'text');
assert.match(fourth, /^PII_[0-9A-F]{4}$/);
const compactResume = new PrivacySession(true, { state: structuredClone(compact.state), save: async () => {} });
assert.equal(compactResume.importIdentity('identity-0', 'text'), codes[0]);
assert.match(compactResume.importIdentity('identity-4097', 'text'), /^PII_[0-9A-F]{4}$/);
const fullFour = structuredClone(compact.state);
fullFour.entries = fullFour.entries.filter(entry => entry.token.length === 7);
for (let i = 0; i < 65536; i++) fullFour.entries.push({ token: `PII_${i.toString(16).toUpperCase().padStart(4, '0')}`, original: `four-${i}`, kind: 'text' });
const fifth = new PrivacySession(true, { state: fullFour, save: async () => {} }).importIdentity('five', 'text');
assert.match(fifth, /^PII_[0-9A-F]{5}$/);
const legacyToken = `STELA_PII_${'a'.repeat(24)}_${'b'.repeat(24)}`;
const legacyState = { version: 1 as const, namespace: 'a'.repeat(24), entries: [{ token: legacyToken, original: 'old identity', kind: 'text' }] };
const legacy = new PrivacySession(true, { state: legacyState, save: async () => {} });
assert.equal(legacy.restore(legacyToken), 'old identity');
assert.equal(legacy.importIdentity('old identity', 'text'), legacyToken);
assert.match(legacy.importIdentity('new identity', 'text'), /^PII_[0-9A-F]{3}$/);
assert.equal(legacy.state.version, 2);
assert(!privacyStateSchema.safeParse({ ...legacyState, entries: [{ ...legacyState.entries[0], token: 'PII_ABC' }] }).success);
const boundaries = new PrivacySession(true, { state: { version: 2, namespace: 'a'.repeat(24), entries: [
  { token: 'PII_ABC', original: 'short', kind: 'text' }, { token: 'PII_ABCD', original: 'long', kind: 'text' },
] }, save: async () => {} });
assert.equal(boundaries.restore('PII_ABC / PII_ABCD / XPII_ABC / PII_ABC_suffix'), 'short / long / XPII_ABC / PII_ABC_suffix');
assert.equal(restorePrivateSql("select 'PII_ABC', 'PII_ABCD'", boundaries), "select 'short', 'long'");
assert.throws(() => restorePrivateSql("select 'PII_ABCE'", boundaries));
assert.throws(() => restorePrivateSql('select "PII_ABC"', boundaries));
assert.throws(() => restorePrivateSql("select 'prefix PII_ABC'", boundaries));
assert.throws(() => restorePrivateSql('select 1 -- PII_ABC', boundaries));
const literalCode = String(await boundaries.maskData('PII_FFF'));
assert.notEqual(literalCode, 'PII_FFF', 'unknown token-looking data is masked as a literal');
assert.equal(boundaries.restore(literalCode), 'PII_FFF');
assert.equal(restorePrivateSql(`select '${literalCode}'`, boundaries), "select 'PII_FFF'", 'restored literals are not resolved a second time');

let saves = 0;
const privacy = new PrivacySession(true, { save: async () => { saves++; } });
const original = '客户张三，电话13812345678，邮箱zhangsan@example.com，销售额12345.67';
await privacy.maskData('张三');
const masked = await privacy.maskText(original);
assert.equal(privacy.restore(masked), original);
for (const sensitive of ['张三', '13812345678', 'zhangsan@example.com']) assert(!masked.includes(sensitive));
assert(masked.includes('12345.67'));
assert.equal(await privacy.maskText(masked), masked, 'tokens are idempotent');
assert.equal(await privacy.maskText(original), masked, 'same conversation reuses tokens');
assert.notEqual(await new PrivacySession(true).maskText(original), masked);
await privacy.flush(); assert.equal(saves, 1);
const resumed = new PrivacySession(true, { state: structuredClone(privacy.state), save: async () => {} });
assert.equal(await resumed.maskText(original), masked);
assert.equal(await new PrivacySession(false).maskText(original), original);
const separate = new PrivacySession(true);
const one = await separate.maskText('13812345678');
const two = await separate.maskText('13912345678');
assert.notEqual(one, two, 'separate detector calls cannot collide');
assert.equal(separate.restore(one), '13812345678');
assert.equal(separate.restore(two), '13912345678');
assert.equal(restorePrivateSql(`select * from users where phone='${one}'`, separate), "select * from users where phone='13812345678'");
assert.throws(() => restorePrivateSql(`select ${one}`, separate));
const rows = await separate.maskValue({ columns: [{ name: 'customer_name' }, { name: 'revenue' }], rows: [['张三', 12.3], [null, 0]] }) as { rows: unknown[][] };
assert.notEqual(rows.rows[0]![0], '张三'); assert.equal(separate.restore(String(rows.rows[0]![1])), '12.3'); assert.equal(rows.rows[1]![0], null);

const model = { id: 'test', provider: 'test', api: 'openai-completions' } as Model<'openai-completions'>;
const reply: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'ok' }], api: model.api, provider: model.provider, model: model.id,
  timestamp: 0, stopReason: 'stop', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
const captured: unknown[] = [];
const stream: Models['streamSimple'] = (_m, c) => {
  captured.push(c); const out = createAssistantMessageEventStream();
  out.push({ type: 'done', reason: 'stop', message: reply }); out.end(reply); return out;
};
const raw = { streamSimple: stream, stream } as unknown as Models;
const protectedModels = withPrivacy(raw, privacy);
const context = { messages: [{ role: 'user' as const, content: original, timestamp: 0 }], systemPrompt: '电话13812345678' };
for (const method of ['complete', 'completeSimple'] as const) await protectedModels[method](model, context);
for (const method of ['stream', 'streamSimple'] as const) await protectedModels[method](model, context).result();
assert.equal(captured.length, 4);
assert(!JSON.stringify(captured).includes('13812345678'));
assert(!JSON.stringify(captured).includes('zhangsan@example.com'));
const image = await protectedModels.completeSimple(model, { messages: [{ role: 'user', content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }], timestamp: 0 }] });
assert.equal(image.stopReason, 'error'); assert.equal(captured.length, 4, 'unsupported content must never reach transport');
const schemaContext = await privacy.context({ messages: [{ role: 'user', content: JSON.stringify({ password: 'secret-plain', phone: '13812345678' }) }], tools: [{ name: 'example', parameters: { type: 'object', properties: { default: { type: 'string', description: '13812345678', enum: ['sql', 'mongodb'], const: 'sql', default: 'sql' } }, examples: [{ phone: '13812345678' }] } }] });
assert(!JSON.stringify(schemaContext).includes('secret-plain'));
assert(!JSON.stringify(schemaContext).includes('13812345678'));
assert.equal(schemaContext.tools[0]!.parameters.properties.default.type, 'string');
assert.deepEqual(schemaContext.tools[0]!.parameters.properties.default.enum, ['sql', 'mongodb']);
assert.equal(schemaContext.tools[0]!.parameters.properties.default.const, 'sql');
assert.equal(schemaContext.tools[0]!.parameters.properties.default.default, 'sql');
const escaped = privacy.importIdentity('a"b\\c', 'name');
assert.deepEqual(JSON.parse(privacy.restoreOutput(JSON.stringify({ value: escaped }))), { value: 'a"b\\c' });
const cancelDetection = new AbortController(); cancelDetection.abort();
await assert.rejects(privacy.maskData('private', '', cancelDetection.signal));

console.log('privacy: mapping and transport passed');
const root = await mkdtemp(path.join(os.tmpdir(), 'stela-privacy-test-'));
try {
  configureQueryArtifactRoot(root);
  const artifact = await writeBufferedQueryArtifact({ vaultPath: root, sessionId: 'test', runId: 'query',
    columns: [{ name: 'customer_name', typeName: 'VARCHAR' }, { name: 'phone', typeName: 'BIGINT' }, { name: 'amount', typeName: 'DOUBLE' }],
    rows: [['张三', 13812345678, 12.3], ['李四', 13912345678, 4.5], [null, null, 0]] });
  assert(artifact);
  privacy.registerSource({ ...artifact, rows: [['张三', 13812345678, 12.3]] });
  const release = privacy.releaseRequest(artifact.runId);
  assert(privacy.approveRelease(release, JSON.stringify(release.options.filter(o => o.column === 2).map(o => o.id))));
  console.log('privacy: scanning complete artifact');
  const privateArtifact = await privateQueryArtifact({ vaultPath: root, sessionId: 'test', artifact, privacy });
  assert.equal(privateArtifact.rowCount, 3);
  const chunk = await readQueryArtifactChunk({ vaultPath: root, sessionId: 'test', runId: privateArtifact.runId, offset: 0, length: 1000000 });
  const file = path.join(root, 'verify.parquet'); await fs.writeFile(file, chunk.data);
  const db = await DuckDBInstance.create(':memory:'); const con = await db.connect();
  try {
    const result = await con.runAndReadAll('select * from read_parquet(?)', [file]);
    const values = result.getRowsJson();
    assert.equal(values[0]![2], 12.3); assert.equal(values[2]![0], null);
    assert(!JSON.stringify(values).includes('13812345678'));
    assert(!JSON.stringify(values).includes('张三'));
    assert.equal(privacy.restore(String(values[0]![0])), '张三');
  } finally { con.closeSync(); db.closeSync(); }
  console.log('privacy: artifact verified');
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(privateQueryArtifact({ vaultPath: root, sessionId: 'test', artifact, privacy: new PrivacySession(true), signal: aborted.signal }));
} finally { await rm(root, { recursive: true, force: true }); }
console.log('privacy: detection, stable mapping, restoration, transport and full Python artifacts passed');
