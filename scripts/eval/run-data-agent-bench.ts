/**
 * Product-faithful DataAgentBench runner for Stela's headless Agent core.
 *
 * The Electron shell is intentionally absent. The real prompt, harness,
 * provider transport, SQL guard, schema tools, plan tools, and final-answer
 * behavior run against a DAB-backed virtual connector over JSONL stdio.
 */

import {
  AgentHarness,
  InMemorySessionStorage,
  Session,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import type {
  AgentPlanSnapshot,
  AgentRunRequest,
  AiSettings,
  ConnectionEntry,
  QueryResult,
  RunRecord,
} from "@shared/types";
import {
  assistantText,
  buildSystemPrompt,
  buildUserContent,
} from "../../electron/services/ai/agent-prompt";
import { AGENT_SKILL_LIMITS_PROMPT } from "../../electron/services/ai/agent-skills";
import {
  createAgentTools,
  type ProposalRequest,
} from "../../electron/services/ai/agent-tools";
import {
  createPlanPersistenceBuffer,
  ExecutionPlanStore,
  formatExecutionPlanEntry,
} from "../../electron/services/ai/execution-plan";
import { createTransportForProfile } from "../../electron/services/ai/provider";
import { buildEvalSettings, requireCredentials } from "./env";
import {
  appendJsonl,
  buildDabUserPrompt,
  cacheHitRate,
  DabBridgeClient,
  type DabTask,
  type DabValidation,
  discoverDabTasks,
  endpointHash,
  readDabPrompt,
  safeSlug,
  writeJson,
} from "./data-agent-bench/runtime";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const bridgePath = path.join(here, "data-agent-bench", "bridge.py");
const EXECUTION_PLAN_ENTRY = "execution_plan";

interface CliOptions {
  dabRoot: string;
  output: string | null;
  dataset: string | null;
  queryId: number | null;
  runs: number;
  hints: boolean;
  all: boolean;
  resume: boolean;
  selfCheck: boolean;
  maxModelTurns: number;
  maxToolCalls: number;
  timeoutMs: number;
  condaEnv: string;
  python: string | null;
}

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

interface FinalRun {
  complete: true;
  dataset: string;
  query: string;
  run: number;
  answer: string;
  valid: boolean;
  validation: DabValidation;
  terminateReason: string;
  error: string | null;
  model: string;
  hints: boolean;
  startedAt: string;
  elapsedMs: number;
  firstResultMs: number | null;
  modelTurns: number;
  toolCalls: number;
  toolCallCounts: Record<string, number>;
  capabilityFailures: Record<string, number>;
  usage: UsageTotals & { cacheHitRate: number | null };
  transcript: unknown[];
}

interface GitState {
  commit: string;
  trackedDirty: boolean;
}

function intArg(value: string | undefined, name: string, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) throw new Error(`${name} must be an integer >= ${minimum}.`);
  return parsed;
}

function parseArgs(argv: string[]): CliOptions {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const dabRoot = value("--dab-root") ?? process.env.DAB_ROOT ?? "";
  if (!dabRoot.trim()) throw new Error("Pass --dab-root or set DAB_ROOT.");
  return {
    dabRoot: path.resolve(dabRoot),
    output: value("--output") ? path.resolve(value("--output")!) : null,
    dataset: value("--dataset") ?? null,
    queryId: value("--query-id") ? intArg(value("--query-id"), "--query-id", 1) : null,
    runs: intArg(value("--runs") ?? "1", "--runs", 1),
    hints: !argv.includes("--no-hints"),
    all: argv.includes("--all"),
    resume: argv.includes("--resume"),
    selfCheck: argv.includes("--self-check"),
    maxModelTurns: intArg(value("--max-model-turns") ?? "100", "--max-model-turns", 1),
    maxToolCalls: intArg(value("--max-tool-calls") ?? "200", "--max-tool-calls", 1),
    timeoutMs: intArg(value("--timeout-ms") ?? "1800000", "--timeout-ms", 1000),
    condaEnv: value("--conda-env") ?? "dabench",
    python: value("--python") ?? null,
  };
}

async function gitState(root: string): Promise<GitState> {
  const [commit, status] = await Promise.all([
    execFileAsync("git", ["-C", root, "rev-parse", "HEAD"]).then((result) => result.stdout.trim()).catch(() => "unknown"),
    execFileAsync("git", ["-C", root, "status", "--porcelain", "--untracked-files=no"]).then((result) => result.stdout.trim()).catch(() => "unknown"),
  ]);
  return { commit, trackedDirty: status.length > 0 };
}

function selectTasks(tasks: DabTask[], options: CliOptions): DabTask[] {
  if (options.selfCheck && !options.dataset && !options.queryId && !options.all) {
    const seen = new Set<string>();
    return tasks.filter((task) => {
      if (seen.has(task.dataset)) return false;
      seen.add(task.dataset);
      return true;
    });
  }
  if (!options.all && !options.dataset) {
    throw new Error("Select --all or --dataset [--query-id].");
  }
  const selected = tasks.filter((task) =>
    (options.all || task.dataset === options.dataset) &&
    (options.queryId === null || task.queryId === options.queryId));
  if (selected.length === 0) throw new Error("No matching DAB tasks found.");
  return selected;
}

async function runSelfCheck(tasks: DabTask[], options: CliOptions): Promise<void> {
  console.log(`DAB self-check: ${tasks.length} dataset environment(s)`);
  for (const task of tasks) {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), `stela-dab-${safeSlug(task.dataset)}-`));
    const bridge = new DabBridgeClient({
      dabRoot: options.dabRoot,
      bridgePath,
      condaEnv: options.condaEnv,
      python: options.python ?? undefined,
      stderrPath: path.join(temp, "bridge.stderr.log"),
    });
    const config = { dataset: task.dataset, queryId: task.queryId, runDir: temp };
    try {
      await bridge.call("test", { config });
      const databases = await bridge.call<string[]>("list_databases", { config });
      if (databases.length === 0) throw new Error("no logical databases");
      let described = 0;
      let readOnlyQueries = 0;
      for (const database of databases) {
        const tables = await bridge.call<string[]>("list_tables", { config, db: database });
        if (tables.length > 0) {
          const descriptors = await bridge.call<unknown[]>("describe_tables", {
            config,
            tables: [{ database, table: tables[0] }],
          });
          if (descriptors.length !== 1) throw new Error(`${database}: schema description unavailable`);
          described += 1;
        }
        try {
          await bridge.call<QueryResult>("execute", {
            config,
            sql: `-- stela-dab-database: ${database}\nSELECT 1 AS stela_self_check`,
          });
          readOnlyQueries += 1;
        } catch (error) {
          if (!String(error).includes("unsupported_mongodb")) throw error;
        }
      }
      const validation = await bridge.call<DabValidation>("validate", {
        config,
        answer: "",
        terminateReason: "self_check",
      });
      if (typeof validation.is_valid !== "boolean") throw new Error("validator returned no is_valid flag");
      console.log(`  PASS ${task.dataset}: ${databases.length} db, ${described} schema, ${readOnlyQueries} SQL probes`);
    } finally {
      await bridge.close();
      await fs.rm(temp, { recursive: true, force: true });
    }
  }
}

function buildConnectionConfig(task: DabTask, runDir: string): Record<string, unknown> {
  return { dataset: task.dataset, queryId: task.queryId, runDir };
}

function usageWithRate(usage: UsageTotals): UsageTotals & { cacheHitRate: number | null } {
  return { ...usage, cacheHitRate: cacheHitRate(usage.inputTokens, usage.cacheReadTokens, usage.cacheWriteTokens) };
}

async function runTask(input: {
  task: DabTask;
  runNumber: number;
  runDir: string;
  options: CliOptions;
  settings: AiSettings;
  credentials: ReturnType<typeof requireCredentials>;
}): Promise<FinalRun> {
  const { task, runNumber, runDir, options, settings, credentials } = input;
  await fs.mkdir(runDir, { recursive: true });
  const vaultPath = path.join(runDir, "vault");
  await fs.mkdir(path.join(vaultPath, ".stela"), { recursive: true });
  const bridge = new DabBridgeClient({
    dabRoot: options.dabRoot,
    bridgePath,
    condaEnv: options.condaEnv,
    python: options.python ?? undefined,
    stderrPath: path.join(runDir, "bridge.stderr.log"),
  });
  try {
  const bridgeConfig = buildConnectionConfig(task, runDir);
  const connection: ConnectionEntry = { kind: "dab", config: bridgeConfig };
  await bridge.call("test", { config: bridgeConfig });

  const promptInput = await readDabPrompt(task, options.hints);
  const request: AgentRunRequest = {
    runId: `dab-${safeSlug(task.dataset)}-${task.queryId}-${runNumber}`,
    prompt: buildDabUserPrompt(promptInput),
    entryPoint: "chat",
    locale: "en",
    connectionName: "dab",
    notePath: null,
  };
  const { models, model } = createTransportForProfile(settings, credentials.apiKey, "eval");
  const session = new Session(new InMemorySessionStorage(), {
    entryProjectors: {
      [EXECUTION_PLAN_ENTRY]: (entry) => {
        const data = entry.data as { runId?: string; plan?: AgentPlanSnapshot } | undefined;
        return [{
          role: "user",
          content:
            `Execution plan snapshot for run ${data?.runId ?? data?.plan?.runId ?? "unknown"} ` +
            `version ${data?.plan?.version ?? 0}. Use only the highest version matching the current run.\n` +
            formatExecutionPlanEntry(data ?? {}),
          timestamp: Date.now(),
        }];
      },
    },
  });
  const plan = new ExecutionPlanStore(request.runId);
  const planPersistence = createPlanPersistenceBuffer(async (snapshot) => {
    await session.appendCustomEntry(EXECUTION_PLAN_ENTRY, {
      runId: snapshot.runId,
      plan: structuredClone(snapshot),
    });
  });
  const runRecords = new Map<string, RunRecord>();
  const toolEvents: unknown[] = [];
  const capabilityFailures: Record<string, number> = {};
  const toolCallCounts: Record<string, number> = {};
  const usage: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let modelTurns = 0;
  let toolCalls = 0;
  let firstResultMs: number | null = null;
  let forcedStop: string | null = null;
  let error: string | null = null;
  let answer = "";
  const started = Date.now();

  const requestProposal = async (_toolCallId: string, proposal: ProposalRequest): Promise<boolean | string> =>
    proposal.kind === "question"
      ? "No additional information is available. Use the query, database description, and dataset hints."
      : false;

  const harness = new AgentHarness({
    env: new NodeExecutionEnv({ cwd: vaultPath }),
    session,
    models,
    model,
    thinkingLevel: "off",
    systemPrompt: buildSystemPrompt(AGENT_SKILL_LIMITS_PROMPT),
    streamOptions: { cacheRetention: "short" },
    resources: { skills: [] },
    tools: createAgentTools({
      ctx: {
        vaultPath,
        connectionName: "dab",
        connection,
        aiSettings: settings,
        connector: {
          listKinds: () => [{
            kind: "dab",
            displayName: "DataAgentBench",
            configSchema: {},
            defaultConfig: {},
            subprocess: true,
            dialect: "DAB routed SQL",
          }],
          listDatabases: async () => bridge.call("list_databases", { config: bridgeConfig }),
          listTables: async (_kind, _config, database) =>
            bridge.call("list_tables", { config: bridgeConfig, db: database }),
          describeTables: async (_kind, _config, tables) =>
            bridge.call("describe_tables", { config: bridgeConfig, tables }),
          execute: async (_kind, _config, sql) =>
            bridge.call("execute", { config: bridgeConfig, sql }),
        },
        sqlIndex: { query: async () => [] },
        skills: [],
        mode: "normal",
        run: { runId: request.runId, notePath: null, questionsAsked: 0 },
        chartRuns: new Map(),
        resolveChartRun: async (runId) => runRecords.get(runId) ?? null,
        plan,
        persistPlan: planPersistence.enqueue,
        recordRun: async (record) => {
          const { columns, rows, ...runRecord } = record;
          runRecords.set(record.runId, { ...runRecord, status: record.status });
          await appendJsonl(path.join(runDir, "sql_runs.jsonl"), { ...runRecord, columns, rows });
        },
      },
      requestProposal,
    }),
  });

  const stop = (reason: string): void => {
    if (forcedStop) return;
    forcedStop = reason;
    void harness.abort();
  };
  const timer = setTimeout(() => stop("timeout"), options.timeoutMs);
  const unsubscribe = harness.subscribe(async (event) => {
    if (event.type === "turn_end") {
      await planPersistence.flush();
      return;
    }
    if (event.type === "tool_execution_start") {
      toolCalls += 1;
      toolCallCounts[event.toolName] = (toolCallCounts[event.toolName] ?? 0) + 1;
      if (firstResultMs === null) firstResultMs = Date.now() - started;
      toolEvents.push({ at: Date.now(), type: event.type, name: event.toolName, callId: event.toolCallId, args: event.args });
      if (toolCalls > options.maxToolCalls) stop("tool_call_cap");
    } else if (event.type === "tool_execution_end") {
      const resultText = JSON.stringify(event.result ?? null);
      for (const code of ["unsupported_mongodb", "cross_database_query", "missing_database_route", "unknown_database"]) {
        if (resultText.includes(code)) capabilityFailures[code] = (capabilityFailures[code] ?? 0) + 1;
      }
      toolEvents.push({ at: Date.now(), type: event.type, callId: event.toolCallId, isError: event.isError, result: event.result });
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      modelTurns += 1;
      const item = event.message.usage;
      usage.inputTokens += item.input ?? 0;
      usage.outputTokens += item.output ?? 0;
      usage.cacheReadTokens += item.cacheRead ?? 0;
      usage.cacheWriteTokens += item.cacheWrite ?? 0;
      const continuesWithTools = event.message.content.some((block) => block.type === "toolCall");
      if (!continuesWithTools && firstResultMs === null) firstResultMs = Date.now() - started;
      if (continuesWithTools && modelTurns >= options.maxModelTurns) stop("model_turn_cap");
    }
  });

  try {
    const result = await harness.prompt(buildUserContent(request, {
      connection,
      dialect: "DAB routed SQL (PostgreSQL, SQLite, DuckDB; MongoDB unsupported)",
    }));
    answer = assistantText(result);
    if (result.stopReason === "error") error = result.errorMessage ?? "agent error";
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    clearTimeout(timer);
    unsubscribe();
    await fs.writeFile(
      path.join(runDir, "tool_calls.jsonl"),
      toolEvents.map((event) => JSON.stringify(event)).join("\n") + (toolEvents.length > 0 ? "\n" : ""),
      "utf-8",
    );
  }

  let validation: DabValidation;
  try {
    validation = await bridge.call("validate", {
      config: bridgeConfig,
      answer,
      terminateReason: forcedStop ?? (error ? "error" : "final_answer"),
    });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    validation = { is_valid: false, reason: `validator_error: ${message}`, llm_answer: answer };
    error ??= message;
  }
  const transcript = (await session.buildContext()).messages;

  return {
    complete: true,
    dataset: task.dataset,
    query: String(task.queryId),
    run: runNumber,
    answer,
    valid: validation.is_valid === true,
    validation,
    terminateReason: forcedStop ?? (error ? "error" : "final_answer"),
    error,
    model: credentials.model,
    hints: options.hints,
    startedAt: new Date(started).toISOString(),
    elapsedMs: Date.now() - started,
    firstResultMs,
    modelTurns,
    toolCalls,
    toolCallCounts,
    capabilityFailures,
    usage: usageWithRate(usage),
    transcript,
  };
  } finally {
    await bridge.close();
  }
}

async function readCompleted(filePath: string): Promise<FinalRun | null> {
  try {
    const value = JSON.parse(await fs.readFile(filePath, "utf-8")) as FinalRun;
    return value.complete === true ? value : null;
  } catch {
    return null;
  }
}

async function writeSummary(output: string, results: FinalRun[]): Promise<void> {
  const valid = results.filter((result) => result.valid).length;
  const byDataset = Object.fromEntries(
    [...new Set(results.map((result) => result.dataset))].sort().map((dataset) => {
      const rows = results.filter((result) => result.dataset === dataset);
      return [dataset, { valid: rows.filter((row) => row.valid).length, total: rows.length }];
    }),
  );
  const usage = results.reduce<UsageTotals>((sum, result) => ({
    inputTokens: sum.inputTokens + result.usage.inputTokens,
    outputTokens: sum.outputTokens + result.usage.outputTokens,
    cacheReadTokens: sum.cacheReadTokens + result.usage.cacheReadTokens,
    cacheWriteTokens: sum.cacheWriteTokens + result.usage.cacheWriteTokens,
  }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  const capabilityFailures: Record<string, number> = {};
  for (const result of results) {
    for (const [code, count] of Object.entries(result.capabilityFailures)) {
      capabilityFailures[code] = (capabilityFailures[code] ?? 0) + count;
    }
  }
  const summary = {
    generatedAt: new Date().toISOString(),
    valid,
    total: results.length,
    validRate: results.length > 0 ? valid / results.length : 0,
    byDataset,
    capabilityFailures,
    usage: usageWithRate(usage),
    averageElapsedMs: results.length > 0
      ? results.reduce((sum, result) => sum + result.elapsedMs, 0) / results.length
      : 0,
  };
  await writeJson(path.join(output, "summary.json"), summary);
  await writeJson(path.join(output, "submission.json"), results.map((result) => ({
    dataset: result.dataset,
    query: result.query,
    run: String(result.run),
    answer: result.answer,
  })));
  const lines = [
    "# Stela DataAgentBench internal baseline",
    "",
    `- Valid rate: ${valid}/${results.length} (${(summary.validRate * 100).toFixed(1)}%)`,
    `- Cache hit rate: ${summary.usage.cacheHitRate === null ? "n/a" : `${(summary.usage.cacheHitRate * 100).toFixed(1)}%`}`,
    `- Average elapsed: ${(summary.averageElapsedMs / 1000).toFixed(1)}s`,
    "",
    "## Datasets",
    "",
    ...Object.entries(byDataset).map(([dataset, value]) => `- ${dataset}: ${value.valid}/${value.total}`),
    "",
    "## Capability failures",
    "",
    ...(Object.keys(capabilityFailures).length > 0
      ? Object.entries(capabilityFailures).map(([code, count]) => `- ${code}: ${count}`)
      : ["- none"]),
    "",
  ];
  await fs.writeFile(path.join(output, "report.md"), lines.join("\n"), "utf-8");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const allTasks = await discoverDabTasks(options.dabRoot);
  const tasks = selectTasks(allTasks, options);
  if (options.selfCheck) {
    await runSelfCheck(tasks, options);
    return;
  }

  const credentials = requireCredentials();
  const settings = buildEvalSettings(credentials.model, credentials.baseUrl);
  const output = options.output ?? path.join(
    path.dirname(options.dabRoot),
    "dab-results",
    `stela-product-${safeSlug(credentials.model)}-${options.hints ? "hints" : "no-hints"}`,
  );
  await fs.mkdir(output, { recursive: true });
  const [stelaGit, dabGit] = await Promise.all([gitState(repoRoot), gitState(options.dabRoot)]);
  await writeJson(path.join(output, "manifest.json"), {
    generatedAt: new Date().toISOString(),
    stela: stelaGit,
    dab: dabGit,
    model: credentials.model,
    endpointHash: endpointHash(credentials.baseUrl),
    hints: options.hints,
    runs: options.runs,
    maxModelTurns: options.maxModelTurns,
    maxToolCalls: options.maxToolCalls,
    timeoutMs: options.timeoutMs,
    host: { platform: process.platform, arch: process.arch, node: process.version },
  });

  const results: FinalRun[] = [];
  for (const task of tasks) {
    for (let runNumber = 0; runNumber < options.runs; runNumber += 1) {
      const runDir = path.join(output, `query_${task.dataset}`, `query${task.queryId}`, `run_${runNumber}`);
      const finalPath = path.join(runDir, "final_agent.json");
      if (options.resume) {
        const completed = await readCompleted(finalPath);
        if (completed) {
          results.push(completed);
          console.log(`SKIP ${task.dataset}/query${task.queryId}/run_${runNumber}`);
          continue;
        }
      }
      console.log(`RUN  ${task.dataset}/query${task.queryId}/run_${runNumber}`);
      try {
        const result = await runTask({ task, runNumber, runDir, options, settings, credentials });
        await writeJson(finalPath, result);
        await fs.rm(path.join(runDir, "runner_failure.json"), { force: true });
        results.push(result);
        console.log(`  ${result.valid ? "PASS" : "FAIL"} ${result.elapsedMs}ms ${result.terminateReason}`);
      } catch (caught) {
        const message = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
        const failure: FinalRun = {
          complete: true,
          dataset: task.dataset,
          query: String(task.queryId),
          run: runNumber,
          answer: "",
          valid: false,
          validation: { is_valid: false, reason: `runner_error: ${message}`, llm_answer: "" },
          terminateReason: "runner_error",
          error: message,
          model: credentials.model,
          hints: options.hints,
          startedAt: new Date().toISOString(),
          elapsedMs: 0,
          firstResultMs: null,
          modelTurns: 0,
          toolCalls: 0,
          toolCallCounts: {},
          capabilityFailures: { runner_error: 1 },
          usage: usageWithRate({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
          transcript: [],
        };
        // Do not create final_agent.json: --resume must retry runner/environment failures.
        await writeJson(path.join(runDir, "runner_failure.json"), failure);
        results.push(failure);
        console.log(`  ERROR ${message.split("\n")[0]}`);
      }
    }
  }
  await writeSummary(output, results);
  console.log(`\n${results.filter((result) => result.valid).length}/${results.length} valid -> ${output}`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exit(1);
  });
}
