import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PrivacySession } from '../../../electron/services/ai/privacy-session';
import { configureQueryArtifactRoot, writeBufferedQueryArtifact, privateQueryArtifact } from '../../../electron/services/query-artifacts';
import { assertPyodideAssets, HeadlessPyodidePool } from './headless-python';

const root = await mkdtemp(path.join(os.tmpdir(), 'stela-private-python-'));
const assetDir = path.resolve('node_modules/.cache/stela-pyodide');
await assertPyodideAssets(assetDir);
const pool = new HeadlessPyodidePool(assetDir, 1);
try {
  configureQueryArtifactRoot(path.join(root, 'artifacts'));
  const source = await writeBufferedQueryArtifact({ vaultPath: root, sessionId: 'private', runId: 'orders',
    columns: [{ name: 'customer_name', typeName: 'VARCHAR' }, { name: 'phone', typeName: 'VARCHAR' }, { name: 'amount', typeName: 'DOUBLE' }],
    rows: [['张三', '13812345678', 12.5], ['张三', '13812345678', 7.5], ['李四', '13912345678', 30], [null, null, 4]] });
  assert(source);
  const privacy = new PrivacySession(true);
  const masked = await privateQueryArtifact({ vaultPath: root, sessionId: 'private', artifact: source, privacy });
  const result = await pool.execute({ vaultPath: root, sessionId: 'private', artifacts: { orders: masked }, code: `
df = to_df('orders')
groups = df.groupby('customer_name').amount.sum().sort_values().tolist()
print(df.to_json(force_ascii=False))
result = {'groups': groups, 'total': float(df.amount.sum()), 'rows': len(df), 'null_names': int(df.customer_name.isna().sum()), 'same_identity': bool(df.phone.iloc[0] == df.phone.iloc[1]), 'masked': bool(df.phone.iloc[0].startswith('STELA_PII_'))}
` });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.value, { kind: 'scalar', value: { groups: [20, 30], total: 54, rows: 4, null_names: 1, same_identity: true, masked: true } });
  for (const original of ['张三', '李四', '13812345678', '13912345678']) assert(!JSON.stringify(result).includes(original));
  console.log('Privacy real Pyodide: full masked Parquet, identity grouping, numeric sums, nulls and stdout passed.');
} finally { await pool.close(); await rm(root, { recursive: true, force: true }); }
