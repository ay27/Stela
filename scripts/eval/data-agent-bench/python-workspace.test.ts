import assert from "node:assert/strict";
import path from "node:path";
import { promises as fs } from "node:fs";
import os from "node:os";
import { configureQueryArtifactRoot, writeBufferedQueryArtifact } from "../../../electron/services/query-artifacts";
import { HeadlessPyodidePool } from "./headless-python";
import { SemanticExecution } from "../../../electron/services/ai/semantic-execution";

const pool = new HeadlessPyodidePool(path.resolve("node_modules/.cache/stela-pyodide"), 1);
const workspace = await pool.lease();
const base = { vaultPath: "/fixture-vault", sessionId: "workspace-test", artifacts: {} };
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "stela-workspace-test-"));
configureQueryArtifactRoot(path.join(temporary, "artifacts"));
let calls = 0;
const signal = new AbortController().signal;
const semantic = new SemanticExecution({ identity: "fixture", signal, authorize: async () => true,
  complete: async (_system, user) => {
    calls++;
    const input = JSON.parse(user) as { operation: string; records: Array<{ id: string; data: { text?: string; left?: { name: string }; right?: { name: string } } }> };
    return { tokens: 20, text: JSON.stringify({ rows: input.records.map((r) => ({
      id: r.id, status: "success", value: input.operation === "resolve" ? (r.id === "0:2" ? "different" : "same") : "sports",
      evidence: [r.data.text ?? r.data.left!.name],
    })) }) };
  } });
try {
  const first = await workspace.execute({ ...base, code: "df = pd.DataFrame({'text':['football', 'tennis']}); counter = 7; result = len(df)" });
  assert.equal(first.ok, true, first.error);
  assert.equal(first.workspace?.status, "ready");
  const second = await workspace.execute({ ...base, code: "result = counter + len(df)" });
  assert.deepEqual(second.value, { kind: "scalar", value: 9 });
  assert.equal(first.workspace?.generation, second.workspace?.generation);
  const noResult = await workspace.execute({ ...base, code: "counter += 1" });
  assert.deepEqual(noResult.value, { kind: "none" });
  assert.equal(noResult.workspace?.variables.some((v) => v.name === "result"), false);
  assert.equal(noResult.workspace?.variables.some((v) => v.name === "counter"), true);
  assert.equal(noResult.workspace?.generation, first.workspace?.generation, "clearing result is not state loss");
  const failed = await workspace.execute({ ...base, code: "counter = 11; raise ValueError('fixture')" });
  assert.equal(failed.workspace?.status, "partial_mutation_possible");
  assert.deepEqual((await workspace.execute({ ...base, code: "result = counter" })).value, { kind: "scalar", value: 11 });
  const classified = await workspace.execute({ ...base, runSemantic: (raw) => semantic.execute(raw),
    code: "classified = await semantic.classify(df, columns=['text'], labels={'sports':'sport'}, instructions='Classify topic'); result = classified.summary" });
  assert.equal(classified.ok, true, classified.error);
  assert.equal(calls, 1);
  const largeBatch = await workspace.execute({ ...base, runSemantic: (raw, jobSignal) => semantic.execute(raw, jobSignal),
    code: "many = pd.DataFrame({'text':['football'] * 40}); batch = await semantic.classify(many, columns=['text'], labels={'sports':'sport'}, instructions='Forty-row topic task'); result = {'rows':len(batch.rows), 'success':batch.summary['success']}" });
  assert.equal(largeBatch.ok, true, largeBatch.error);
  assert.deepEqual(largeBatch.value, { kind: "scalar", value: { rows: 40, success: 40 } });
  const reused = await workspace.execute({ ...base, code: "result = len(classified.rows)" });
  assert.deepEqual(reused.value, { kind: "scalar", value: 2 });
  const resolved = await workspace.execute({ ...base, runSemantic: (raw) => semantic.execute(raw), code:
    "entities = pd.DataFrame({'name':['A','B','C']}); links = await semantic.resolve(entities, columns=['name'], instructions='Same real entity'); result = int(links.mapping.canonical_id.notna().sum())" });
  assert.equal(resolved.ok, true, resolved.error);
  assert.deepEqual(resolved.value, { kind: "scalar", value: 0 }, "A=B and B=C but A!=C must not merge");
  const long = await workspace.execute({ ...base, code: "print('x' * 100000); result = 42" });
  assert.equal(long.stdoutTruncated, true);
  assert.ok(long.stdout.length <= 8000);
  assert.deepEqual(long.value, { kind: "scalar", value: 42 });
  const oldSource = await writeBufferedQueryArtifact({ vaultPath: base.vaultPath, sessionId: base.sessionId, runId: "old-source",
    columns: [{ name: "amount", typeName: "INTEGER" }], rows: [[10]] });
  const newSource = await writeBufferedQueryArtifact({ vaultPath: base.vaultPath, sessionId: base.sessionId, runId: "new-source",
    columns: [{ name: "amount", typeName: "INTEGER" }], rows: [[30]] });
  assert.ok(oldSource && newSource);
  const loaded = await workspace.execute({ ...base, artifacts: { orders: { ...oldSource, incomplete: true } }, code: "old_df = to_df('orders'); result = 1" });
  assert.equal(loaded.ok, true, loaded.error);
  const retained = await workspace.execute({ ...base, code: "result = int(con.sql('SELECT SUM(amount) FROM orders').fetchone()[0])" });
  assert.deepEqual(retained.value, { kind: "scalar", value: 10 }, "lazy inputs remain readable across cells");
  assert.equal(retained.workspace?.sources.find((s) => s.alias === "orders")?.incomplete, true);
  const refreshed = await workspace.execute({ ...base, artifacts: { orders: newSource }, code: "result = {'old':int(old_df.amount.sum()), 'new':int(to_df('orders').amount.sum())}" });
  assert.deepEqual(refreshed.value, { kind: "scalar", value: { old: 10, new: 30 } });
  assert.deepEqual(refreshed.workspace?.refreshedAliases, ["orders"]);
  assert.notEqual(loaded.workspace?.sources[0]?.version, refreshed.workspace?.sources[0]?.version);
  assert.equal(refreshed.workspace?.sources.find((s) => s.alias === "orders")?.incomplete, false);
  const empty = await writeBufferedQueryArtifact({ vaultPath: base.vaultPath, sessionId: base.sessionId, runId: "empty-source", columns: [], rows: [] });
  assert.ok(empty);
  await workspace.execute({ ...base, artifacts: { empty }, code: "result = len(to_df('empty'))" });
  const retainedEmpty = await workspace.execute({ ...base, code: "result = tables['empty']" });
  assert.equal(retainedEmpty.value.kind, "table", "zero-column relation type survives later cells");
  await assert.rejects(workspace.execute({ ...base, sessionId: "other", code: "result = counter" }), /another session/);
  await workspace.reset!(base.vaultPath, base.sessionId);
  const reset = await workspace.execute({ ...base, code: "result = counter" });
  assert.equal(reset.ok, false);
  assert.match(reset.error ?? "", /NameError/);
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 100);
  await assert.rejects(workspace.execute({ ...base, signal: stop.signal, code: "while True: pass" }), /cancelled/);
  clearTimeout(timer);
  await assert.rejects(workspace.execute({ ...base, code: "result = 1" }), /workspace_lost/);
  const rebuilt = await workspace.execute({ ...base, code: "counter = 42; result = counter" });
  assert.deepEqual(rebuilt.value, { kind: "scalar", value: 42 });
  assert.notEqual(rebuilt.workspace?.generation, reset.workspace?.generation);
  assert.equal(rebuilt.workspace?.variables.some((v) => v.name === "old_df"), false);
  assert.deepEqual(rebuilt.workspace?.sources, [], "destroyed Worker sources are not silently replayed");
} finally {
  await workspace.close();
  await pool.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
console.log("Python workspace and semantic bridge tests passed");
