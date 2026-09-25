import assert from 'node:assert/strict';
import { countColumns } from './privacy-policy';
import { PrivacySession } from './privacy-session';

const columns = ['category', 'cnt', 'missing', 'amount'].map(name => ({ name, typeName: 'VARCHAR' }));
const sql = "SELECT category, COUNT(*) AS cnt, SUM(CASE WHEN asset_id IS NULL OR asset_id='' THEN 1 ELSE 0 END) AS missing, SUM(amount) AS amount FROM orders WHERE project='example' GROUP BY category ORDER BY cnt DESC LIMIT 30";
assert.deepEqual([...countColumns(sql, columns)], [1, 2]);
assert.deepEqual([...countColumns('SELECT COUNT(DISTINCT asset_id) AS n, COUNT(id) m FROM orders WHERE active=1', columns.slice(0, 2))], [0, 1]);
assert.deepEqual([...countColumns('SELECT COUNT(*) n FROM orders WHERE category IN (\'a,b\',\'c\') GROUP BY category HAVING COUNT(*)>0', columns.slice(0, 1))], [0]);
assert.deepEqual([...countColumns('SELECT CASE WHEN x=1 THEN \'a,b\' ELSE \'other\' END kind, COUNT(*) n FROM orders GROUP BY kind', columns.slice(0, 2))], [1]);
for (const query of [
  'SELECT phone AS cnt FROM orders', 'SELECT SUM(phone) AS cnt FROM orders',
  'SELECT MIN(id) AS cnt FROM orders', 'SELECT COUNT(*) + MAX(phone) AS cnt FROM orders',
  'SELECT COUNT(*) OVER () AS cnt FROM orders', 'SELECT COUNT(*) n FROM t UNION SELECT phone FROM t',
  'WITH t AS (SELECT phone FROM orders) SELECT COUNT(*) FROM t',
  'SELECT COUNT(*) FROM (SELECT phone FROM orders) t',
  'SELECT COUNT(*) FROM orders; SELECT phone FROM orders',
  'SELECT COUNT(*) FROM orders /* ambiguous dialect */',
  "SELECT SUM(CASE WHEN active=1 THEN phone ELSE 0 END) FROM orders",
  'SELECT SUM(CASE WHEN active=1 THEN 1 ELSE 2 END) FROM orders',
  'SELECT SUM(CASE WHEN active=1 THEN 1 ELSE 0 END)+phone FROM orders',
  'SELECT SUM(CASE WHEN active=1 THEN 1 WHEN active=2 THEN phone ELSE 0 END) FROM orders',
]) assert.equal(countColumns(query, columns.slice(0, 1)).size, 0, query);
assert.equal(countColumns('SELECT *, COUNT(*) n FROM orders', columns.slice(0, 2)).size, 0);
assert.equal(countColumns('SELECT t.*, COUNT(*) n FROM orders t', columns.slice(0, 2)).size, 0);
assert.equal(countColumns('SELECT category, COUNT(*) n FROM orders', columns.slice(0, 1)).size, 0);

const privacy = new PrivacySession(true);
privacy.registerSource({ runId: 'counts', sql, columns, rows: [['Furniture', '305071', '539', '7654321']], rowCount: 1 });
const raw = { runId: 'counts', columns, rows: [['Furniture', '305071', '539', '7654321']] };
const text = await privacy.toolOutput('query', 'run_query', JSON.stringify(raw));
const rows = (JSON.parse(text) as { rows: unknown[][] }).rows;
assert.notEqual(rows[0]![0], 'Furniture');
assert.deepEqual(rows[0]!.slice(1, 3), ['305071', '539']);
assert.notEqual(rows[0]![3], '7654321');
const context = await privacy.context({ messages: [{ role: 'toolResult', toolCallId: 'query', toolName: 'run_query', content: [{ type: 'text', text }] }] });
assert.equal(context.messages[0]!.content[0]!.text, text, 'count strings survive repeated transport masking');
assert.equal(await privacy.maskData(42, '', undefined, 'counts', 1), 42);
assert.notEqual(await privacy.maskData('not a count', '', undefined, 'counts', 1), 'not a count');
assert.notEqual(await privacy.maskData(12.5, '', undefined, 'counts', 1), 12.5);
assert.notEqual(await privacy.maskData('305071', '', undefined, 'counts', 1, ['id']), '305071');
assert.notEqual(await privacy.maskData('305071', '', undefined, 'new-result', 1), '305071', 'no count proof for another source');
console.log('privacy counts: grouped/VARCHAR/binary CASE counts, parser fallbacks, source/path isolation and repeated transport passed');
