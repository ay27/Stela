import assert from "node:assert/strict";

import type { AssistantMessage, Model, Models } from "@earendil-works/pi-ai";

import {
  AnalysisEfficiencyLedger,
  FAILURE_REVIEW_THRESHOLD,
  parseStrategyReview,
  QUERY_CHURN_REVIEW_THRESHOLD,
  QUERY_FAMILY_HINT_THRESHOLD,
  QUERY_FAMILY_REVIEW_THRESHOLD,
  queryFamily,
  runStrategyReview,
} from "./analysis-efficiency";

const sqlA = queryFamily({ language: "sql", database: "db", query: "SELECT * FROM t WHERE id = 1 AND name = 'A'" });
const sqlB = queryFamily({ language: "sql", database: "db", query: "select * from t where id=99 and name='B'" });
assert.equal(sqlA, sqlB);
assert.notEqual(sqlA, queryFamily({ language: "sql", database: "db", query: "SELECT count(*) FROM t WHERE id = 1" }));

const mongoA = queryFamily({ language: "mongodb", database: "db", collection: "items", filter: { city: "A" } });
const mongoB = queryFamily({ language: "mongodb", database: "db", collection: "items", filter: { city: "B" } });
assert.equal(mongoA, mongoB);
assert.notEqual(mongoA, queryFamily({ language: "mongodb", database: "db", collection: "items", filter: { state: "B" } }));

function queryResult(rowCount = 1) {
  return [{ type: "text" as const, text: JSON.stringify({ result: { rowCount, rows: rowCount ? [[1]] : [] } }) }];
}

{
  const ledger = new AnalysisEfficiencyLedger();
  let hintAt = 0;
  let reviewAt = 0;
  for (let index = 1; index <= QUERY_FAMILY_REVIEW_THRESHOLD; index += 1) {
    const signal = ledger.recordResult({
      toolName: "run_query",
      args: { language: "sql", database: "db", query: `SELECT * FROM t WHERE id = ${index}` },
      content: queryResult(),
      isError: false,
    });
    if (signal.hint) hintAt = index;
    if (signal.reviewTrigger) reviewAt = index;
  }
  assert.equal(hintAt, QUERY_FAMILY_HINT_THRESHOLD);
  assert.equal(reviewAt, QUERY_FAMILY_REVIEW_THRESHOLD);
  assert.equal(ledger.metrics().reviewTrigger, "query_family_fanout");
}

{
  const ledger = new AnalysisEfficiencyLedger();
  let trigger = null;
  for (let index = 0; index < QUERY_CHURN_REVIEW_THRESHOLD; index += 1) {
    trigger = ledger.recordResult({
      toolName: "run_query",
      args: { language: "sql", database: "db", query: `SELECT ${index} AS n, col_${index} FROM table_${index}` },
      content: queryResult(),
      isError: false,
    }).reviewTrigger ?? trigger;
  }
  assert.equal(trigger, "query_churn");
  ledger.recordResult({ toolName: "execute_python", args: {}, content: queryResult(), isError: false });
  for (let index = 1; index < QUERY_FAMILY_REVIEW_THRESHOLD; index += 1) {
    const signal = ledger.recordResult({
      toolName: "run_query",
      args: { language: "sql", query: `SELECT * FROM after_progress WHERE id = ${index}` },
      content: queryResult(),
      isError: false,
    });
    assert.equal(signal.runQueryCallsSinceProgress, index);
    assert.equal(signal.reviewTrigger, null);
  }
}

{
  const ledger = new AnalysisEfficiencyLedger();
  for (let phase = 0; phase < 2; phase += 1) {
    for (let index = 1; index < QUERY_FAMILY_REVIEW_THRESHOLD; index += 1) {
      const signal = ledger.recordResult({
        toolName: "run_query",
        args: { language: "sql", query: `SELECT * FROM phase_items WHERE id = ${phase * 100 + index}` },
        content: queryResult(),
        isError: false,
      });
      assert.equal(signal.reviewTrigger, null);
    }
    ledger.recordResult({ toolName: "update_plan", args: {}, content: queryResult(), isError: false });
  }
}

{
  const ledger = new AnalysisEfficiencyLedger();
  let trigger = null;
  for (let index = 0; index < FAILURE_REVIEW_THRESHOLD; index += 1) {
    trigger = ledger.recordResult({
      toolName: "run_query",
      args: { language: "sql", query: `SELECT * FROM missing_${index}` },
      content: queryResult(0),
      isError: false,
    }).reviewTrigger ?? trigger;
  }
  assert.equal(trigger, "failure_cluster");
}

{
  const ledger = new AnalysisEfficiencyLedger();
  for (let index = 0; index < FAILURE_REVIEW_THRESHOLD - 1; index += 1) {
    ledger.recordResult({
      toolName: "run_query",
      args: { language: "sql", query: `SELECT * FROM empty_before_progress_${index}` },
      content: queryResult(0),
      isError: false,
    });
  }
  ledger.recordResult({ toolName: "update_plan", args: {}, content: queryResult(), isError: false });
  const signal = ledger.recordResult({
    toolName: "run_query",
    args: { language: "sql", query: "SELECT * FROM empty_after_progress" },
    content: queryResult(0),
    isError: false,
  });
  assert.equal(signal.reviewTrigger, null);
}

{
  const ledger = new AnalysisEfficiencyLedger({ advisoriesEnabled: false });
  let latest = ledger.metrics();
  for (let index = 1; index <= QUERY_FAMILY_REVIEW_THRESHOLD; index += 1) {
    ledger.recordResult({
      toolName: "run_query",
      args: { language: "sql", query: `SELECT * FROM disabled_items WHERE id = ${index}` },
      content: queryResult(),
      isError: false,
    });
    latest = ledger.metrics();
  }
  assert.equal(latest.queryFamilyPeak, QUERY_FAMILY_REVIEW_THRESHOLD);
  assert.equal(latest.strategyHints, 0);
  assert.equal(latest.reviewTriggered, false);
}

assert.deepEqual(
  parseStrategyReview(JSON.stringify({
    assessment: "change",
    diagnosis: "The agent is probing one id at a time.",
    nextActions: ["Fetch the full filtered set once.", "Join it with DuckDB."],
    avoid: "More single-id queries.",
    successCondition: "One exact aggregate result.",
  })),
  {
    assessment: "change",
    diagnosis: "The agent is probing one id at a time.",
    nextActions: ["Fetch the full filtered set once.", "Join it with DuckDB."],
    avoid: "More single-id queries.",
    successCondition: "One exact aggregate result.",
  },
);

assert.throws(() => parseStrategyReview("{}"));

const reviewMessage = {
  role: "assistant",
  content: [{
    type: "text",
    text: JSON.stringify({
      assessment: "change",
      diagnosis: "The current probes repeat one query family.",
      nextActions: ["Fetch the complete filtered set once.", "Finish the aggregation in Python."],
      avoid: "More literal-only query variants.",
      successCondition: "One validated aggregate answer.",
    }),
  }],
  stopReason: "stop",
  usage: {
    input: 100,
    output: 50,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 150,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  timestamp: Date.now(),
} as unknown as AssistantMessage;

const baseReview = {
  runId: "run-1",
  goal: "Calculate the exact result.",
  plan: "Inspect, query, validate.",
  capabilities: "run_query, execute_python",
  trigger: "query_churn" as const,
  metrics: new AnalysisEfficiencyLedger().metrics(),
  observations: [],
};

{
  let receivedOptions: unknown;
  const models = {
    completeSimple: async (_model: Model, _context: unknown, options: unknown) => {
      receivedOptions = options;
      return reviewMessage;
    },
  } as unknown as Models;
  const result = await runStrategyReview({
    models,
    model: {} as Model,
    signal: new AbortController().signal,
    sessionId: "strategy:run-1",
    review: baseReview,
  });
  assert.equal(result.checkpoint.advice.assessment, "change");
  assert.equal(result.checkpoint.runId, "run-1");
  assert.deepEqual(receivedOptions, {
    signal: receivedOptions && (receivedOptions as { signal: AbortSignal }).signal,
    temperature: 0.1,
    maxTokens: 500,
    cacheRetention: "short",
    sessionId: "strategy:run-1",
  });
}

{
  const models = {
    completeSimple: async () => ({
      ...reviewMessage,
      stopReason: "error",
      errorMessage: "review unavailable",
    }),
  } as unknown as Models;
  await assert.rejects(
    runStrategyReview({
      models,
      model: {} as Model,
      signal: new AbortController().signal,
      sessionId: "strategy:run-1",
      review: baseReview,
    }),
    /review unavailable/,
  );
}

console.log("analysis-efficiency tests passed");
