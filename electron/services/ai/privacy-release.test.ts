import assert from 'node:assert/strict';
import { PrivacySession } from './privacy-session';
import { countColumns } from './privacy-policy';
import { createAgentTools, proposalApprovalMode, type AgentToolContext } from './agent-tools';
import { DEFAULT_APP_SETTINGS } from '../../../src/contracts/settings';

const root = new PrivacySession(true);
const task = root.forkTask();
task.setRecipients(['Test model']);
const source = { runId: 'products-1', columns: [
  { name: 'product', typeName: 'VARCHAR' }, { name: 'company', typeName: 'VARCHAR' },
  { name: 'amount', typeName: 'BIGINT' }, { name: 'detail', typeName: 'JSON' },
], rows: [['星河办公椅', '星河办公椅', 13812345678, JSON.stringify({ items: [{ product: '天穹沙发', phone: 13912345678 }], '张三': '客户', token: 'never-release-me' })]], rowCount: 1,
  sql: 'SELECT phone AS amount FROM orders', connectionName: 'demo' };
task.registerSource(source);
task.registerSource({ ...source, runId: 'products-2' });
const body = JSON.stringify(source);
const masked = await task.toolOutput('query-1', 'run_query', body);
assert(!masked.includes('星河办公椅') && !masked.includes('13812345678'));
assert(!masked.includes('天穹沙发') && !masked.includes('13912345678') && !masked.includes('张三'));
assert(!masked.includes('never-release-me'));
assert.equal(task.restore(String(await task.maskData(13812345678, 'amount'))), '13812345678', 'numeric amounts are withheld as unknown, not classified by digit count');
assert.equal(await task.maskData(null), null); assert.equal(await task.maskData(false), false);
assert.notEqual(await task.maskData('{broken-json'), '{broken-json');
assert.deepEqual([...countColumns('SELECT COUNT(*) AS n FROM orders', [{ name: 'n', typeName: 'BIGINT' }])], [0]);
for (const sql of ['SELECT phone AS n FROM orders', 'SELECT MAX(phone) AS n FROM orders', 'SELECT COUNT(*) FROM orders UNION SELECT phone FROM customers', 'WITH x AS (SELECT phone FROM t) SELECT COUNT(*) FROM x']) {
  assert.equal(countColumns(sql, [{ name: 'n', typeName: 'BIGINT' }]).size, 0, sql);
}
task.registerSource({ runId: 'count', sql: 'SELECT COUNT(*) AS n FROM orders', columns: [{ name: 'n', typeName: 'BIGINT' }], rows: [[12]], rowCount: 1 });
assert.equal(await task.maskData(12, 'n', undefined, 'count', 0), 12);
assert.equal(await task.maskData(12, 'n', undefined, 'count', 0, ['nested']), await task.maskData(12));

const release = task.releaseRequest(source.runId);
assert(!task.approveRelease(release, true), 'bare approve is not a field selection');
assert(!task.approveRelease(release, '[]'));
assert(!task.approveRelease(release, '["invented"]'));
assert(!task.approveRelease(release, false));
const selections = release.options.filter(o => (o.column === 0 && !o.path.length) || (o.column === 3 && o.path.join('/') === 'items/*/product')).map(o => o.id);
assert.equal(selections.length, 2);
assert(task.approveRelease(release, JSON.stringify(selections)));
const grantPayload = await task.toolOutput('grant-1', 'request_column_access', body);
const asContext = (callId: string, toolName: string, text: string) => ({ messages: [{ role: 'toolResult', toolCallId: callId, toolName, content: [{ type: 'text', text }] }] });
const projection = await task.context(asContext('grant-1', 'request_column_access', grantPayload));
const data = JSON.parse(projection.messages[0]!.content[0]!.text) as typeof source;
assert.equal(data.rows[0]![0], '星河办公椅');
assert.notEqual(data.rows[0]![1], '星河办公椅', 'same original from another column stays masked');
assert.notEqual(data.rows[0]![2], 13812345678);
const json = JSON.parse(String(data.rows[0]![3]));
assert.equal(json.items[0].product, '天穹沙发');
assert.notEqual(json.items[0].phone, 13912345678);
assert.equal(json.token, '***redacted***');
assert(!grantPayload.includes('星河办公椅'), 'durable tool output stays masked');
assert(!JSON.stringify(await task.context(asContext('spoof', 'request_column_access', grantPayload))).includes('星河办公椅'));
assert(!JSON.stringify(await task.context(asContext('grant-1', 'run_query', grantPayload))).includes('星河办公椅'));
assert(!JSON.stringify(await task.context(asContext('grant-1', 'request_column_access', grantPayload + ' '))).includes('星河办公椅'));
const other = await task.toolOutput('other', 'run_query', JSON.stringify({ ...source, runId: 'products-2' }));
assert(!JSON.stringify(await task.context(asContext('other', 'run_query', other))).includes('星河办公椅'), 'same original from another result stays masked');
const numericToken = await task.maskData(42, 'id');
assert.equal(task.restore(String(numericToken)), '42', 'short numeric data cells stay masked');
assert.equal(await task.maskText('Customer ID is 42.'), 'Customer ID is 42.', 'short numbers do not establish global prose identity');
assert.equal(await task.maskText('result=42', 'code'), 'result=42', 'masking data IDs must not corrupt Python numeric constants');
for (const value of ['0', '1', '2', '53', '0.53', '100.0']) await task.maskData(value);
assert.equal(await task.maskText('{"version":1,"rows":0} 1,614 (0.53%) 100.0%'), '{"version":1,"rows":0} 1,614 (0.53%) 100.0%');
const longToken = await task.maskData('7654321');
assert.equal(await task.maskText('ID 7654321; value 7654321.25; value 0.7654321; 7654321,000'), `ID ${longToken}; value 7654321.25; value 0.7654321; 7654321,000`);
const nextTask = root.forkTask();
assert(!JSON.stringify(await nextTask.context(asContext('grant-1', 'request_column_access', grantPayload))).includes('星河办公椅'), 'task permissions never enter durable mapping');
assert.throws(() => nextTask.releaseRequest(source.runId));
const derived = task.derivedView();
const derivedOutput = await task.toolOutput('python-1', 'execute_python', JSON.stringify({ result: { kind: 'scalar', value: { category: '家具', product: '星河办公椅' } } }), undefined, true);
assert(!derivedOutput.includes('星河办公椅') && !derivedOutput.includes('家具'));
assert(JSON.stringify(await task.context(asContext('python-1', 'execute_python', derivedOutput))).includes('家具'));
assert(!JSON.stringify(await nextTask.context(asContext('python-1', 'execute_python', derivedOutput))).includes('家具'));
task.closeTask();
assert(!task.approveRelease(release, JSON.stringify(selections)));
await assert.rejects(task.context(asContext('grant-1', 'request_column_access', grantPayload)), /expired/);
await assert.rejects(derived.context({ messages: [] }), /expired/);

// Real AgentTool wrappers: the model cannot approve its own request and the
// exact masked toolCall result is the only projection authority.
const privacy = new PrivacySession(true);
privacy.registerSource(source);
const ctx: Omit<AgentToolContext, 'requestProposal'> = {
  privacy, vaultPath: '/tmp', connectionName: null, connection: null,
  aiSettings: { ...DEFAULT_APP_SETTINGS.ai, privacyModeEnabled: true },
  connector: { listKinds: () => [], listDatabases: async () => [], listTables: async () => [], execute: async () => { throw new Error('no query expected'); } },
  sqlIndex: { query: async () => [] }, skills: [], mode: 'normal',
  run: { runId: 'task', notePath: null, questionsAsked: 0, toolFailureStreak: new Map() }, recordRun: async () => {},
};
assert.equal(proposalApprovalMode(true, 'privacy_release'), 'manual');
let asked = 0;
const tools = createAgentTools({ ctx, requestProposal: async (_id, proposal) => {
  asked++; assert.equal(proposal.kind, 'privacy_release');
  assert.equal(proposal.payload.privacyRelease!.options[0]!.samples[0], '星河办公椅');
  return JSON.stringify([proposal.payload.privacyRelease!.options[0]!.id]);
} });
const tool = tools.find(t => t.name === 'request_column_access')!;
const output = await tool.execute('real-grant', { runId: source.runId, reason: '判断家具类别' });
assert.equal(asked, 1);
const text = output.content.find(b => b.type === 'text')!.text;
assert(!text.includes('星河办公椅'));
assert(JSON.stringify(await privacy.context(asContext('real-grant', 'request_column_access', text))).includes('星河办公椅'));
console.log('privacy release: manual tool approval, JSON paths, numeric ambiguity, source isolation, spoof rejection, masked history and task expiry passed');

for (const decision of ['all', 'none', 'partial', 'invalid', 'closed'] as const) {
  const batched = new PrivacySession(true);
  const sources = [0, 1, 2].map(i => ({ ...source, runId: `batch-${i}`, rows: [[`private-${i}`, `company-${i}`, 100 + i, '{}']] }));
  sources.forEach(value => batched.registerSource(value));
  const calls = sources.map((value, i) => ({ type: 'toolCall', id: `call-${i}`, name: 'request_column_access', arguments: { runId: value.runId, reason: `reason-${i}` } }));
  batched.planReleaseRequests(calls);
  let proposals = 0;
  const batchTool = createAgentTools({ ctx: { ...ctx, privacy: batched }, requestProposal: async (_id, proposal) => {
    proposals++;
    const request = proposal.payload.privacyRelease!;
    assert.equal(request.sources!.length, 3);
    assert.equal(new Set(request.options.map(option => option.id)).size, request.options.length);
    assert.deepEqual(request.sources!.map(s => s.reason), ['reason-0', 'reason-1', 'reason-2']);
    if (decision === 'none') return false;
    if (decision === 'closed') { batched.closeTask(); return JSON.stringify(request.options.map(option => option.id)); }
    if (decision === 'invalid') return JSON.stringify([request.options[0]!.id, 'invented']);
    return JSON.stringify(request.options.filter(option => decision === 'all' || (option.sourceRunId === 'batch-1' && option.column === 0)).map(option => option.id));
  } }).find(t => t.name === 'request_column_access')!;
  if (decision === 'closed') {
    await assert.rejects(batchTool.execute('call-0', calls[0]!.arguments));
    assert(!batched.hasGrants);
    continue;
  }
  for (const [i, call] of calls.entries()) {
    const result = await batchTool.execute(call.id, call.arguments);
    const text = result.content.find(b => b.type === 'text')!.text;
    assert(!text.includes(`private-${i}`), 'batch history stays masked');
    const context = JSON.stringify(await batched.context(asContext(call.id, 'request_column_access', text)));
    assert.equal(context.includes(`private-${i}`), decision === 'all' || (decision === 'partial' && i === 1));
    assert.equal(context.includes(`company-${i}`), decision === 'all');
  }
  assert.equal(proposals, 1, `one decision for three sequential calls: ${decision}`);
  const fresh = batched.forkTask();
  assert(!fresh.hasGrants);
}
console.log('privacy batch: three sequential calls, allow all, reject all, partial source scope, invalid answers and closed tasks passed');
