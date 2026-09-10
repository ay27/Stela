import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readCompleted } from "../run-data-agent-bench";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "stela-dab-runner-"));
const dabRoot = path.join(root, "dab");
const output = path.join(root, "output");
const write = async (relative: string, content: string): Promise<void> => {
  const target = path.join(dabRoot, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf-8");
};

let modelCalls = 0;
let failFinalRequests = false;
const modelRequests: Array<{
  messages?: Array<{ role?: string; content?: unknown; tool_calls?: unknown[] }>;
  reasoning_effort?: string;
}> = [];

const server = http.createServer(async (request, response) => {
  let requestBody = "";
  for await (const chunk of request) requestBody += String(chunk);
  const modelRequest = JSON.parse(requestBody) as (typeof modelRequests)[number];
  modelRequests.push(modelRequest);
  modelCalls += 1;
  const isSalvage = requestBody.includes("The analysis stopped before verified completion");
  const previousToolRounds = (modelRequest.messages ?? []).filter((message) =>
    message.role === "assistant" && (message.tool_calls?.length ?? 0) > 0).length;
  if (failFinalRequests && previousToolRounds >= 2 && !isSalvage) {
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "temporarily unavailable", type: "server_error" } }));
    return;
  }
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const delta = isSalvage
    ? { role: "assistant", content: "Best effort from the evidence gathered so far.\none" }
    : previousToolRounds === 0
    ? {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call_stela_dab_plan",
            type: "function",
            function: {
              name: "plan",
              arguments: JSON.stringify({
                action: "create",
                steps: [{
                  id: "answer",
                  title: "Find the answer",
                  intent: "Inspect the available database.",
                  acceptance: "The answer is known.",
                }],
              }),
            },
          },
          {
            index: 1,
            id: "call_stela_dab_list",
            type: "function",
            function: { name: "list_catalog", arguments: JSON.stringify({ level: "databases" }) },
          },
        ],
      }
    : previousToolRounds === 1
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_stela_dab_query",
              type: "function",
              function: {
                name: "run_query",
                arguments: JSON.stringify({
                  language: "sql",
                  database: "demo_database",
                  query: "SELECT value FROM demo_table",
                }),
              },
            },
            {
              index: 1,
              id: "call_stela_dab_complete",
              type: "function",
              function: {
                  name: "plan",
                  arguments: JSON.stringify({
                    action: "update",
                    stepId: "answer",
                  status: "completed",
                  evidence: "The query returned the requested scalar.",
                }),
              },
            },
          ],
        }
      : { role: "assistant", content: "one" };
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-stela-dab-test",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "mock-model",
    choices: [{ index: 0, delta, finish_reason: null }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-stela-dab-test",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "mock-model",
    choices: [{ index: 0, delta: {}, finish_reason: !isSalvage && previousToolRounds < 2 ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101 },
  })}\n\n`);
  response.end("data: [DONE]\n\n");
});

try {
  await write("common_scaffold/__init__.py", "");
  await write("common_scaffold/tools/__init__.py", "");
  await write("common_scaffold/validate/__init__.py", "");
  await write("common_scaffold/tools/QueryDBTool.py", `
from pathlib import Path
class QueryDBTool:
    def __init__(self, **kwargs):
        self.db_clients = {"demo_database": {"db_type": "sqlite"}}
        self.event_path = Path(kwargs["log_path"]).parent / "fixture-events.log"
        self.event_path.parent.mkdir(parents=True, exist_ok=True)
        with self.event_path.open("a") as handle:
            handle.write(f"init:{kwargs.get('check_load')}\\n")
    def exec(self, args): return {"success": True, "result": [{"value": 1}]}
    def clean_up(self):
        with self.event_path.open("a") as handle:
            handle.write("cleanup\\n")
`);
  await write("common_scaffold/tools/ListDBTool.py", `
class ListDBTool:
    def __init__(self, **kwargs): pass
    def exec(self, args): return {"success": True, "result": ["demo_table"]}
`);
  await write("common_scaffold/validate/validate.py", `
def validate(query_dir, llm_answer, reason=None):
    return {"is_valid": "one" in llm_answer, "reason": reason, "llm_answer": llm_answer}
`);
  await write("query_demo/db_config.yaml", [
    "db_clients:",
    "  fixture_database:",
    "    db_type: mongo",
    "    db_name: demo_fixture",
    "",
  ].join("\n"));
  await write("query_demo/db_description.txt", "demo_database contains demo_table(value int)\n");
  await write("query_demo/db_description_withhint.txt", "The answer is available from demo_table.\n");
  await write("query_demo/query1/query.json", '"Return one"\n');
  await write("query_demo/query1/validate.py", "def validate(x): return True, 'OK'\n");
  await write("query_demo/query2/query.json", '"Return one again"\n');
  await write("query_demo/query2/validate.py", "def validate(x): return True, 'OK'\n");

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const runBenchmark = async (
    outputDir: string,
    extraArgs: string[] = [],
    runs = 1,
    selectionArgs = ["--dataset", "demo", "--query-id", "1"],
  ): Promise<void> => {
    modelCalls = 0;
    const child = spawn(
      path.join(repoRoot, "node_modules", ".bin", "tsx"),
      [
        path.join(repoRoot, "scripts", "eval", "run-data-agent-bench.ts"),
        "--dab-root", dabRoot,
        ...selectionArgs,
        "--runs", String(runs),
        "--output", outputDir,
        "--python", "python3",
        "--concurrency", "2",
        "--no-python",
        "--bridge-timeout-ms", "10000",
        ...extraArgs,
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          STELA_EVAL_API_KEY: "test-key",
          STELA_EVAL_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
          STELA_EVAL_MODEL: "mock-model",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const exitCode = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    assert.equal(exitCode, 0, `${stdout}\n${stderr}`);
  };
  await runBenchmark(output);
  const finalPath = path.join(output, "query_demo", "query1", "run_0", "final_agent.json");
  const final = JSON.parse(await fs.readFile(finalPath, "utf-8")) as {
    answer: string;
    valid: boolean;
    toolCalls: number;
    error: string | null;
    efficiency: { reviewTriggered: boolean };
    terminateReason: string;
    requestedReasoningEffort: string;
    effectiveReasoningEffort: string;
  };
  const toolLog = await fs.readFile(
    path.join(output, "query_demo", "query1", "run_0", "tool_calls.jsonl"),
    "utf-8",
  );
  assert.equal(final.answer, "one");
  assert.equal(final.valid, true);
  assert.equal(final.toolCalls, 4);
  assert.equal(final.error, null, toolLog);
  assert.equal(final.efficiency.reviewTriggered, false);
  assert.equal(final.requestedReasoningEffort, "medium");
  assert.equal(final.effectiveReasoningEffort, "medium");
  assert.ok(await readCompleted(finalPath, "medium", "medium"));
  assert.equal(await readCompleted(finalPath, "off", "off"), null);
  // Planning is bookkeeping only, so a completed run spends no extra model call on it.
  assert.equal(modelCalls, 3);
  assert.equal(final.terminateReason, "final_answer");
  assert.ok(modelRequests.every((request) => request.reasoning_effort === "medium"));
  const followUpMessages = modelRequests[1]?.messages ?? [];
  const toolRequestIndex = followUpMessages.findIndex((message) =>
    message.role === "assistant" && message.tool_calls?.length === 2
  );
  assert.ok(toolRequestIndex >= 0, "parallel assistant tool_calls must reach the provider");
  assert.deepEqual(
    followUpMessages.slice(toolRequestIndex + 1, toolRequestIndex + 3).map((message) => message.role),
    ["tool", "tool"],
    "all tool results must immediately follow their assistant tool_calls",
  );
  const planSnapshotIndex = followUpMessages.findIndex((message, index) =>
    index > toolRequestIndex && message.role === "user" && String(message.content).includes("Execution plan snapshot")
  );
  assert.ok(planSnapshotIndex > toolRequestIndex + 2, "plan snapshot must follow the complete tool-result batch");
  assert.doesNotMatch(toolLog, /finalize_analysis|revise_plan|salvage_start/);
  assert.equal(
    await fs.readFile(path.join(output, ".fixtures", "demo", "fixture-events.log"), "utf-8"),
    "init:True\ncleanup\n",
  );
  assert.equal(
    await fs.readFile(path.join(output, "query_demo", "query1", "run_0", "fixture-events.log"), "utf-8"),
    "init:False\n",
  );
  const schedulerEvents = (await fs.readFile(path.join(output, "scheduler.jsonl"), "utf-8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string; activeMongoJobs?: number });
  assert.ok(schedulerEvents.some((event) => event.type === "fixture_prepare_end"));
  assert.ok(schedulerEvents.some((event) => event.type === "fixture_cleanup_end"));
  assert.ok(schedulerEvents.some((event) => event.type === "job_start" && event.activeMongoJobs === 1));
  const summary = JSON.parse(await fs.readFile(path.join(output, "summary.json"), "utf-8")) as { validRate: number };
  assert.equal(summary.validRate, 1);
  const manifest = JSON.parse(await fs.readFile(path.join(output, "manifest.json"), "utf-8")) as {
    concurrency: number;
    mongoConcurrency: number;
    mongoFixtureMode: string;
    bridgeTimeoutMs: number;
    strategyReview: boolean;
    salvageMs: number;
    runtimeConditions: { semanticOptimization: boolean; analysisContracts: boolean };
  };
  assert.equal(manifest.concurrency, 2);
  assert.equal(manifest.mongoConcurrency, 2);
  assert.equal(manifest.mongoFixtureMode, "shared");
  assert.equal(manifest.bridgeTimeoutMs, 10_000);
  assert.equal(manifest.strategyReview, true);
  assert.equal(manifest.salvageMs, 120_000);
  assert.equal(manifest.runtimeConditions.semanticOptimization, false);
  assert.equal(manifest.runtimeConditions.analysisContracts, false);
  const experimentOutput = path.join(root, "experiments-output");
  await runBenchmark(experimentOutput, ["--semantic-optimization", "--analysis-contracts"]);
  const experimentManifest = JSON.parse(await fs.readFile(path.join(experimentOutput, "manifest.json"), "utf8"));
  assert.equal(experimentManifest.runtimeConditions.semanticOptimization, true);
  assert.equal(experimentManifest.runtimeConditions.analysisContracts, true);

  const failedFrom = path.join(root, "previous-results");
  const failedFinal = path.join(failedFrom, "query_demo", "query1", "run_0", "final_agent.json");
  await fs.mkdir(path.dirname(failedFinal), { recursive: true });
  await fs.writeFile(failedFinal, JSON.stringify({ complete: true, valid: false }), "utf-8");
  const passedFinal = path.join(failedFrom, "query_demo", "query2", "run_0", "final_agent.json");
  await fs.mkdir(path.dirname(passedFinal), { recursive: true });
  await fs.writeFile(passedFinal, JSON.stringify({ complete: true, valid: true }), "utf-8");
  const failedOutput = path.join(root, "failed-output");
  await runBenchmark(failedOutput, [], 1, ["--failed-from", failedFrom]);
  assert.equal(
    JSON.parse(await fs.readFile(
      path.join(failedOutput, "query_demo", "query1", "run_0", "final_agent.json"),
      "utf-8",
    )).valid,
    true,
  );
  await assert.rejects(
    fs.access(path.join(failedOutput, "query_demo", "query2", "run_0", "final_agent.json")),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
  const failedManifest = JSON.parse(
    await fs.readFile(path.join(failedOutput, "manifest.json"), "utf-8"),
  ) as { selection: { mode: string; source: string; cases: Array<{ dataset: string; queryId: number }> } };
  assert.equal(failedManifest.selection.mode, "failed_from");
  assert.equal(failedManifest.selection.source, failedFrom);
  assert.deepEqual(failedManifest.selection.cases, [{ dataset: "demo", queryId: 1 }]);

  const concurrentOutput = path.join(root, "results-shared-concurrent");
  await runBenchmark(concurrentOutput, [], 2);
  assert.equal(modelCalls, 6);
  assert.equal(
    await fs.readFile(path.join(concurrentOutput, ".fixtures", "demo", "fixture-events.log"), "utf-8"),
    "init:True\ncleanup\n",
    "two concurrent cases must share one owned fixture",
  );
  for (const runNumber of [0, 1]) {
    assert.equal(
      await fs.readFile(
        path.join(concurrentOutput, "query_demo", "query1", `run_${runNumber}`, "fixture-events.log"),
        "utf-8",
      ),
      "init:False\n",
    );
  }
  const concurrentEvents = (await fs.readFile(path.join(concurrentOutput, "scheduler.jsonl"), "utf-8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string; activeMongoJobs?: number });
  assert.ok(concurrentEvents.some((event) => event.type === "job_start" && event.activeMongoJobs === 2));

  const perRunOutput = path.join(root, "results-per-run-fixture");
  await runBenchmark(perRunOutput, ["--mongo-fixture-mode", "per-run"], 2);
  for (const runNumber of [0, 1]) {
    assert.equal(
      await fs.readFile(
        path.join(perRunOutput, "query_demo", "query1", `run_${runNumber}`, "fixture-events.log"),
        "utf-8",
      ),
      "init:True\ncleanup\n",
    );
  }
  const perRunEvents = (await fs.readFile(path.join(perRunOutput, "scheduler.jsonl"), "utf-8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string; activeMongoJobs?: number });
  assert.ok(perRunEvents.every((event) =>
    event.type !== "job_start" || (event.activeMongoJobs ?? 0) <= 1));
  await assert.rejects(fs.stat(path.join(perRunOutput, ".fixtures")), { code: "ENOENT" });

  // A cap before any committed query/Python evidence must not manufacture a closeout.
  const emptyCapOutput = path.join(root, "results-empty-tool-cap");
  await runBenchmark(emptyCapOutput, ["--max-tool-calls", "1"]);
  const emptyCap = JSON.parse(await fs.readFile(path.join(emptyCapOutput, "query_demo/query1/run_0/final_agent.json"), "utf-8"));
  assert.equal(emptyCap.answer, "");
  assert.equal(emptyCap.closeout.status, "skipped");
  assert.equal(emptyCap.executionFailure, "tool_call_cap");

  // Once evidence exists, delivery may recover but execution failure remains recorded.
  const cappedOutput = path.join(root, "results-tool-cap");
  await runBenchmark(cappedOutput, ["--max-tool-calls", "3"]);
  const cappedDir = path.join(cappedOutput, "query_demo", "query1", "run_0");
  const capped = JSON.parse(await fs.readFile(path.join(cappedDir, "final_agent.json"), "utf-8")) as {
    answer: string;
    valid: boolean;
    terminateReason: string;
    error: string | null;
  };
  const cappedLog = await fs.readFile(path.join(cappedDir, "tool_calls.jsonl"), "utf-8");
  assert.equal(capped.terminateReason, "tool_call_cap_salvaged", cappedLog);
  assert.equal(capped.error, "tool_call_cap", "successful delivery must not erase execution failure");
  assert.equal(capped.valid, true);
  assert.match(capped.answer, /Best effort/);
  assert.match(cappedLog, /"type":"salvage_start"/);

  // Provider failure without forcedStop follows the same closeout policy.
  failFinalRequests = true;
  const providerFailedOutput = path.join(root, "results-provider-failure");
  await runBenchmark(providerFailedOutput);
  failFinalRequests = false;
  const failedDir = path.join(providerFailedOutput, "query_demo/query1/run_0");
  const failed = JSON.parse(await fs.readFile(path.join(failedDir, "final_agent.json"), "utf-8"));
  assert.equal(failed.terminateReason, "generation_error_salvaged", JSON.stringify({ error: failed.error, closeout: failed.closeout }));
  assert.equal(failed.closeout.status, "completed");
  assert.match(failed.executionFailure, /temporarily unavailable/);
  assert.equal(failed.error, failed.executionFailure);
  const failedEvents = (await fs.readFile(path.join(failedDir, "tool_calls.jsonl"), "utf-8")).trim().split("\n")
    .map(line => JSON.parse(line) as { type: string; name?: string; phase?: string; status?: number });
  assert.equal(failedEvents.filter(e => e.type === "tool_execution_start" && e.name === "run_query").length, 1);
  assert.equal(failedEvents.filter(e => e.type === "generation_attempt" && e.status === 503).length, 3);
  assert.equal(failedEvents.filter(e => e.type === "generation_attempt" && e.phase === "closeout").length, 1);
} finally {
  server.close();
  await fs.rm(root, { recursive: true, force: true });
}

console.log("data-agent-bench runner integration tests passed.");
