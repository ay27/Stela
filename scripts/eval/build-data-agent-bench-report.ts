import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface RawContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  arguments?: unknown;
}

interface RawMessage {
  role?: string;
  content?: RawContentBlock[] | string;
  toolCallId?: string;
  toolName?: string;
  details?: unknown;
  isError?: boolean;
  timestamp?: number;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

interface RawRun {
  complete: true;
  dataset: string;
  query: string;
  run: number;
  answer: string;
  valid: boolean;
  validation?: {
    reason?: string | null;
    ground_truth?: string;
    llm_answer?: string;
  };
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
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    cacheHitRate: number | null;
  };
  transcript: RawMessage[];
}

export interface ReportTraceStep {
  role: "assistant" | "tool" | "user";
  text: string;
  thinking: string;
  toolName: string | null;
  toolCalls: Array<{ name: string; arguments: string }>;
  isError: boolean;
  timestamp: number | null;
  usage: { input: number; output: number; cacheRead: number } | null;
}

export interface ReportCase {
  id: string;
  dataset: string;
  query: number;
  run: number;
  valid: boolean;
  failureCategory: string;
  validationReason: string;
  groundTruth: string;
  question: string;
  answer: string;
  terminateReason: string;
  error: string;
  model: string;
  hints: boolean;
  startedAt: string;
  elapsedMs: number;
  firstResultMs: number | null;
  modelTurns: number;
  toolCalls: number;
  toolCallCounts: Record<string, number>;
  capabilityFailures: Record<string, number>;
  usage: RawRun["usage"];
  trace: ReportTraceStep[];
}

export interface DataAgentBenchReport {
  generatedAt: string;
  sourceGeneratedAt: string | null;
  manifest: Record<string, unknown>;
  totals: {
    cases: number;
    valid: number;
    validRate: number;
    elapsedMs: number;
    averageElapsedMs: number;
    modelTurns: number;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    cacheHitRate: number | null;
  };
  datasets: Array<{
    name: string;
    cases: number;
    valid: number;
    validRate: number;
    averageElapsedMs: number;
    averageToolCalls: number;
    capabilityFailures: Record<string, number>;
  }>;
  failureCategories: Array<{ category: string; count: number }>;
  toolStats: Array<{ tool: string; calls: number; passCalls: number; failCalls: number }>;
  cases: ReportCase[];
}

export interface DataAgentBenchHistoryRun {
  id: string;
  label: string;
  dataFile: string;
  sourceGeneratedAt: string | null;
  manifest: Record<string, unknown>;
  totals: DataAgentBenchReport["totals"];
  datasets: DataAgentBenchReport["datasets"];
  failureCategories: DataAgentBenchReport["failureCategories"];
}

export interface DataAgentBenchHistory {
  version: 1;
  generatedAt: string;
  defaultRunId: string;
  defaultComparisonRunId: string | null;
  runs: DataAgentBenchHistoryRun[];
}

const here = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.join(here, "data-agent-bench", "report");

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n… [truncated ${value.length - limit} chars]`;
}

function contentText(content: RawMessage["content"], kind: "text" | "thinking"): string {
  if (typeof content === "string") return kind === "text" ? content : "";
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => kind === "text" ? block.text ?? "" : block.thinking ?? "")
    .filter(Boolean)
    .join("\n\n");
}

function extractQuestion(transcript: RawMessage[]): string {
  const firstUser = transcript.find((message) => message.role === "user");
  const raw = contentText(firstUser?.content, "text");
  const tagged = raw.match(/<user_request>\s*([\s\S]*?)\s*<\/user_request>/)?.[1];
  let request = tagged ?? raw;
  if (tagged) {
    try {
      const parsed = JSON.parse(tagged) as { segments?: Array<{ kind?: string; text?: string }> };
      request = (parsed.segments ?? []).map((segment) => segment.text ?? "").join("\n");
    } catch {
      // Fall through to the tagged text when an older prompt is not JSON encoded.
    }
  }
  const queryIndex = request.lastIndexOf("QUERY:");
  return truncate((queryIndex >= 0 ? request.slice(queryIndex + 6) : request).trim(), 12_000);
}

function failureCategory(run: RawRun): string {
  if (run.valid) return "pass";
  const reason = `${run.validation?.reason ?? ""} ${run.error ?? ""}`.toLowerCase();
  if (run.terminateReason.includes("timeout") || reason.includes("timed out") || reason.includes("timeout")) return "timeout";
  if ((run.capabilityFailures.unsupported_mongodb ?? 0) > 0) return "mongodb_unavailable";
  if ((run.capabilityFailures.cross_database_query ?? 0) > 0) return "cross_database";
  if ((run.capabilityFailures.missing_database_route ?? 0) > 0 ||
      (run.capabilityFailures.unknown_database ?? 0) > 0) return "routing_error";
  if (reason.includes("dab bridge exited (sigterm)")) return "bridge_terminated";
  if (run.error || reason.includes("runner_error") || reason.includes("validator_error")) return "infrastructure";
  if (!run.answer.trim()) return "no_answer";
  if (reason.includes("no matching") || reason.includes("ground truth") || reason.includes("incorrect")) {
    return "wrong_answer";
  }
  return "validation_failure";
}

function stringifyArguments(value: unknown): string {
  try {
    return truncate(JSON.stringify(value, null, 2), 3_000);
  } catch {
    return truncate(String(value), 3_000);
  }
}

function compactTrace(transcript: RawMessage[]): ReportTraceStep[] {
  const steps: ReportTraceStep[] = [];
  let seenInitialUser = false;
  for (const message of transcript) {
    if (message.role === "assistant") {
      const blocks = Array.isArray(message.content) ? message.content : [];
      steps.push({
        role: "assistant",
        text: truncate(contentText(message.content, "text"), 6_000),
        thinking: truncate(contentText(message.content, "thinking"), 4_000),
        toolName: null,
        toolCalls: blocks
          .filter((block) => block.type === "toolCall" && block.name)
          .map((block) => ({ name: block.name ?? "unknown", arguments: stringifyArguments(block.arguments ?? {}) })),
        isError: false,
        timestamp: message.timestamp ?? null,
        usage: message.usage ? {
          input: message.usage.input ?? 0,
          output: message.usage.output ?? 0,
          cacheRead: message.usage.cacheRead ?? 0,
        } : null,
      });
      continue;
    }
    if (message.role === "toolResult") {
      steps.push({
        role: "tool",
        text: truncate(contentText(message.content, "text") || stringifyArguments(message.details ?? ""), 6_000),
        thinking: "",
        toolName: message.toolName ?? "unknown",
        toolCalls: [],
        isError: message.isError === true,
        timestamp: message.timestamp ?? null,
        usage: null,
      });
      continue;
    }
    if (message.role === "user") {
      if (!seenInitialUser) {
        seenInitialUser = true;
        continue;
      }
      steps.push({
        role: "user",
        text: truncate(contentText(message.content, "text"), 2_000),
        thinking: "",
        toolName: null,
        toolCalls: [],
        isError: false,
        timestamp: message.timestamp ?? null,
        usage: null,
      });
    }
  }
  return steps.filter((step) => step.text || step.thinking || step.toolCalls.length > 0);
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

async function findFinalRuns(input: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.name === "analysis") continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.name === "final_agent.json") files.push(target);
    }
  };
  await visit(input);
  return files.sort();
}

export async function buildDataAgentBenchReport(input: string): Promise<DataAgentBenchReport> {
  const files = await findFinalRuns(input);
  if (files.length === 0) throw new Error(`No final_agent.json files found below ${input}`);
  const runs = await Promise.all(files.map(async (filePath) =>
    JSON.parse(await fs.readFile(filePath, "utf-8")) as RawRun));
  const cases: ReportCase[] = runs.map((run) => ({
    id: `${run.dataset}/query${run.query}/run_${run.run}`,
    dataset: run.dataset,
    query: Number(run.query),
    run: run.run,
    valid: run.valid,
    failureCategory: failureCategory(run),
    validationReason: run.validation?.reason ?? "",
    groundTruth: run.validation?.ground_truth ?? "",
    question: extractQuestion(run.transcript ?? []),
    answer: truncate(run.answer ?? "", 30_000),
    terminateReason: run.terminateReason,
    error: truncate(run.error ?? "", 8_000),
    model: run.model,
    hints: run.hints,
    startedAt: run.startedAt,
    elapsedMs: run.elapsedMs,
    firstResultMs: run.firstResultMs,
    modelTurns: run.modelTurns,
    toolCalls: run.toolCalls,
    toolCallCounts: run.toolCallCounts ?? {},
    capabilityFailures: run.capabilityFailures ?? {},
    usage: run.usage,
    trace: compactTrace(run.transcript ?? []),
  })).sort((a, b) => a.dataset.localeCompare(b.dataset) || a.query - b.query || a.run - b.run);

  const datasetNames = [...new Set(cases.map((item) => item.dataset))].sort();
  const datasets = datasetNames.map((name) => {
    const rows = cases.filter((item) => item.dataset === name);
    const capabilityFailures: Record<string, number> = {};
    for (const row of rows) {
      for (const [key, count] of Object.entries(row.capabilityFailures)) {
        capabilityFailures[key] = (capabilityFailures[key] ?? 0) + count;
      }
    }
    const valid = rows.filter((item) => item.valid).length;
    return {
      name,
      cases: rows.length,
      valid,
      validRate: valid / rows.length,
      averageElapsedMs: rows.reduce((sum, item) => sum + item.elapsedMs, 0) / rows.length,
      averageToolCalls: rows.reduce((sum, item) => sum + item.toolCalls, 0) / rows.length,
      capabilityFailures,
    };
  });
  const failureCounts = new Map<string, number>();
  const tools = new Map<string, { calls: number; passCalls: number; failCalls: number }>();
  for (const item of cases) {
    if (!item.valid) failureCounts.set(item.failureCategory, (failureCounts.get(item.failureCategory) ?? 0) + 1);
    for (const [tool, calls] of Object.entries(item.toolCallCounts)) {
      const value = tools.get(tool) ?? { calls: 0, passCalls: 0, failCalls: 0 };
      value.calls += calls;
      if (item.valid) value.passCalls += calls;
      else value.failCalls += calls;
      tools.set(tool, value);
    }
  }
  const tokenPromptTotal = cases.reduce((sum, item) =>
    sum + item.usage.inputTokens + item.usage.cacheReadTokens + item.usage.cacheWriteTokens, 0);
  const valid = cases.filter((item) => item.valid).length;
  const summary = await readJson<{ generatedAt?: string }>(path.join(input, "summary.json"), {});
  const manifest = await readJson<Record<string, unknown>>(path.join(input, "manifest.json"), {});
  return {
    generatedAt: new Date().toISOString(),
    sourceGeneratedAt: summary.generatedAt ?? null,
    manifest,
    totals: {
      cases: cases.length,
      valid,
      validRate: valid / cases.length,
      elapsedMs: cases.reduce((sum, item) => sum + item.elapsedMs, 0),
      averageElapsedMs: cases.reduce((sum, item) => sum + item.elapsedMs, 0) / cases.length,
      modelTurns: cases.reduce((sum, item) => sum + item.modelTurns, 0),
      toolCalls: cases.reduce((sum, item) => sum + item.toolCalls, 0),
      inputTokens: cases.reduce((sum, item) => sum + item.usage.inputTokens, 0),
      outputTokens: cases.reduce((sum, item) => sum + item.usage.outputTokens, 0),
      cacheReadTokens: cases.reduce((sum, item) => sum + item.usage.cacheReadTokens, 0),
      cacheWriteTokens: cases.reduce((sum, item) => sum + item.usage.cacheWriteTokens, 0),
      cacheHitRate: tokenPromptTotal > 0
        ? cases.reduce((sum, item) => sum + item.usage.cacheReadTokens, 0) / tokenPromptTotal
        : null,
    },
    datasets,
    failureCategories: [...failureCounts.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count),
    toolStats: [...tools.entries()]
      .map(([tool, value]) => ({ tool, ...value }))
      .sort((a, b) => b.calls - a.calls),
    cases,
  };
}

export async function writeDataAgentBenchReport(input: string, output: string): Promise<void> {
  const report = await buildDataAgentBenchReport(input);
  await fs.mkdir(output, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(output, "analysis-data.json"), JSON.stringify(report), "utf-8"),
    fs.copyFile(path.join(assetsDir, "index.html"), path.join(output, "index.html")),
    fs.copyFile(path.join(assetsDir, "app.js"), path.join(output, "app.js")),
    fs.copyFile(path.join(assetsDir, "styles.css"), path.join(output, "styles.css")),
  ]);
  const size = (await fs.stat(path.join(output, "analysis-data.json"))).size;
  console.log(`DataAgentBench report: ${report.totals.valid}/${report.totals.cases} valid`);
  console.log(`Analysis data: ${(size / 1024 / 1024).toFixed(1)} MiB`);
  console.log(`Open: ${path.join(output, "index.html")}`);
}

function safeRunId(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "run";
}

async function copyReportAssets(output: string): Promise<void> {
  await Promise.all([
    fs.copyFile(path.join(assetsDir, "index.html"), path.join(output, "index.html")),
    fs.copyFile(path.join(assetsDir, "app.js"), path.join(output, "app.js")),
    fs.copyFile(path.join(assetsDir, "styles.css"), path.join(output, "styles.css")),
  ]);
}

export async function writeDataAgentBenchHistory(
  inputs: string[],
  output: string,
): Promise<DataAgentBenchHistory> {
  if (inputs.length === 0) throw new Error("At least one benchmark result directory is required.");
  const resolvedInputs = [...new Set(inputs.map((input) => path.resolve(input)))];
  const reports = await Promise.all(resolvedInputs.map(async (input) => ({
    input,
    report: await buildDataAgentBenchReport(input),
  })));
  reports.sort((a, b) => {
    const left = Date.parse(a.report.sourceGeneratedAt ?? "") || 0;
    const right = Date.parse(b.report.sourceGeneratedAt ?? "") || 0;
    return right - left || a.input.localeCompare(b.input);
  });

  const usedIds = new Map<string, number>();
  const entries = reports.map(({ input, report }) => {
    const base = safeRunId(path.basename(input));
    const count = usedIds.get(base) ?? 0;
    usedIds.set(base, count + 1);
    const id = count === 0 ? base : `${base}-${count + 1}`;
    return {
      id,
      label: path.basename(input),
      dataFile: `./runs/${id}.json`,
      sourceGeneratedAt: report.sourceGeneratedAt,
      manifest: report.manifest,
      totals: report.totals,
      datasets: report.datasets,
      failureCategories: report.failureCategories,
      report,
    };
  });
  const history: DataAgentBenchHistory = {
    version: 1,
    generatedAt: new Date().toISOString(),
    defaultRunId: entries[0]!.id,
    defaultComparisonRunId: entries[1]?.id ?? null,
    runs: entries.map(({ report: _report, ...entry }) => entry),
  };

  await fs.mkdir(path.join(output, "runs"), { recursive: true });
  await Promise.all([
    copyReportAssets(output),
    fs.writeFile(path.join(output, "history.json"), JSON.stringify(history), "utf-8"),
    ...entries.map((entry) =>
      fs.writeFile(path.join(output, "runs", `${entry.id}.json`), JSON.stringify(entry.report), "utf-8")),
  ]);
  console.log(`DataAgentBench history: ${entries.length} runs`);
  for (const entry of entries) {
    console.log(`  ${entry.label}: ${entry.totals.valid}/${entry.totals.cases} valid`);
  }
  console.log(`Open: ${path.join(output, "index.html")}`);
  return history;
}

function argValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function argValues(argv: string[], name: string): string[] {
  return argv.flatMap((value, index) => value === name && argv[index + 1] ? [argv[index + 1]!] : []);
}

async function discoverHistoryInputs(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const candidates = entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name));
  const completed = await Promise.all(candidates.map(async (candidate) => {
    try {
      await fs.access(path.join(candidate, "summary.json"));
      const finalRuns = await findFinalRuns(candidate);
      return finalRuns.length > 0 ? candidate : null;
    } catch {
      return null;
    }
  }));
  return completed.filter((candidate): candidate is string => candidate !== null);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const inputValues = argValues(argv, "--input");
  const historyRootValue = argValue(argv, "--history-root");
  if (!historyRootValue && inputValues.length === 0) {
    throw new Error("Pass --input <result directory> or --history-root <directory containing result runs>.");
  }
  if (historyRootValue || inputValues.length > 1) {
    const historyRoot = historyRootValue ? path.resolve(historyRootValue) : null;
    const inputs = historyRoot ? await discoverHistoryInputs(historyRoot) : inputValues.map((input) => path.resolve(input));
    const output = path.resolve(
      argValue(argv, "--output") ?? path.join(historyRoot ?? path.dirname(inputs[0]!), "analysis"),
    );
    await writeDataAgentBenchHistory(inputs, output);
    return;
  }
  const input = path.resolve(inputValues[0]!);
  const output = path.resolve(argValue(argv, "--output") ?? path.join(input, "analysis"));
  await writeDataAgentBenchReport(input, output);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
