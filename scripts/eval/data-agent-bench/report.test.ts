import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildDataAgentBenchReport,
  writeDataAgentBenchHistory,
  writeDataAgentBenchReport,
} from "../build-data-agent-bench-report";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "stela-dab-report-"));
const input = path.join(root, "results");
const output = path.join(root, "report");
const historyOutput = path.join(root, "history-report");

async function writeRun(dataset: string, query: number, valid: boolean): Promise<void> {
  const directory = path.join(input, `query_${dataset}`, `query${query}`, "run_0");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "final_agent.json"), JSON.stringify({
    complete: true,
    dataset,
    query: String(query),
    run: 0,
    answer: valid ? "42" : "I cannot query MongoDB.",
    valid,
    validation: {
      reason: valid ? "Ground truth found in LLM output." : "No matching number found in LLM output.",
      ground_truth: "42",
    },
    terminateReason: "final_answer",
    error: null,
    model: "mock-model",
    requestedReasoningEffort: "high",
    effectiveReasoningEffort: "medium",
    hints: true,
    startedAt: "2026-08-16T00:00:00.000Z",
    elapsedMs: valid ? 1_000 : 2_000,
    firstResultMs: 200,
    modelTurns: valid ? 2 : 3,
    toolCalls: valid ? 1 : 2,
    toolCallCounts: { run_sql: valid ? 1 : 2 },
    capabilityFailures: valid ? {} : { unsupported_mongodb: 1 },
    efficiency: valid ? {
      queryFamilyPeak: 8,
      strategyHints: 1,
      reviewTriggered: true,
      reviewTrigger: "query_family_fanout",
      runQueryCallsAtReview: 8,
      postReviewRunQueryCalls: 2,
      reviewStatus: "completed",
    } : undefined,
    resultReview: valid ? {
      status: "accepted",
      reviews: 1,
      revisions: 0,
      diagnosis: "Evidence matches the scalar answer.",
    } : {
      status: "structural_failed",
      reviews: 0,
      revisions: 0,
      diagnosis: "Evidence was missing.",
    },
    usage: {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 70,
      cacheWriteTokens: 0,
      cacheHitRate: 0.7,
    },
    transcript: [
      {
        role: "user",
        content: [{
          type: "text",
          text: `<user_request>\n${JSON.stringify({ version: 1, segments: [{ kind: "text", text: `DESCRIPTION\nQUERY:\nQuestion ${query}?` }] })}\n</user_request>`,
        }],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Inspect the database." },
          { type: "toolCall", name: "run_sql", arguments: { sql: "SELECT 1" } },
        ],
        usage: { input: 10, output: 20, cacheRead: 70 },
      },
      {
        role: "toolResult",
        toolName: "run_sql",
        content: [{ type: "text", text: valid ? "[[42]]" : "unsupported_mongodb" }],
        isError: !valid,
      },
    ],
  }), "utf-8");
}

async function writeRoutingRun(
  routingInput: string,
  dataset: string,
  capabilityFailures: Record<string, number>,
  results: Array<{ text: string; isError: boolean }>,
): Promise<void> {
  const directory = path.join(routingInput, `query_${dataset}`, "query1", "run_0");
  await fs.mkdir(directory, { recursive: true });
  const transcript: Array<Record<string, unknown>> = [{
    role: "user",
    content: [{ type: "text", text: "QUERY:\nReturn the requested value." }],
  }];
  for (const [index, result] of results.entries()) {
    transcript.push({
      role: "assistant",
      content: [{
        type: "toolCall",
        name: "run_query",
        arguments: { language: "sql", database: index === 0 ? "wrong" : "correct", query: "SELECT 1" },
      }],
    });
    transcript.push({
      role: "toolResult",
      toolName: "run_query",
      content: [{ type: "text", text: result.text }],
      isError: result.isError,
    });
  }
  transcript.push({ role: "assistant", content: [{ type: "text", text: "41" }] });
  await fs.writeFile(path.join(directory, "final_agent.json"), JSON.stringify({
    complete: true,
    dataset,
    query: "1",
    run: 0,
    answer: "41",
    valid: false,
    validation: {
      reason: "No matching number found in LLM output.",
      ground_truth: "42",
    },
    terminateReason: "final_answer",
    error: null,
    model: "mock-model",
    hints: false,
    startedAt: "2026-08-16T00:00:00.000Z",
    elapsedMs: 1_000,
    firstResultMs: 100,
    modelTurns: results.length + 1,
    toolCalls: results.length,
    toolCallCounts: { run_query: results.length },
    capabilityFailures,
    usage: {
      inputTokens: 10,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheHitRate: 0,
    },
    transcript,
  }), "utf-8");
}

try {
  await writeRun("demo", 1, true);
  await writeRun("mongo_demo", 2, false);
  await fs.writeFile(path.join(input, "summary.json"), JSON.stringify({ generatedAt: "2026-08-16T00:00:00.000Z" }));
  await fs.writeFile(path.join(input, "manifest.json"), JSON.stringify({
    model: "mock-model",
    requestedReasoningEffort: "high",
    effectiveReasoningEffort: "medium",
  }));
  await fs.writeFile(path.join(input, "analysis-notes.json"), JSON.stringify({
    schemaVersion: 1,
    status: "complete",
    title: "Mock run analysis",
    summary: "The mock run establishes the report contract.",
    headlineMetrics: [{ label: "Strict score", value: "1 / 2", note: "Fixture only" }],
    findings: [{
      title: "One deterministic failure",
      evidence: ["mongo_demo/query2/run_0 failed."],
      interpretation: "The report must keep evidence separate from interpretation.",
    }],
    comparability: ["Both cases use the same mock model."],
    limitations: ["This is a fixture."],
    nextSteps: ["Keep the narrative attached to the run."],
  }));

  const report = await buildDataAgentBenchReport(input);
  assert.equal(report.totals.cases, 2);
  assert.equal(report.totals.valid, 1);
  assert.equal(report.totals.cacheHitRate, 0.875);
  assert.equal(report.totals.strategyReviewsTriggered, 1);
  assert.equal(report.totals.strategyReviewsCompleted, 1);
  assert.equal(report.totals.queryFamilyPeak, 8);
  assert.equal(report.totals.resultReviewsAccepted, 1);
  assert.equal(report.totals.resultReviewsStructuralFailed, 1);
  assert.equal(report.cases[0]?.question, "Question 1?");
  assert.equal(report.cases[0]?.requestedReasoningEffort, "high");
  assert.equal(report.cases[0]?.effectiveReasoningEffort, "medium");
  assert.equal(report.cases[1]?.failureCategory, "mongodb_unavailable");
  assert.equal(report.cases[1]?.efficiency.reviewStatus, "not_triggered");
  assert.equal(report.cases[1]?.trace[1]?.toolName, "run_sql");
  assert.equal(report.failureCategories[0]?.count, 1);
  assert.equal(report.analysis?.title, "Mock run analysis");
  assert.equal(report.analysis?.findings[0]?.evidence[0], "mongo_demo/query2/run_0 failed.");
  const runSqlStats = report.toolStats.find((item) => item.tool === "run_sql");
  assert.equal(runSqlStats?.calls, 3);
  assert.equal(runSqlStats?.successCalls, 1);
  assert.equal(runSqlStats?.runtimeErrorCalls, 2);
  assert.equal(runSqlStats?.passedCaseCalls, 1);
  assert.equal(runSqlStats?.failedCaseCalls, 2);

  const routingInput = path.join(root, "routing-results");
  await writeRoutingRun(
    routingInput,
    "route_recovered",
    { unknown_database: 1 },
    [
      { text: JSON.stringify({ code: "unknown_database", message: "Unknown logical database 'wrong'." }), isError: true },
      { text: JSON.stringify({ columns: ["value"], rows: [[41]] }), isError: false },
    ],
  );
  await writeRoutingRun(
    routingInput,
    "route_unresolved",
    { missing_database_route: 1 },
    [{ text: JSON.stringify({ code: "missing_database_route" }), isError: true }],
  );
  await writeRoutingRun(
    routingInput,
    "language_unresolved",
    { query_language_mismatch: 1 },
    [{ text: JSON.stringify({ code: "query_language_mismatch" }), isError: true }],
  );
  await writeRoutingRun(
    routingInput,
    "legacy_indeterminate",
    { unknown_database: 1 },
    [{ text: JSON.stringify({ columns: ["value"], rows: [[41]] }), isError: false }],
  );
  const routingReport = await buildDataAgentBenchReport(routingInput);
  const recovered = routingReport.cases.find((item) => item.dataset === "route_recovered");
  assert.equal(recovered?.routing.status, "recovered");
  assert.equal(recovered?.routing.recoveredBy, "run_query");
  assert.equal(recovered?.failureCategory, "wrong_answer");
  const unresolved = routingReport.cases.find((item) => item.dataset === "route_unresolved");
  assert.equal(unresolved?.routing.status, "unresolved");
  assert.equal(unresolved?.failureCategory, "routing_error");
  const language = routingReport.cases.find((item) => item.dataset === "language_unresolved");
  assert.equal(language?.routing.status, "unresolved");
  assert.equal(language?.failureCategory, "query_language_mismatch");
  const legacy = routingReport.cases.find((item) => item.dataset === "legacy_indeterminate");
  assert.equal(legacy?.routing.status, "indeterminate");
  assert.equal(legacy?.failureCategory, "wrong_answer");
  assert.deepEqual(
    Object.fromEntries(routingReport.failureCategories.map((item) => [item.category, item.count])),
    { wrong_answer: 2, query_language_mismatch: 1, routing_error: 1 },
  );

  // A staged-source Python failure must be classified on its error head: the stdout banner
  // names `tables[alias]` and `pandas DataFrame`, which used to read as a contract rejection.
  const pythonInput = path.join(root, "python-results");
  const pythonDirectory = path.join(pythonInput, "query_py_demo", "query1", "run_0");
  await fs.mkdir(pythonDirectory, { recursive: true });
  await fs.writeFile(path.join(pythonDirectory, "final_agent.json"), JSON.stringify({
    complete: true,
    dataset: "py_demo",
    query: "1",
    run: 0,
    answer: "41",
    valid: false,
    validation: { reason: "No matching number found in LLM output.", ground_truth: "42" },
    terminateReason: "final_answer",
    error: null,
    model: "mock-model",
    hints: false,
    startedAt: "2026-09-03T00:00:00.000Z",
    elapsedMs: 1_000,
    firstResultMs: 100,
    modelTurns: 2,
    toolCalls: 2,
    toolCallCounts: { execute_python: 2 },
    capabilityFailures: {},
    usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, cacheHitRate: 0 },
    transcript: [
      { role: "user", content: [{ type: "text", text: "QUERY:\nReturn the requested value." }] },
      {
        role: "assistant",
        content: [{ type: "toolCall", name: "execute_python", arguments: { code: "result = df" } }],
      },
      {
        role: "toolResult",
        toolName: "execute_python",
        content: [{
          type: "text",
          text: "NameError: name 'df' is not defined\nstdout:\n"
            + "[INPUTS] tables[alias] is a DuckDB relation; to_df(alias) gives a pandas DataFrame.\n"
            + "  rows: 30 rows x 2 cols | _id:VARCHAR, content:VARCHAR\n",
        }],
        isError: true,
      },
      {
        role: "assistant",
        content: [{ type: "toolCall", name: "execute_python", arguments: { sources: [{ alias: "rows", language: "sql", query: "SELECT 1", limit: 5 }] } }],
      },
      {
        role: "toolResult",
        toolName: "execute_python",
        content: [{
          type: "text",
          text: "sources[0] (rows): sql source does not accept 'limit'."
            + " Put LIMIT inside the SQL query; nothing was executed.",
        }],
        isError: true,
      },
      { role: "assistant", content: [{ type: "text", text: "41" }] },
    ],
  }), "utf-8");
  const pythonReport = await buildDataAgentBenchReport(pythonInput);
  const pythonStats = pythonReport.toolStats.find((item) => item.tool === "execute_python");
  assert.equal(pythonStats?.runtimeErrorCalls, 1);
  assert.equal(pythonStats?.rejectedCalls, 1);
  assert.deepEqual(
    Object.fromEntries(pythonStats!.errorCauses.map((item) => [item.category, item.count])),
    { python_runtime: 1, python_contract: 1 },
  );

  await writeDataAgentBenchReport(input, output);
  for (const name of ["index.html", "styles.css", "app.js", "analysis-data.json"]) {
    const stat = await fs.stat(path.join(output, name));
    assert.ok(stat.size > 0, `${name} must be generated`);
  }

  const newerInput = path.join(root, "results-v2");
  await fs.cp(input, newerInput, { recursive: true });
  await fs.writeFile(
    path.join(newerInput, "summary.json"),
    JSON.stringify({ generatedAt: "2026-08-17T00:00:00.000Z" }),
  );
  const newerRun = path.join(newerInput, "query_mongo_demo", "query2", "run_0", "final_agent.json");
  const newer = JSON.parse(await fs.readFile(newerRun, "utf-8")) as Record<string, unknown>;
  newer.valid = true;
  newer.answer = "42";
  newer.capabilityFailures = {};
  await fs.writeFile(newerRun, JSON.stringify(newer), "utf-8");

  const history = await writeDataAgentBenchHistory([input, newerInput], historyOutput);
  assert.equal(history.runs.length, 2);
  assert.equal(history.defaultRunId, "results-v2");
  assert.equal(history.defaultComparisonRunId, "results");
  assert.equal(history.runs[0]?.totals.valid, 2);
  for (const name of ["index.html", "styles.css", "app.js", "history.json"]) {
    const stat = await fs.stat(path.join(historyOutput, name));
    assert.ok(stat.size > 0, `${name} must be generated in history mode`);
  }
  const historyApp = await fs.readFile(path.join(historyOutput, "app.js"), "utf-8");
  assert.match(historyApp, /comparisonData\?\.toolStats/);
  assert.match(historyApp, /\/ case · 对照/);
  assert.match(historyApp, /function comparisonPairs\(\)/);
  assert.match(historyApp, /个共同 case/);
  assert.match(historyApp, /部分结果/);
  assert.match(historyApp, /工具成功率/);
  assert.match(historyApp, /案例相关/);
  assert.match(historyApp, /function renderRunAnalysis\(\)/);
  assert.match(historyApp, /cache: "no-store"/);
  assert.doesNotMatch(historyApp, /\$\{item\.passCalls\} pass/);
  for (const run of history.runs) {
    const stat = await fs.stat(path.join(historyOutput, run.dataFile));
    assert.ok(stat.size > 0, `${run.dataFile} must be generated`);
  }
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log("data-agent-bench report tests passed.");
