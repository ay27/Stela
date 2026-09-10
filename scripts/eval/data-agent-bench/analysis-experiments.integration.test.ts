import { loadAppSettings, patchAppSettings } from "../../../electron/services/settings-store";
/** Offline real Pyodide + host ledger. No model/network requests. */
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { HeadlessPyodidePool } from "./headless-python";
import { SemanticExecution } from "../../../electron/services/ai/semantic-execution";
import { configureQueryArtifactRoot, writeBufferedQueryArtifact } from "../../../electron/services/query-artifacts";
import { analysisSnapshotSchema, analysisToolSummary, readAnalysisSnapshot } from "../../../electron/shared/analysis-contract";
import { IPC_SCHEMAS, parseInput } from "../../../electron/shared/ipc-schema";
import { IPC } from "../../../electron/shared/ipc-channels";
import type { PythonExecutionResult } from "../../../electron/shared/types";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "stela-experiment-test-"));
configureQueryArtifactRoot(path.join(root, "artifacts"));
const pool = new HeadlessPyodidePool(path.resolve("node_modules/.cache/stela-pyodide"), 1);
const workspace = await pool.lease();
const base = { vaultPath: root, sessionId: "experiment", artifacts: {}, analysisContext: {
  runId: "experiment-run", question: "Classify every article by topic", semanticOptimization: true, automaticContracts: true } };
function executor(tokens: number, actual: number | undefined = 20, identity = "fixture") {
  const sent: string[] = [];
  const engine = new SemanticExecution({ identity, optimizationEnabled: true, signal: new AbortController().signal,
    budget: { records: 1000, requests: 200, tokens }, authorize: async () => true,
    complete: async (_system, user) => {
      const input = JSON.parse(user) as { records: { id: string; data: { text: string } }[] };
      sent.push(...input.records.map((r) => r.data.text));
      return { tokens: actual, text: JSON.stringify({ rows: input.records.map((r) => ({ id: r.id, status: "success", value: "topic", evidence: [r.data.text] })) }) };
    } });
  return { engine, sent, runSemantic: (raw: string, signal?: AbortSignal) => engine.execute(raw, signal) };
}
function scalar(result: PythonExecutionResult): Record<string, unknown> {
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.kind, "scalar");
  return result.value.kind === "scalar" ? result.value.value as Record<string, unknown> : {};
}
const classify = "await semantic.classify(df, columns=['text'], labels={'topic':'any topic'}, instructions='Classify text', id_column='id')";
try {
  const initial = await loadAppSettings(root);
  assert.equal(initial.ai.semanticOptimizationEnabled, false);
  assert.equal(initial.ai.automaticAnalysisContractsEnabled, false);
  for (const [semanticOptimizationEnabled, automaticAnalysisContractsEnabled] of [[true, false], [false, true], [false, false]]) {
    const patch = { ai: { semanticOptimizationEnabled, automaticAnalysisContractsEnabled } };
    const parsed = parseInput<{ patch: typeof patch }>(IPC.SETTINGS_PATCH, { patch });
    await patchAppSettings(root, parsed.patch);
    const saved = await loadAppSettings(root);
    assert.equal(saved.ai.semanticOptimizationEnabled, semanticOptimizationEnabled);
    assert.equal(saved.ai.automaticAnalysisContractsEnabled, automaticAnalysisContractsEnabled);
  }
  const inference = executor(200000);
  const result = await workspace.execute({ ...base, ...inference,
    code: `df = pd.DataFrame({'id':range(10000), 'text':['article '+str(i%100) for i in range(10000)]})\nbatch = ${classify}\nresult = dict(summary=batch.summary, rowCount=len(batch.rows), ids=batch.rows.id.nunique())` });
  const value = scalar(result);
  assert.equal(value.rowCount, 10000);
  assert.equal(value.ids, 10000);
  assert.equal(inference.sent.length, 100);
  assert.equal(new Set(inference.sent).size, 100);
  assert.equal((value.summary as { complete: boolean }).complete, true);
  assert.equal(result.analysis?.coverage.state, "unknown", "arbitrary frames cannot establish source lineage");
  assert.ok(result.analysis);
  analysisSnapshotSchema.parse(result.analysis);
  IPC_SCHEMAS[IPC.AI_PYTHON_RUNTIME_RESPOND].parse({ jobId: "123e4567-e89b-12d3-a456-426614174000", result });
  assert.deepEqual(readAnalysisSnapshot(analysisToolSummary(JSON.stringify({ result: "x".repeat(8000), analysis: result.analysis }), 480)), result.analysis);
  const cached = scalar(await workspace.execute({ ...base, ...inference, code: `again = ${classify}; result = again.summary` }));
  assert.equal(inference.sent.length, 100, "all keys are checked, not just the first eight");
  assert.equal(cached.cached, 100);
  const changed = executor(200000, 20, "different-model");
  const badResume = await workspace.execute({ ...base, ...changed, code: `result = await semantic.classify(df, columns=['text'], labels={'topic':'any topic'}, instructions='Classify text', id_column='id', resume=batch)` });
  assert.equal(badResume.ok, false);
  assert.equal(changed.sent.length, 0);
  assert.match(badResume.error ?? "", /identity changed/);
  const literal = scalar(await workspace.execute({ ...base, ...inference,
    code: `df = pd.DataFrame({'id':range(5), 'text':['#ABC1','ABC1','abc1','ABC2','ABC1']}); output = ${classify}; result = output.summary` }));
  assert.equal((literal.preflight as { uniqueRows: number }).uniqueRows, 4);
  assert.equal(inference.sent.length, 104, "case, prefixes and digits are not normalized away");

  const precise = scalar(await workspace.execute({ ...base, ...inference,
    code: "df = pd.DataFrame({'id':[0,1], 'text':['same','same'], 'amount':[1.000000000001, 1.000000000002]}); output = await semantic.classify(df, columns=['text','amount'], labels={'topic':'any topic'}, instructions='Classify text', id_column='id'); result = output.summary" }));
  assert.equal((precise.preflight as { uniqueRows: number }).uniqueRows, 2, "full floating-point values remain distinct");
  const pilot = executor(60000);
  const pilotResult = scalar(await workspace.execute({ ...base, ...pilot,
    code: `df = pd.DataFrame({'id':range(200), 'text':['pilot '+str(i) for i in range(200)]}); output = ${classify}; result = output.summary` }));
  assert.ok(pilotResult.pilot);
  assert.equal(pilotResult.complete, true);
  assert.equal(pilot.sent.length, 200);
  assert.ok((pilotResult.pilot as { reserved: number }).reserved <= 6000);

  const expensive = executor(60000, 3000);
  const forecastStop = scalar(await workspace.execute({ ...base, ...expensive, code: `output = ${classify}; result = output.summary` }));
  assert.equal(forecastStop.stopReason, "forecast_exceeds_remaining_budget");
  assert.equal(expensive.sent.length, 8);

  const unknown = executor(60000, undefined);
  // Explicit undefined is also the default parameter; replace completion to omit usage.
  const noUsage = new SemanticExecution({ identity: "unknown", optimizationEnabled: true, signal: new AbortController().signal,
    budget: { records: 1000, requests: 200, tokens: 60000 }, authorize: async () => true,
    complete: async (_system, user) => { const input = JSON.parse(user) as { records: { id: string; data: { text: string } }[] };
      unknown.sent.push(...input.records.map((r) => r.data.text));
      return { text: JSON.stringify({ rows: input.records.map((r) => ({ id: r.id, status: "success", value: "topic", evidence: [r.data.text] })) }) }; } });
  const unknownInput = { ...base, runSemantic: (raw: string) => noUsage.execute(raw) };
  const unknownResult = scalar(await workspace.execute({ ...unknownInput, code: `output = ${classify}; result = output.summary` }));
  assert.equal(unknownResult.stopReason, "pilot_usage_unknown");
  assert.equal(unknown.sent.length, 8);
  const retryUnknown = scalar(await workspace.execute({ ...unknownInput, code: `output = ${classify}; result = output.summary` }));
  assert.equal(retryUnknown.stopReason, "pilot_usage_unknown");
  assert.equal(unknown.sent.length, 8, "rejected repeated operation never spends another pilot");
  const small = executor(5000);
  const rejected = scalar(await workspace.execute({ ...base, ...small, code: `output = ${classify}; result = output.summary` }));
  assert.equal(rejected.stopReason, "pilot_reservation_exceeds_cap");
  assert.equal(small.sent.length, 0);
  const deficit = scalar(await workspace.execute({ ...base, ...small,
    code: `df = pd.DataFrame({'id':range(1001), 'text':['unique '+str(i) for i in range(1001)]}); output = ${classify}; result = output.summary` }));
  assert.equal(deficit.stopReason, "full_operation_exceeds_remaining_budget");
  assert.equal(small.sent.length, 0);

  const source = await writeBufferedQueryArtifact({ vaultPath: root, sessionId: base.sessionId, runId: "articles-source",
    columns: [{ name: "id", typeName: "INTEGER" }, { name: "text", typeName: "VARCHAR" }],
    rows: Array.from({ length: 14860 }, (_, i) => [i, "topic " + i % 5]) });
  assert.ok(source);
  const bound = await workspace.execute({ ...base, artifacts: { articles: source },
    code: "population = to_df('articles'); analysis.current.bind_population(population, id_column='id', source='articles'); result = len(population)" });
  assert.equal(bound.ok, true, bound.error);
  assert.equal(bound.analysis?.coverage.total, 14860);
  const subset = await workspace.execute({ ...base, ...inference,
    code: `df = population.head(989).copy(); output = ${classify}; result = output.summary` });
  scalar(subset);
  assert.equal(subset.analysis?.coverage.state, "subset");
  assert.equal(subset.analysis?.coverage.total, 14860);
  assert.equal(subset.analysis?.coverage.processed, 989);
  assert.equal(subset.analysis?.coverage.unprocessed, 13871);
  const frozen = await workspace.execute({ ...base, code: "analysis.current.bind_population(df, id_column='id', source='articles')" });
  assert.equal(frozen.ok, false);
  assert.match(frozen.error ?? "", /frozen/);
  assert.equal(frozen.analysis?.coverage.total, 14860);
  const complete = await workspace.execute({ ...base, ...inference, code: `df = population; output = ${classify}; result = output.summary` });
  assert.equal(complete.analysis?.coverage.state, "full");
  const newSource = await writeBufferedQueryArtifact({ vaultPath: root, sessionId: base.sessionId, runId: 'articles-refreshed',
    columns: source.columns, rows: Array.from({ length: 14860 }, (_, i) => [i, 'topic ' + i % 5]) });
  assert.ok(newSource);
  const refreshed = await workspace.execute({ ...base, artifacts: { articles: newSource }, code: "result = 1" });
  assert.equal(refreshed.analysis?.coverage.state, "unknown", "refresh invalidates current coverage without another semantic call");
  const error = await workspace.execute({ ...base,
    code: "analysis.current.claim('metric', 'topic count', source='invented', evidence='made up'); analysis.current.claim('population', 'all articles', source='question', evidence='every article'); analysis.current.check_equal('mismatch', 1, 2, source='articles', evidence='observed rows'); raise ValueError('original failure')" });
  assert.equal(error.ok, false);
  assert.match(error.error ?? "", /original failure/);
  assert.equal(error.analysis?.status, "partial_mutation_possible");
  assert.deepEqual(error.analysis?.failedChecks, ["mismatch"]);
  assert.equal(error.analysis?.claims.find((c) => c.field === "metric")?.sourceResolved, false);
  assert.equal(error.analysis?.claims.find((c) => c.field === "population")?.sourceResolved, true);
  const revision = await workspace.execute({ ...base, code: "revised = analysis.contract(required=['metric']); result = len(analysis.history())" });
  assert.equal(revision.ok, true, revision.error);
  assert.equal(revision.analysis?.version, 2);
  assert.equal(revision.analysis?.previousVersions, 1);
  assert.equal(revision.analysis?.coverage.state, "unknown");
  await workspace.reset!(base.vaultPath, base.sessionId);
  const reset = await workspace.execute({ ...base, code: "result = 1" });
  assert.equal(reset.analysis?.version, 1);
  assert.notEqual(reset.analysis?.generation, revision.analysis?.generation);
  const off = await workspace.execute({ ...base, analysisContext: undefined, code: "result = 42" });
  assert.equal(off.analysis, undefined, "legacy outputs unchanged with experiment off");
  console.log("analysis experiments: 10000→100→10000, cache, identity, cost pilot, rejection, frozen population, snapshots and IPC passed");
} finally {
  await workspace.close();
  await pool.close();
  await fs.rm(root, { recursive: true, force: true });
}
