import type { AssistantMessage, Model, Models, TextContent } from "@earendil-works/pi-ai";

export const STRATEGY_CHECKPOINT_ENTRY = "analysis_strategy_checkpoint";
export const QUERY_FAMILY_HINT_THRESHOLD = 4;
export const QUERY_FAMILY_REVIEW_THRESHOLD = 8;
export const QUERY_CHURN_REVIEW_THRESHOLD = 20;
export const FAILURE_WINDOW_SIZE = 8;
export const FAILURE_REVIEW_THRESHOLD = 3;
const RECENT_OBSERVATION_LIMIT = 12;
const INPUT_SUMMARY_LIMIT = 1_200;
const RESULT_SUMMARY_LIMIT = 600;
const REVIEW_TEXT_LIMIT = 1_200;
const DEFAULT_AVOIDANCE_GUIDANCE = "No additional approach-specific restriction.";

export type StrategyReviewTrigger = "query_family_fanout" | "query_churn" | "failure_cluster";

export interface AnalysisEfficiencyObservation {
  index: number;
  toolName: string;
  target: string;
  family: string | null;
  input: string;
  result: string;
  isError: boolean;
  isEmpty: boolean;
}

export interface AnalysisEfficiencySignal {
  hint: string | null;
  reviewTrigger: StrategyReviewTrigger | null;
  familyCount: number;
  runQueryCallsSinceProgress: number;
}

export interface AnalysisEfficiencyMetrics {
  queryFamilyPeak: number;
  strategyHints: number;
  reviewTriggered: boolean;
  reviewTrigger: StrategyReviewTrigger | null;
  runQueryCallsAtReview: number | null;
  postReviewRunQueryCalls: number;
  reviewStatus: "not_triggered" | "running" | "completed" | "failed";
}

export interface StrategyReviewAdvice {
  assessment: "continue" | "change";
  diagnosis: string;
  nextActions: string[];
  avoid: string;
  successCondition: string;
}

export interface AgentStrategyCheckpoint {
  runId: string;
  version: number;
  trigger: StrategyReviewTrigger;
  createdAt: number;
  metrics: AnalysisEfficiencyMetrics;
  advice: StrategyReviewAdvice;
}

export interface StrategyReviewInput {
  runId: string;
  goal: string;
  plan: string;
  capabilities: string;
  trigger: StrategyReviewTrigger;
  metrics: AnalysisEfficiencyMetrics;
  observations: AnalysisEfficiencyObservation[];
}

export interface StrategyReviewRunResult {
  checkpoint: AgentStrategyCheckpoint;
  message: AssistantMessage;
}

export class StrategyReviewResponseError extends Error {
  readonly response: AssistantMessage;

  constructor(message: string, response: AssistantMessage, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "StrategyReviewResponseError";
    this.response = response;
  }
}

export function strategyReviewResponseFromError(error: unknown): AssistantMessage | null {
  return error instanceof StrategyReviewResponseError ? error.response : null;
}

export const STRATEGY_REVIEW_SYSTEM_PROMPT = [
  "You are Stela's bounded data-analysis strategy reviewer.",
  "Do not answer the user's data question and do not request tools.",
  "Diagnose whether the main agent is making progress or repeating one strategy with different literals, offsets, ids, or minor query rewrites.",
  "Prefer set-based database queries, database aggregation, one complete query artifact plus execute_python, and batched filters over row-by-row probes.",
  "Return exactly one JSON object with assessment ('continue' or 'change'), diagnosis, nextActions (1-3 concise strings), avoid, and successCondition.",
].join("\n");

const DATA_ANALYSIS_TOOLS = new Set([
  "list_databases",
  "list_tables",
  "search_tables",
  "get_table_schema",
  "run_query",
  "execute_python",
]);

function truncate(value: string, limit: number): string {
  const compact = value.trim();
  return compact.length <= limit ? compact : `${compact.slice(0, limit)}…`;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]),
  );
}

function stringify(value: unknown, limit: number): string {
  try {
    return truncate(JSON.stringify(stableValue(value)), limit);
  } catch {
    return truncate(String(value), limit);
  }
}

function normalizeSqlFamily(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\r\n]*/g, " ")
    .replace(/\$[A-Za-z_][A-Za-z0-9_]*\$[\s\S]*?\$[A-Za-z_][A-Za-z0-9_]*\$/g, " ? ")
    .replace(/'(?:''|[^'])*'/g, " ? ")
    .replace(/\b\d+(?:\.\d+)?\b/g, " ? ")
    .replace(/\?(?:\s*,\s*\?)+/g, "?list")
    .replace(/\s+/g, " ")
    .replace(/\s*([=<>+*/(),-])\s*/g, "$1")
    .trim()
    .toLowerCase();
}

function mongoShape(value: unknown, preserveArray = false): unknown {
  if (Array.isArray(value)) {
    if (preserveArray) return value.map((item) => mongoShape(item));
    if (value.length === 0) return [];
    return [mongoShape(value[0])];
  }
  if (!value || typeof value !== "object") return value === null ? null : "?";
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, mongoShape(nested, key === "pipeline")]),
  );
}

export function queryFamily(input: Record<string, unknown>): string | null {
  if (input.language === "sql" && typeof input.query === "string") {
    return stringify({
      language: "sql",
      database: input.database ?? null,
      query: normalizeSqlFamily(input.query),
    }, 8_000);
  }
  if (input.language === "mongodb") {
    return stringify({
      language: "mongodb",
      database: input.database ?? null,
      collection: input.collection ?? null,
      operation: input.operation ?? "find",
      shape: mongoShape({
        filter: input.filter,
        projection: input.projection,
        pipeline: input.pipeline,
      }),
    }, 8_000);
  }
  return null;
}

function targetFor(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "run_query") {
    const collection = typeof input.collection === "string" ? `.${input.collection}` : "";
    return `${String(input.connectionName ?? "current")}:${String(input.database ?? "default")}${collection}`;
  }
  if (toolName === "get_table_schema") return stringify(input.tables ?? input, 240);
  if (toolName === "list_tables") return String(input.database ?? "default");
  return toolName;
}

function textContent(content: Array<TextContent | { type: string; [key: string]: unknown }>): string {
  return content
    .flatMap((block) => block.type === "text" && typeof block.text === "string" ? [block.text] : [])
    .join("\n");
}

function resultIsEmpty(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const result = parsed.result && typeof parsed.result === "object"
      ? parsed.result as Record<string, unknown>
      : parsed;
    if (result.rowCount === 0) return true;
    if (Array.isArray(result.rows) && result.rows.length === 0) return true;
    if (Array.isArray(parsed.databases) && parsed.databases.length === 0) return true;
    if (Array.isArray(parsed.tables) && parsed.tables.length === 0) return true;
  } catch {
    return false;
  }
  return false;
}

export class AnalysisEfficiencyLedger {
  private readonly familyCounts = new Map<string, number>();
  private readonly observations: AnalysisEfficiencyObservation[] = [];
  private runQueryCallsSinceProgress = 0;
  private churnWindowStart = 0;
  private queryFamilyPeak = 0;
  private strategyHints = 0;
  private reviewTrigger: StrategyReviewTrigger | null = null;
  private runQueryCallsAtReview: number | null = null;
  private reviewStatus: AnalysisEfficiencyMetrics["reviewStatus"] = "not_triggered";

  constructor(private readonly options: { advisoriesEnabled?: boolean } = {}) {}

  recordResult(input: {
    toolName: string;
    args: Record<string, unknown>;
    content: Array<TextContent | { type: string; [key: string]: unknown }>;
    isError: boolean;
  }): AnalysisEfficiencySignal {
    if (input.toolName === "update_plan" && !input.isError) this.markProgress();
    if (input.toolName === "execute_python" && !input.isError) this.markProgress();
    if (!DATA_ANALYSIS_TOOLS.has(input.toolName)) {
      return this.signal(null, null, 0);
    }

    const result = textContent(input.content);
    const family = input.toolName === "run_query" ? queryFamily(input.args) : null;
    let familyCount = 0;
    if (input.toolName === "run_query") {
      this.runQueryCallsSinceProgress += 1;
      if (family) {
        familyCount = (this.familyCounts.get(family) ?? 0) + 1;
        this.familyCounts.set(family, familyCount);
        this.queryFamilyPeak = Math.max(this.queryFamilyPeak, familyCount);
      }
    }
    const observation: AnalysisEfficiencyObservation = {
      index: this.observations.length + 1,
      toolName: input.toolName,
      target: targetFor(input.toolName, input.args),
      family,
      input: stringify(input.args, INPUT_SUMMARY_LIMIT),
      result: truncate(result, RESULT_SUMMARY_LIMIT),
      isError: input.isError,
      isEmpty: !input.isError && resultIsEmpty(result),
    };
    this.observations.push(observation);

    let hint: string | null = null;
    if (this.options.advisoriesEnabled !== false && familyCount === QUERY_FAMILY_HINT_THRESHOLD) {
      this.strategyHints += 1;
      hint = "Efficiency hint: this is the fourth query in the same structural family. Prefer one set-based query, aggregate, batched filter, or a complete artifact plus execute_python instead of changing one literal at a time.";
    }

    let trigger: StrategyReviewTrigger | null = null;
    if (this.options.advisoriesEnabled !== false && !this.reviewTrigger) {
      const failures = this.observations
        .slice(this.churnWindowStart)
        .slice(-FAILURE_WINDOW_SIZE)
        .filter((item) => item.isError || item.isEmpty).length;
      if (failures >= FAILURE_REVIEW_THRESHOLD) trigger = "failure_cluster";
      else if (familyCount >= QUERY_FAMILY_REVIEW_THRESHOLD) trigger = "query_family_fanout";
      else if (this.runQueryCallsSinceProgress >= QUERY_CHURN_REVIEW_THRESHOLD) trigger = "query_churn";
      if (trigger) {
        this.reviewTrigger = trigger;
        this.runQueryCallsAtReview = this.totalRunQueries();
        this.reviewStatus = "running";
      }
    }
    return this.signal(hint, trigger, familyCount);
  }

  markProgress(): void {
    this.runQueryCallsSinceProgress = 0;
    this.familyCounts.clear();
    this.churnWindowStart = this.observations.length;
  }

  markReviewCompleted(): void {
    if (this.reviewTrigger) this.reviewStatus = "completed";
  }

  markReviewFailed(): void {
    if (this.reviewTrigger) this.reviewStatus = "failed";
  }

  recent(limit = RECENT_OBSERVATION_LIMIT): AnalysisEfficiencyObservation[] {
    return this.observations.slice(-limit).map((item) => ({ ...item }));
  }

  metrics(): AnalysisEfficiencyMetrics {
    const total = this.totalRunQueries();
    return {
      queryFamilyPeak: this.queryFamilyPeak,
      strategyHints: this.strategyHints,
      reviewTriggered: this.reviewTrigger !== null,
      reviewTrigger: this.reviewTrigger,
      runQueryCallsAtReview: this.runQueryCallsAtReview,
      postReviewRunQueryCalls: this.runQueryCallsAtReview === null ? 0 : Math.max(0, total - this.runQueryCallsAtReview),
      reviewStatus: this.reviewStatus,
    };
  }

  private totalRunQueries(): number {
    return this.observations.filter((item) => item.toolName === "run_query").length;
  }

  private signal(
    hint: string | null,
    reviewTrigger: StrategyReviewTrigger | null,
    familyCount: number,
  ): AnalysisEfficiencySignal {
    return { hint, reviewTrigger, familyCount, runQueryCallsSinceProgress: this.runQueryCallsSinceProgress };
  }
}

function reviewUserPrompt(input: StrategyReviewInput): string {
  return [
    "<strategy_review_context>",
    `run_id: ${input.runId}`,
    `trigger: ${input.trigger}`,
    `goal: ${truncate(input.goal, 4_000)}`,
    `plan: ${truncate(input.plan, 4_000)}`,
    `capabilities: ${truncate(input.capabilities, 2_000)}`,
    `metrics: ${JSON.stringify(input.metrics)}`,
    `recent_observations: ${JSON.stringify(input.observations.slice(-RECENT_OBSERVATION_LIMIT))}`,
    "</strategy_review_context>",
  ].join("\n");
}

function jsonObject(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("Strategy reviewer did not return JSON.");
    return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
  }
}

export function parseStrategyReview(text: string): StrategyReviewAdvice {
  const value = jsonObject(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Strategy reviewer response must be an object.");
  }
  const record = value as Record<string, unknown>;
  const assessment = record.assessment;
  if (assessment !== "continue" && assessment !== "change") {
    throw new Error("Strategy reviewer assessment must be continue or change.");
  }
  const stringField = (name: string): string => {
    const field = record[name];
    if (typeof field !== "string" || !field.trim()) throw new Error(`Strategy reviewer ${name} is required.`);
    return truncate(field, REVIEW_TEXT_LIMIT);
  };
  if (!Array.isArray(record.nextActions) || record.nextActions.length === 0) {
    throw new Error("Strategy reviewer nextActions is required.");
  }
  const nextActions = record.nextActions
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .slice(0, 3)
    .map((item) => truncate(item, REVIEW_TEXT_LIMIT));
  if (nextActions.length === 0) throw new Error("Strategy reviewer nextActions is required.");
  const avoid = typeof record.avoid === "string" && record.avoid.trim()
    ? truncate(record.avoid, REVIEW_TEXT_LIMIT)
    : DEFAULT_AVOIDANCE_GUIDANCE;
  return {
    assessment,
    diagnosis: stringField("diagnosis"),
    nextActions,
    avoid,
    successCondition: stringField("successCondition"),
  };
}

export async function runStrategyReview(input: {
  models: Models;
  model: Model;
  signal: AbortSignal;
  sessionId: string;
  review: StrategyReviewInput;
}): Promise<StrategyReviewRunResult> {
  const message = await input.models.completeSimple(
    input.model,
    {
      systemPrompt: STRATEGY_REVIEW_SYSTEM_PROMPT,
      messages: [{ role: "user", content: reviewUserPrompt(input.review), timestamp: Date.now() }],
    },
    {
      signal: input.signal,
      temperature: 0.1,
      maxTokens: 500,
      cacheRetention: "short",
      sessionId: input.sessionId,
    },
  );
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw new StrategyReviewResponseError(
      message.errorMessage ?? `Strategy reviewer ${message.stopReason}.`,
      message,
    );
  }
  const text = message.content
    .flatMap((block) => block.type === "text" ? [block.text] : [])
    .join("\n");
  let advice: StrategyReviewAdvice;
  try {
    advice = parseStrategyReview(text);
  } catch (error) {
    throw new StrategyReviewResponseError(
      error instanceof Error ? error.message : String(error),
      message,
      error,
    );
  }
  return {
    checkpoint: {
      runId: input.review.runId,
      version: 1,
      trigger: input.review.trigger,
      createdAt: Date.now(),
      metrics: input.review.metrics,
      advice,
    },
    message,
  };
}

export function formatStrategyCheckpoint(checkpoint: AgentStrategyCheckpoint): string {
  const actions = checkpoint.advice.nextActions.map((item, index) => `${index + 1}. ${item}`).join("\n");
  return [
    `Strategy review checkpoint for run ${checkpoint.runId} version ${checkpoint.version}.`,
    `Trigger: ${checkpoint.trigger}. Assessment: ${checkpoint.advice.assessment}.`,
    `Diagnosis: ${checkpoint.advice.diagnosis}`,
    "Next actions:",
    actions,
    `Avoid: ${checkpoint.advice.avoid}`,
    `Success condition: ${checkpoint.advice.successCondition}`,
    "This is advisory. If continuing the old strategy, state the new evidence that makes it productive.",
  ].join("\n");
}

export function efficiencyHintContent(hint: string): TextContent {
  return { type: "text", text: hint };
}
