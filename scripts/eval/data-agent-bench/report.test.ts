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
    hints: true,
    startedAt: "2026-08-16T00:00:00.000Z",
    elapsedMs: valid ? 1_000 : 2_000,
    firstResultMs: 200,
    modelTurns: valid ? 2 : 3,
    toolCalls: valid ? 1 : 2,
    toolCallCounts: { run_sql: valid ? 1 : 2 },
    capabilityFailures: valid ? {} : { unsupported_mongodb: 1 },
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

try {
  await writeRun("demo", 1, true);
  await writeRun("mongo_demo", 2, false);
  await fs.writeFile(path.join(input, "summary.json"), JSON.stringify({ generatedAt: "2026-08-16T00:00:00.000Z" }));
  await fs.writeFile(path.join(input, "manifest.json"), JSON.stringify({ model: "mock-model" }));

  const report = await buildDataAgentBenchReport(input);
  assert.equal(report.totals.cases, 2);
  assert.equal(report.totals.valid, 1);
  assert.equal(report.totals.cacheHitRate, 0.875);
  assert.equal(report.cases[0]?.question, "Question 1?");
  assert.equal(report.cases[1]?.failureCategory, "mongodb_unavailable");
  assert.equal(report.cases[1]?.trace[1]?.toolName, "run_sql");
  assert.equal(report.failureCategories[0]?.count, 1);

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
  for (const run of history.runs) {
    const stat = await fs.stat(path.join(historyOutput, run.dataFile));
    assert.ok(stat.size > 0, `${run.dataFile} must be generated`);
  }
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log("data-agent-bench report tests passed.");
