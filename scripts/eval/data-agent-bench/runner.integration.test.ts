import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const modelRequests: Array<{ messages?: Array<{ role?: string; content?: unknown; tool_calls?: unknown[] }> }> = [];
const server = http.createServer(async (request, response) => {
  let requestBody = "";
  for await (const chunk of request) requestBody += String(chunk);
  modelRequests.push(JSON.parse(requestBody) as (typeof modelRequests)[number]);
  modelCalls += 1;
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const delta = modelCalls === 1
    ? {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call_stela_dab_plan",
            type: "function",
            function: {
              name: "create_plan",
              arguments: JSON.stringify({
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
            function: { name: "list_databases", arguments: "{}" },
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
    choices: [{ index: 0, delta: {}, finish_reason: modelCalls === 1 ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101 },
  })}\n\n`);
  response.end("data: [DONE]\n\n");
});

try {
  await write("common_scaffold/__init__.py", "");
  await write("common_scaffold/tools/__init__.py", "");
  await write("common_scaffold/validate/__init__.py", "");
  await write("common_scaffold/tools/QueryDBTool.py", `
class QueryDBTool:
    def __init__(self, **kwargs): self.db_clients = {"demo_database": {"db_type": "sqlite"}}
    def exec(self, args): return {"success": True, "result": [{"value": 1}]}
    def clean_up(self): pass
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
  await write("query_demo/db_config.yaml", "db_clients: {}\n");
  await write("query_demo/db_description.txt", "demo_database contains demo_table(value int)\n");
  await write("query_demo/db_description_withhint.txt", "The answer is available from demo_table.\n");
  await write("query_demo/query1/query.json", '"Return one"\n');
  await write("query_demo/query1/validate.py", "def validate(x): return True, 'OK'\n");

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const child = spawn(
    path.join(repoRoot, "node_modules", ".bin", "tsx"),
    [
      path.join(repoRoot, "scripts", "eval", "run-data-agent-bench.ts"),
      "--dab-root", dabRoot,
      "--dataset", "demo",
      "--query-id", "1",
      "--runs", "1",
      "--output", output,
      "--python", "python3",
      "--concurrency", "2",
      "--no-python",
      "--bridge-timeout-ms", "10000",
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
  const finalPath = path.join(output, "query_demo", "query1", "run_0", "final_agent.json");
  const final = JSON.parse(await fs.readFile(finalPath, "utf-8")) as {
    answer: string;
    valid: boolean;
    toolCalls: number;
    efficiency: { reviewTriggered: boolean };
  };
  assert.equal(final.answer, "one");
  assert.equal(final.valid, true);
  assert.equal(final.toolCalls, 2);
  assert.equal(final.efficiency.reviewTriggered, false);
  assert.equal(modelCalls, 2);
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
  assert.match(
    await fs.readFile(path.join(output, "query_demo", "query1", "run_0", "tool_calls.jsonl"), "utf-8"),
    /list_databases/,
  );
  const summary = JSON.parse(await fs.readFile(path.join(output, "summary.json"), "utf-8")) as { validRate: number };
  assert.equal(summary.validRate, 1);
  const manifest = JSON.parse(await fs.readFile(path.join(output, "manifest.json"), "utf-8")) as {
    concurrency: number;
    bridgeTimeoutMs: number;
    strategyReview: boolean;
  };
  assert.equal(manifest.concurrency, 2);
  assert.equal(manifest.bridgeTimeoutMs, 10_000);
  assert.equal(manifest.strategyReview, true);
} finally {
  server.close();
  await fs.rm(root, { recursive: true, force: true });
}

console.log("data-agent-bench runner integration tests passed.");
