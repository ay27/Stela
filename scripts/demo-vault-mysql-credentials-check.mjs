// Run after building connector-mysql, against the local public Demo database.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const plugin = require('../plugins/connector-mysql/dist/index.cjs').default;
const connector = plugin.create({ pluginDir: '', log: { debug() {}, info() {}, warn() {}, error() {} } });
const config = { host: '127.0.0.1', port: 3306, user: 'demo', database: 'stela_demo' };
try {
  await assert.rejects(connector.test(config), /Access denied/);
  assert.equal((await connector.test({ ...config, password: 'demo' })).ok, true);
  assert.equal((await connector.test({ ...config, password: 'demo' })).ok, true);
  await assert.rejects(connector.test({ ...config, password: 'incorrect-demo-password' }), /Access denied/);
  assert.equal((await connector.test({ ...config, password: 'demo' })).ok, true);
  console.log('MySQL credential changes take effect in the same connector instance.');
} finally {
  await connector.dispose();
}
