/**
 * The one runnable check for the sandbox `query()` bridge: a real Pyodide run
 * where user code awaits a host-served query, joins two connections, and returns
 * a scalar. Fails if top-level await, the injected JS callable, the lazily
 * registered DuckDB view, or the host-side refusal path stops working.
 */

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  configureQueryArtifactRoot,
  writeBufferedQueryArtifact,
} from "../../../electron/services/query-artifacts";
import { assertPyodideAssets, HeadlessPyodidePool } from "./headless-python";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const assetDir = path.join(repoRoot, "node_modules", ".cache", "stela-pyodide");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "stela-query-bridge-"));
configureQueryArtifactRoot(path.join(root, "artifacts"));

const vaultPath = path.join(root, "vault");
const sessionId = "session-query-bridge";
const orders = await writeBufferedQueryArtifact({
  vaultPath,
  sessionId,
  runId: "orders-run",
  columns: [{ name: "region", typeName: "TEXT" }, { name: "amount", typeName: "BIGINT" }],
  rows: [["north", 10], ["south", 32], ["north", 5]],
});
const regions = await writeBufferedQueryArtifact({
  vaultPath,
  sessionId,
  runId: "regions-run",
  columns: [{ name: "region", typeName: "TEXT" }, { name: "market", typeName: "TEXT" }],
  rows: [["north", "EMEA"], ["south", "APAC"]],
});
assert.ok(orders && regions);

await assertPyodideAssets(assetDir);
const pool = new HeadlessPyodidePool(assetDir, 1);
try {
  const served: Array<{ connectionName: string; request: string }> = [];
  const result = await pool.execute({
    vaultPath,
    sessionId,
    artifacts: {},
    code: [
      "o = (await query('warehouse', 'SELECT region, amount FROM orders')).df()",
      "r = (await query('crm', 'SELECT region, market FROM regions')).df()",
      "df = o.merge(r, on='region')",
      "result = int(df[df['market'] == 'EMEA']['amount'].sum())",
    ].join("\n"),
    runQuery: async ({ connectionName, request }) => {
      served.push({ connectionName, request });
      return request.includes("regions") ? regions : orders;
    },
  });
  assert.equal(result.ok, true, `${result.error}\n${result.stdout}`);
  assert.deepEqual(result.value, { kind: "scalar", value: 15 });
  assert.deepEqual(served.map((item) => item.connectionName), ["warehouse", "crm"]);
  // A SQL string arrives as a normalizable DataQueryRequest, not raw text.
  assert.deepEqual(JSON.parse(served[0]!.request), {
    language: "sql",
    query: "SELECT region, amount FROM orders",
  });
  // Each fetched relation reports its own shape, so the model never probes it.
  assert.match(result.stdout, /\[query\] q1: 3 rows x 2 cols \| region:VARCHAR, amount:BIGINT/);
  assert.match(result.stdout, /\[query\] q2: 2 rows x 2 cols/);

  // Aliases must not collide across calls in one execution.
  const twice = await pool.execute({
    vaultPath,
    sessionId,
    artifacts: {},
    code: [
      "a = await query('warehouse', 'SELECT region, amount FROM orders')",
      "b = await query('warehouse', 'SELECT region, amount FROM orders')",
      "result = int(a.count('*').fetchone()[0] + b.count('*').fetchone()[0])",
    ].join("\n"),
    runQuery: async () => orders,
  });
  assert.equal(twice.ok, true, twice.error);
  assert.deepEqual(twice.value, { kind: "scalar", value: 6 });

  // A dict request defaults to MongoDB so non-SQL sources reach Python too.
  const mongoRequests: string[] = [];
  const mongo = await pool.execute({
    vaultPath,
    sessionId,
    artifacts: {},
    code: [
      "docs = await query('mongo', {'collection': 'orders', 'filter': {}, 'limit': None})",
      "result = int(docs.count('*').fetchone()[0])",
    ].join("\n"),
    runQuery: async ({ request }) => {
      mongoRequests.push(request);
      return orders;
    },
  });
  assert.equal(mongo.ok, true, mongo.error);
  assert.deepEqual(mongo.value, { kind: "scalar", value: 3 });
  assert.deepEqual(JSON.parse(mongoRequests[0]!), {
    collection: "orders",
    filter: {},
    limit: null,
    language: "mongodb",
  });

  // Without a granted connection the sandbox has no data path at all.
  const denied = await pool.execute({
    vaultPath,
    sessionId,
    artifacts: {},
    code: "result = await query('warehouse', 'SELECT 1')",
  });
  assert.equal(denied.ok, false);
  assert.match(denied.error ?? "", /query\(\) is unavailable/);

  // A host refusal (guard, unknown connection) must surface as a Python error
  // the model can read, not a worker crash.
  const refused = await pool.execute({
    vaultPath,
    sessionId,
    artifacts: {},
    code: "result = await query('warehouse', 'UPDATE t SET a = 1')",
    runQuery: async () => {
      throw new Error("Mutating statements are blocked by default.");
    },
  });
  assert.equal(refused.ok, false);
  assert.match(refused.error ?? "", /Mutating statements are blocked/);
} finally {
  await pool.close();
  await fs.rm(root, { recursive: true, force: true });
}

console.log("sandbox query() bridge tests passed.");
