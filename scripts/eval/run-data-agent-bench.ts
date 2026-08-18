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
  DataQueryRequest,
  QueryResult,
  RunRecord,
  AgentStrategyCheckpoint,
  AiReasoningEffort,
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
  configureQueryArtifactRoot,
  createQueryArtifactTarget,
  discardQueryArtifactTarget,
  finalizeMaterializedQueryArtifact,
  resolveQueryArtifact,
  writeBufferedQueryArtifact,
} from "../../electron/services/query-artifacts";
import {
  createPlanPersistenceBuffer,
  ExecutionPlanStore,
  formatExecutionPlanEntry,
} from "../../electron/services/ai/execution-plan";
import {
  AnalysisEfficiencyLedger,
  efficiencyHintContent,
  formatStrategyCheckpoint,
  runStrategyReview,
  STRATEGY_CHECKPOINT_ENTRY,
  strategyReviewResponseFromError,
  type AnalysisEfficiencyMetrics,
} from "../../electron/services/ai/analysis-efficiency";
import { createTransportForProfile } from "../../electron/services/ai/provider";
import { buildEvalSettings, evalReasoningEffort, requireCredentials } from "./env";
import {
  appendJsonl,
  buildDabUserPrompt,
  cacheHitRate,
  DabBridgeClient,
  DabBridgeError,
  type DabTask,
  type DabValidation,
  discoverDabTasks,
  endpointHash,
  mapWithResourceConcurrency,
  readDabDatasetResourceLocks,
  readDabPrompt,
  safeSlug,
  writeJson,
} from "./data-agent-bench/runtime";
import {
  assertPyodideAssets,
  HeadlessPyodidePool,
} from "./data-agent-bench/headless-python";

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
  bridgeTimeoutMs: number;
  concurrency: number;
  pythonConcurrency: number;
  pyodideAssets: string;
  noPython: boolean;
  strategyReview: boolean;
  reasoningEffort: AiReasoningEffort;
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
  requestedReasoningEffort: AiReasoningEffort;
  effectiveReasoningEffort: AiReasoningEffort;
  hints: boolean;
  startedAt: string;
  elapsedMs: number;
  firstResultMs: number | null;
  modelTurns: number;
  toolCalls: number;
  toolCallCounts: Record<string, number>;
  capabilityFailures: Record<string, number>;
  efficiency: AnalysisEfficiencyMetrics;
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
    bridgeTimeoutMs: intArg(value("--bridge-timeout-ms") ?? "600000", "--bridge-timeout-ms", 1000),
    concurrency: intArg(value("--concurrency") ?? "1", "--concurrency", 1),
    pythonConcurrency: intArg(value("--python-concurrency") ?? "2", "--python-concurrency", 1),
    pyodideAssets: path.resolve(
      value("--pyodide-assets") ?? path.join(repoRoot, "node_modules", ".cache", "stela-pyodide"),
    ),
    noPython: argv.includes("--no-python"),
    strategyReview: !argv.includes("--no-strategy-review"),
    reasoningEffort: evalReasoningEffort(value("--reasoning-effort")),
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
      callTimeoutMs: options.bridgeTimeoutMs,
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
        if (tables.length > 0) {
          try {
            await bridge.call<QueryResult>("execute_query", {
              config,
              query: { language: "sql", database, query: "SELECT 1 AS stela_self_check" } satisfies DataQueryRequest,
            });
          } catch (error) {
            if (!(error instanceof DabBridgeError) || error.code !== "query_language_mismatch") throw error;
            await bridge.call<QueryResult>("execute_query", {
              config,
              query: {
                language: "mongodb",
                database,
                collection: tables[0],
                filter: {},
                projection: { _id: 1 },
                limit: 1,
              } satisfies DataQueryRequest,
            });
            await bridge.call<QueryResult>("execute_query", {
              config,
              query: {
                language: "mongodb",
                operation: "aggregate",
                database,
                collection: tables[0],
                pipeline: [{ $limit: 1 }],
                limit: 1,
              } satisfies DataQueryRequest,
            });
          }
          readOnlyQueries += 1;
        }
      }
      const validation = await bridge.call<DabValidation>("validate", {
        config,
        answer: "",
        terminateReason: "self_check",
      });
      if (typeof validation.is_valid !== "boolean") throw new Error("validator returned no is_valid flag");
      console.log(`  PASS ${task.dataset}: ${databases.length} db, ${described} schema, ${readOnlyQueries} query probes`);
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
  pythonPool: HeadlessPyodidePool | null;
}): Promise<FinalRun> {
  const { task, runNumber, runDir, options, settings, credentials, pythonPool } = input;
  await fs.mkdir(runDir, { recursive: true });
  const vaultPath = path.join(runDir, "vault");
  await fs.mkdir(path.join(vaultPath, ".stela"), { recursive: true });
  const bridge = new DabBridgeClient({
    dabRoot: options.dabRoot,
    bridgePath,
    condaEnv: options.condaEnv,
    python: options.python ?? undefined,
    stderrPath: path.join(runDir, "bridge.stderr.log"),
    callTimeoutMs: options.bridgeTimeoutMs,
  });
  try {
  const bridgeConfig = buildConnectionConfig(task, runDir);
  const connection: ConnectionEntry = { kind: "dab", config: bridgeConfig };
  await bridge.call("test", { config: bridgeConfig });

  const promptInput = await readDabPrompt(task, options.hints);
  const request: AgentRunRequest = {
    runId: `dab-${safeSlug(task.dataset)}-${task.queryId}-${runNumber}`,
    prompt: buildDabUserPrompt(promptInput, { pythonAvailable: pythonPool !== null }),
    entryPoint: "chat",
    locale: "en",
    connectionName: "dab",
    notePath: null,
  };
  const { models, model, reasoning } = createTransportForProfile(settings, credentials.apiKey, "eval");
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
      [STRATEGY_CHECKPOINT_ENTRY]: (entry) => {
        const checkpoint = (entry.data as { checkpoint?: AgentStrategyCheckpoint } | undefined)?.checkpoint;
        return checkpoint
          ? [{ role: "user", content: formatStrategyCheckpoint(checkpoint), timestamp: Date.now() }]
          : [];
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
  let abortAgent = (): void => {};
  const reviewAbort = new AbortController();
  const efficiency = new AnalysisEfficiencyLedger({ advisoriesEnabled: options.strategyReview });
  let pendingStrategyCheckpoint: AgentStrategyCheckpoint | null = null;

  const stop = (reason: string): void => {
    if (forcedStop) return;
    forcedStop = reason;
    bridge.terminate(`run stopped: ${reason}`);
    reviewAbort.abort(reason);
    abortAgent();
  };

  const bridgeCall = async <T>(method: string, params: unknown): Promise<T> => {
    try {
      return await bridge.call<T>(method, params);
    } catch (caught) {
      if (caught instanceof DabBridgeError && caught.fatal) {
        error ??= caught.message;
        stop(caught.code);
      }
      throw caught;
    }
  };

  const requestProposal = async (_toolCallId: string, _proposal: ProposalRequest): Promise<boolean | string> => false;

  const harness = new AgentHarness({
    env: new NodeExecutionEnv({ cwd: vaultPath }),
    session,
    models,
    model,
    thinkingLevel: reasoning.effective,
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
            queryLanguages: ["sql", "mongodb"],
            mongoOperations: ["find", "aggregate"],
          }],
          listDatabases: async () => bridgeCall("list_databases", { config: bridgeConfig }),
          listTables: async (_kind, _config, database) =>
            bridgeCall("list_tables", { config: bridgeConfig, db: database }),
          describeTables: async (_kind, _config, tables) =>
            bridgeCall("describe_tables", { config: bridgeConfig, tables }),
          execute: async (_kind, _config, sql) =>
            bridgeCall("execute", { config: bridgeConfig, sql }),
          executeQuery: async (_kind, _config, query: DataQueryRequest) =>
            bridgeCall("execute_query", { config: bridgeConfig, query }),
        },
        ...(pythonPool
          ? {
              queryArtifacts: {
                createTarget: createQueryArtifactTarget,
                finalize: finalizeMaterializedQueryArtifact,
                writeBuffered: writeBufferedQueryArtifact,
                resolve: resolveQueryArtifact,
                discard: discardQueryArtifactTarget,
              },
              pythonExecutor: pythonPool,
            }
          : {}),
        sqlIndex: { query: async () => [] },
        skills: [],
        mode: "normal",
        run: { runId: request.runId, sessionId: request.runId, notePath: null, questionsAsked: 0 },
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
  const strategyUnsubscribe = harness.on("tool_result", async (event) => {
    const signalResult = efficiency.recordResult({
      toolName: event.toolName,
      args: event.input,
      content: event.content,
      isError: event.isError,
    });
    if (!options.strategyReview) return undefined;
    const content = signalResult.hint
      ? [...event.content, efficiencyHintContent(signalResult.hint)]
      : [...event.content];
    if (!signalResult.reviewTrigger) return signalResult.hint ? { content } : undefined;
    const trigger = signalResult.reviewTrigger;
    toolEvents.push({ at: Date.now(), type: "strategy_review_start", trigger, metrics: efficiency.metrics() });
    try {
      const reviewed = await runStrategyReview({
        models,
        model,
        reasoningEffort: reasoning.effective,
        signal: reviewAbort.signal,
        sessionId: `stela-dab-strategy-review:${credentials.model}`,
        review: {
          runId: request.runId,
          goal: request.prompt,
          plan: plan.formatForContext(),
          capabilities: JSON.stringify({
            queryLanguages: ["sql", "mongodb"],
            mongoOperations: ["find", "aggregate"],
            executePython: pythonPool !== null,
          }),
          trigger,
          metrics: efficiency.metrics(),
          observations: efficiency.recent(),
        },
      });
      efficiency.markReviewCompleted();
      reviewed.checkpoint.metrics = efficiency.metrics();
      pendingStrategyCheckpoint = reviewed.checkpoint;
      usage.inputTokens += reviewed.message.usage.input ?? 0;
      usage.outputTokens += reviewed.message.usage.output ?? 0;
      usage.cacheReadTokens += reviewed.message.usage.cacheRead ?? 0;
      usage.cacheWriteTokens += reviewed.message.usage.cacheWrite ?? 0;
      toolEvents.push({
        at: Date.now(),
        type: "strategy_review_end",
        trigger,
        checkpoint: reviewed.checkpoint,
        usage: reviewed.message.usage,
      });
      content.push(efficiencyHintContent(formatStrategyCheckpoint(reviewed.checkpoint)));
    } catch (caught) {
      efficiency.markReviewFailed();
      const message = caught instanceof Error ? caught.message : String(caught);
      const failureResponse = strategyReviewResponseFromError(caught);
      if (failureResponse) {
        usage.inputTokens += failureResponse.usage.input ?? 0;
        usage.outputTokens += failureResponse.usage.output ?? 0;
        usage.cacheReadTokens += failureResponse.usage.cacheRead ?? 0;
        usage.cacheWriteTokens += failureResponse.usage.cacheWrite ?? 0;
      }
      toolEvents.push({
        at: Date.now(),
        type: "strategy_review_error",
        trigger,
        message,
        usage: failureResponse?.usage,
      });
      content.push(efficiencyHintContent(
        "Strategy review was unavailable. Continue the main analysis, but use a materially different set-based or artifact-backed approach instead of more probes in the same family.",
      ));
    }
    return { content };
  });
  abortAgent = () => { void harness.abort(); };
  const timer = setTimeout(() => stop("task_timeout"), options.timeoutMs);
  const unsubscribe = harness.subscribe(async (event) => {
    if (event.type === "turn_end") {
      if (pendingStrategyCheckpoint) {
        const checkpoint = pendingStrategyCheckpoint;
        pendingStrategyCheckpoint = null;
        await session.appendCustomEntry(STRATEGY_CHECKPOINT_ENTRY, {
          runId: checkpoint.runId,
          checkpoint: structuredClone(checkpoint),
        });
      }
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
      for (const code of ["unsupported_mongodb", "cross_database_query", "missing_database_route", "unknown_database", "query_language_mismatch"]) {
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
      dialect: "DAB structured query (SQL and MongoDB find/aggregate)",
      queryLanguages: ["sql", "mongodb"],
      mongoOperations: ["find", "aggregate"],
      contextSources: {
        vault_notes: "empty",
        skills: "empty",
        sql_history: "empty",
        canvas: "empty",
        clarification: "unavailable",
      },
    }));
    answer = assistantText(result);
    if (result.stopReason === "error") error = result.errorMessage ?? "agent error";
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    clearTimeout(timer);
    strategyUnsubscribe();
    reviewAbort.abort("run finished");
    unsubscribe();
    await fs.writeFile(
      path.join(runDir, "tool_calls.jsonl"),
      toolEvents.map((event) => JSON.stringify(event)).join("\n") + (toolEvents.length > 0 ? "\n" : ""),
      "utf-8",
    );
  }

  let validation: DabValidation;
  const validatorBridge = new DabBridgeClient({
    dabRoot: options.dabRoot,
    bridgePath,
    condaEnv: options.condaEnv,
    python: options.python ?? undefined,
    stderrPath: path.join(runDir, "validator.stderr.log"),
    callTimeoutMs: Math.min(options.bridgeTimeoutMs, 120_000),
  });
  try {
    validation = await validatorBridge.call("validate", {
      config: bridgeConfig,
      answer,
      terminateReason: forcedStop ?? (error ? "error" : "final_answer"),
    });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    validation = { is_valid: false, reason: `validator_error: ${message}`, llm_answer: answer };
    error ??= message;
  } finally {
    await validatorBridge.close();
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
    requestedReasoningEffort: reasoning.requested,
    effectiveReasoningEffort: reasoning.effective,
    hints: options.hints,
    startedAt: new Date(started).toISOString(),
    elapsedMs: Date.now() - started,
    firstResultMs,
    modelTurns,
    toolCalls,
    toolCallCounts,
    capabilityFailures,
    efficiency: efficiency.metrics(),
    usage: usageWithRate(usage),
    transcript,
  };
  } finally {
    await bridge.close();
  }
}

export async function readCompleted(
  filePath: string,
  requestedReasoningEffort: AiReasoningEffort,
  effectiveReasoningEffort: AiReasoningEffort,
): Promise<FinalRun | null> {
  try {
    const value = JSON.parse(await fs.readFile(filePath, "utf-8")) as FinalRun;
    const requested = value.requestedReasoningEffort ?? "off";
    const effective = value.effectiveReasoningEffort ?? "off";
    return value.complete === true &&
      requested === requestedReasoningEffort &&
      effective === effectiveReasoningEffort
      ? value
      : null;
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
  const efficiency = {
    reviewTriggered: results.filter((result) => result.efficiency.reviewTriggered).length,
    reviewCompleted: results.filter((result) => result.efficiency.reviewStatus === "completed").length,
    reviewFailed: results.filter((result) => result.efficiency.reviewStatus === "failed").length,
    queryFamilyPeak: results.reduce((peak, result) => Math.max(peak, result.efficiency.queryFamilyPeak), 0),
    strategyHints: results.reduce((sum, result) => sum + result.efficiency.strategyHints, 0),
    postReviewRunQueryCalls: results.reduce(
      (sum, result) => sum + result.efficiency.postReviewRunQueryCalls,
      0,
    ),
  };
  const summary = {
    generatedAt: new Date().toISOString(),
    valid,
    total: results.length,
    validRate: results.length > 0 ? valid / results.length : 0,
    requestedReasoningEffort: results[0]?.requestedReasoningEffort ?? null,
    effectiveReasoningEffort: results[0]?.effectiveReasoningEffort ?? null,
    byDataset,
    capabilityFailures,
    efficiency,
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
    `- Reasoning effort: ${summary.requestedReasoningEffort ?? "n/a"}` +
      (summary.requestedReasoningEffort !== summary.effectiveReasoningEffort
        ? ` -> ${summary.effectiveReasoningEffort}`
        : ""),
    `- Cache hit rate: ${summary.usage.cacheHitRate === null ? "n/a" : `${(summary.usage.cacheHitRate * 100).toFixed(1)}%`}`,
    `- Average elapsed: ${(summary.averageElapsedMs / 1000).toFixed(1)}s`,
    `- Strategy reviews: ${efficiency.reviewCompleted}/${efficiency.reviewTriggered} completed`,
    `- Peak query-family fan-out: ${efficiency.queryFamilyPeak}`,
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
  const settings = buildEvalSettings(
    credentials.model,
    credentials.baseUrl,
    options.reasoningEffort,
  );
  const output = options.output ?? path.join(
    path.dirname(options.dabRoot),
    "dab-results",
    `stela-product-${safeSlug(credentials.model)}-${options.hints ? "hints" : "no-hints"}`,
  );
  await fs.mkdir(output, { recursive: true });
  let pythonPool: HeadlessPyodidePool | null = null;
  let artifactRoot: string | null = null;
  if (!options.noPython) {
    try {
      await assertPyodideAssets(options.pyodideAssets);
    } catch (error) {
      throw new Error(
        `Pyodide assets are unavailable at ${options.pyodideAssets}. ` +
        `Run 'npm run prepare:pyodide' or pass --no-python for a legacy baseline. ` +
        `Cause: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "stela-dab-artifacts-"));
    configureQueryArtifactRoot(artifactRoot);
    pythonPool = new HeadlessPyodidePool(options.pyodideAssets, options.pythonConcurrency);
  }
  const [stelaGit, dabGit] = await Promise.all([gitState(repoRoot), gitState(options.dabRoot)]);
  await writeJson(path.join(output, "manifest.json"), {
    generatedAt: new Date().toISOString(),
    stela: stelaGit,
    dab: dabGit,
    model: credentials.model,
    requestedReasoningEffort: options.reasoningEffort,
    effectiveReasoningEffort: options.reasoningEffort,
    endpointHash: endpointHash(credentials.baseUrl),
    hints: options.hints,
    runs: options.runs,
    maxModelTurns: options.maxModelTurns,
    maxToolCalls: options.maxToolCalls,
    timeoutMs: options.timeoutMs,
    bridgeTimeoutMs: options.bridgeTimeoutMs,
    concurrency: options.concurrency,
    pythonRuntime: options.noPython ? "disabled" : "pyodide",
    pythonConcurrency: options.noPython ? 0 : options.pythonConcurrency,
    strategyReview: options.strategyReview,
    host: { platform: process.platform, arch: process.arch, node: process.version },
  });

  const jobsByDataset = new Map<string, Array<{ task: DabTask; runNumber: number }>>();
  for (const task of tasks) {
    for (let runNumber = 0; runNumber < options.runs; runNumber += 1) {
      const jobs = jobsByDataset.get(task.dataset) ?? [];
      jobs.push({ task, runNumber });
      jobsByDataset.set(task.dataset, jobs);
    }
  }
  const datasetJobs = [...jobsByDataset.values()];
  const datasetResourceLocks = new Map<string, string[]>();
  await Promise.all(datasetJobs.map(async (jobs) => {
    const task = jobs[0]?.task;
    if (task) datasetResourceLocks.set(task.dataset, await readDabDatasetResourceLocks(task));
  }));
  try {
    const resultGroups = await mapWithResourceConcurrency(
      datasetJobs,
      options.concurrency,
      (jobs) => datasetResourceLocks.get(jobs[0]?.task.dataset ?? "") ?? [],
      async (jobs): Promise<FinalRun[]> => {
      const groupResults: FinalRun[] = [];
      for (const { task, runNumber } of jobs) {
        const runDir = path.join(output, `query_${task.dataset}`, `query${task.queryId}`, `run_${runNumber}`);
        const finalPath = path.join(runDir, "final_agent.json");
        if (options.resume) {
          const completed = await readCompleted(
            finalPath,
            options.reasoningEffort,
            options.reasoningEffort,
          );
          if (completed) {
            groupResults.push(completed);
            console.log(`SKIP ${task.dataset}/query${task.queryId}/run_${runNumber}`);
            continue;
          }
        }
        console.log(`RUN  ${task.dataset}/query${task.queryId}/run_${runNumber}`);
        try {
          const result = await runTask({ task, runNumber, runDir, options, settings, credentials, pythonPool });
          await writeJson(finalPath, result);
          await fs.rm(path.join(runDir, "runner_failure.json"), { force: true });
          groupResults.push(result);
          console.log(
            `  ${result.valid ? "PASS" : "FAIL"} ${task.dataset}/query${task.queryId}/run_${runNumber} ` +
            `${result.elapsedMs}ms ${result.terminateReason}`,
          );
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
            requestedReasoningEffort: options.reasoningEffort,
            effectiveReasoningEffort: options.reasoningEffort,
            hints: options.hints,
            startedAt: new Date().toISOString(),
            elapsedMs: 0,
            firstResultMs: null,
            modelTurns: 0,
            toolCalls: 0,
            toolCallCounts: {},
            capabilityFailures: { runner_error: 1 },
            efficiency: {
              queryFamilyPeak: 0,
              strategyHints: 0,
              reviewTriggered: false,
              reviewTrigger: null,
              runQueryCallsAtReview: null,
              postReviewRunQueryCalls: 0,
              reviewStatus: "not_triggered",
            },
            usage: usageWithRate({
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            }),
            transcript: [],
          };
          // Do not create final_agent.json: --resume must retry runner/environment failures.
          await writeJson(path.join(runDir, "runner_failure.json"), failure);
          groupResults.push(failure);
          console.log(`  ERROR ${task.dataset}/query${task.queryId}/run_${runNumber} ${message.split("\n")[0]}`);
        }
      }
      return groupResults;
      },
    );
    const results = resultGroups.flat();
    await writeSummary(output, results);
    console.log(`\n${results.filter((result) => result.valid).length}/${results.length} valid -> ${output}`);
  } finally {
    await pythonPool?.close();
    if (artifactRoot) await fs.rm(artifactRoot, { recursive: true, force: true });
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exit(1);
  });
}
