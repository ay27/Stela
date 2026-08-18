import Database from "better-sqlite3";
import fs from "node:fs/promises";
import path from "node:path";

import { AppError } from "@shared/errors";
import type {
  AgentMetricBreakdown,
  AgentMetricEventRecord,
  AgentMetricRange,
  AgentMetricRunFilter,
  AgentMetricRunPage,
  AgentMetricRunTree,
  AgentMetricRunSummary,
  AgentMetricSessionTrace,
  AgentMetricStatus,
  AgentMetricSurface,
  AgentMetricTrace,
  AgentMetricsDashboard,
  AgentHistorySession,
} from "@shared/types";

import { vaultConfigDir } from "../vault-paths";
import { redactForPrompt } from "./redaction";

const FILE_NAME = "agent-metrics.local.sqlite";
const RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const PAYLOAD_LIMIT_CHARS = 256 * 1_024;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS metric_runs (
  run_id TEXT PRIMARY KEY,
  parent_run_id TEXT,
  surface TEXT NOT NULL,
  operation TEXT NOT NULL,
  status TEXT NOT NULL,
  outcome TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  duration_ms INTEGER,
  first_result_ms INTEGER,
  profile_id TEXT,
  vendor_id TEXT,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  request_json TEXT,
  response_json TEXT,
  trace_truncated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_metric_runs_started ON metric_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_metric_runs_surface_started ON metric_runs(surface, started_at DESC);

CREATE TABLE IF NOT EXISTS metric_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  duration_ms INTEGER,
  ok INTEGER,
  name TEXT,
  payload_json TEXT,
  truncated INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(run_id) REFERENCES metric_runs(run_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_metric_events_run ON metric_events(run_id, id);
`;

let current: { vaultPath: string; db: Database.Database; lastCleanupAt: number } | null = null;

export function isOpen(): boolean {
  return current !== null;
}

interface StoredPayload {
  json: string | null;
  truncated: boolean;
}

export interface StartAgentMetricRun {
  runId: string;
  parentRunId?: string | null;
  surface: AgentMetricSurface;
  operation: string;
  startedAt?: number;
  profileId?: string | null;
  vendorId?: string | null;
  model?: string | null;
  request?: unknown;
}

export interface FinishAgentMetricRun {
  status: Exclude<AgentMetricStatus, "running">;
  outcome?: string | null;
  endedAt?: number;
  firstResultMs?: number | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  response?: unknown;
}

export interface AddAgentMetricEvent {
  type: string;
  occurredAt?: number;
  durationMs?: number | null;
  ok?: boolean | null;
  name?: string | null;
  payload?: unknown;
}

function ensureOpen(): Database.Database {
  if (!current) throw new AppError("agent_metrics_not_open", "Agent metrics store is not open.");
  return current.db;
}

function storedPayload(value: unknown): StoredPayload {
  if (value === undefined) return { json: null, truncated: false };
  let json: string;
  try {
    json = JSON.stringify(redactForPrompt(value));
  } catch {
    json = JSON.stringify({ serializationError: true, value: String(value) });
  }
  if (json.length <= PAYLOAD_LIMIT_CHARS) return { json, truncated: false };
  return {
    json: JSON.stringify({ truncated: true, preview: json.slice(0, PAYLOAD_LIMIT_CHARS) }),
    truncated: true,
  };
}

function parsePayload(json: string | null): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return { parseError: true };
  }
}

function cleanupIfDue(now = Date.now()): void {
  if (!current || now - current.lastCleanupAt < 24 * 60 * 60 * 1_000) return;
  current.db.prepare("DELETE FROM metric_runs WHERE started_at < ?").run(now - RETENTION_MS);
  current.lastCleanupAt = now;
}

export async function open(vaultPath: string): Promise<void> {
  if (current?.vaultPath === vaultPath) return;
  close();
  await fs.mkdir(vaultConfigDir(vaultPath), { recursive: true });
  const db = new Database(path.join(vaultConfigDir(vaultPath), FILE_NAME));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  const schemaVersion = db.pragma("user_version", { simple: true }) as number;
  if (schemaVersion < 2) {
    db.exec(`
      DELETE FROM metric_runs WHERE surface = 'inline_completion';
      DROP INDEX IF EXISTS idx_metric_inline_disposition;
    `);
    db.pragma("user_version = 2");
  }
  const openedAt = Date.now();
  db.prepare(`
    UPDATE metric_runs SET
      status = 'cancelled', outcome = COALESCE(outcome, 'interrupted'),
      ended_at = ?, duration_ms = MAX(0, ? - started_at)
    WHERE status = 'running'
  `).run(openedAt, openedAt);
  current = { vaultPath, db, lastCleanupAt: 0 };
  cleanupIfDue();
}

export function close(): void {
  if (!current) return;
  current.db.close();
  current = null;
}

export function startRun(input: StartAgentMetricRun): void {
  cleanupIfDue(input.startedAt ?? Date.now());
  const request = storedPayload(input.request);
  ensureOpen().prepare(`
    INSERT OR IGNORE INTO metric_runs (
      run_id, parent_run_id, surface, operation, status, started_at,
      profile_id, vendor_id, model, request_json, trace_truncated
    ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)
  `).run(
    input.runId,
    input.parentRunId ?? null,
    input.surface,
    input.operation,
    input.startedAt ?? Date.now(),
    input.profileId ?? null,
    input.vendorId ?? null,
    input.model ?? null,
    request.json,
    request.truncated ? 1 : 0,
  );
}

export function finishRun(runId: string, input: FinishAgentMetricRun): void {
  const db = ensureOpen();
  const response = storedPayload(input.response);
  const endedAt = input.endedAt ?? Date.now();
  db.prepare(`
    UPDATE metric_runs SET
      status = ?, outcome = ?, ended_at = ?,
      duration_ms = MAX(0, ? - started_at), first_result_ms = COALESCE(?, first_result_ms),
      input_tokens = input_tokens + ?, output_tokens = output_tokens + ?,
      cache_read_tokens = cache_read_tokens + ?, cache_write_tokens = cache_write_tokens + ?,
      error_code = ?, error_message = ?, response_json = ?,
      trace_truncated = CASE WHEN trace_truncated = 1 OR ? = 1 THEN 1 ELSE 0 END
    WHERE run_id = ? AND status = 'running'
  `).run(
    input.status,
    input.outcome ?? null,
    endedAt,
    endedAt,
    input.firstResultMs ?? null,
    input.inputTokens ?? 0,
    input.outputTokens ?? 0,
    input.cacheReadTokens ?? 0,
    input.cacheWriteTokens ?? 0,
    input.errorCode ?? null,
    input.errorMessage ? redactForPrompt(input.errorMessage) : null,
    response.json,
    response.truncated ? 1 : 0,
    runId,
  );
}

export function addUsage(runId: string, usage: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}): void {
  ensureOpen().prepare(`
    UPDATE metric_runs SET
      input_tokens = input_tokens + ?, output_tokens = output_tokens + ?,
      cache_read_tokens = cache_read_tokens + ?, cache_write_tokens = cache_write_tokens + ?
    WHERE run_id = ?
  `).run(usage.input ?? 0, usage.output ?? 0, usage.cacheRead ?? 0, usage.cacheWrite ?? 0, runId);
}

export function setFirstResult(runId: string, elapsedMs: number): void {
  ensureOpen().prepare(`
    UPDATE metric_runs SET first_result_ms = COALESCE(first_result_ms, ?) WHERE run_id = ?
  `).run(Math.max(0, Math.floor(elapsedMs)), runId);
}

export function addEvent(runId: string, event: AddAgentMetricEvent): void {
  const payload = storedPayload(event.payload);
  ensureOpen().prepare(`
    INSERT INTO metric_events (
      run_id, event_type, occurred_at, duration_ms, ok, name, payload_json, truncated
    )
    SELECT run_id, ?, ?, ?, ?, ?, ?, ? FROM metric_runs WHERE run_id = ?
  `).run(
    event.type,
    event.occurredAt ?? Date.now(),
    event.durationMs ?? null,
    event.ok === undefined || event.ok === null ? null : event.ok ? 1 : 0,
    event.name ?? null,
    payload.json,
    payload.truncated ? 1 : 0,
    runId,
  );
}

interface RunRow {
  run_id: string;
  parent_run_id: string | null;
  surface: AgentMetricSurface;
  operation: string;
  status: AgentMetricStatus;
  outcome: string | null;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
  first_result_ms: number | null;
  profile_id: string | null;
  vendor_id: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  error_code: string | null;
  error_message: string | null;
  request_json: string | null;
  response_json: string | null;
  trace_truncated: number;
}

function runSummary(row: RunRow): AgentMetricRunSummary {
  return {
    runId: row.run_id,
    parentRunId: row.parent_run_id,
    surface: row.surface,
    operation: row.operation,
    status: row.status,
    outcome: row.outcome,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    firstResultMs: row.first_result_ms,
    profileId: row.profile_id,
    vendorId: row.vendor_id,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    traceTruncated: row.trace_truncated === 1,
  };
}

function rangeStart(range: AgentMetricRange, now = Date.now()): number {
  const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
  return now - days * 24 * 60 * 60 * 1_000;
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] ?? null;
}

function promptCacheHitRate(inputTokens: number, cacheReadTokens: number, cacheWriteTokens: number): number | null {
  const promptTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
  return promptTokens > 0 ? cacheReadTokens / promptTokens : null;
}

function breakdown(key: string, rows: RunRow[]): AgentMetricBreakdown {
  const durations = rows.flatMap((row) => row.duration_ms === null ? [] : [row.duration_ms]);
  const inputTokens = rows.reduce((sum, row) => sum + row.input_tokens, 0);
  const cacheReadTokens = rows.reduce((sum, row) => sum + row.cache_read_tokens, 0);
  const cacheWriteTokens = rows.reduce((sum, row) => sum + row.cache_write_tokens, 0);
  return {
    key,
    total: rows.length,
    completed: rows.filter((row) => row.status === "completed").length,
    errors: rows.filter((row) => row.status === "error" || row.status === "timeout").length,
    cancelled: rows.filter((row) => row.status === "cancelled" || row.status === "dropped").length,
    p50DurationMs: percentile(durations, 0.5),
    p95DurationMs: percentile(durations, 0.95),
    inputTokens,
    outputTokens: rows.reduce((sum, row) => sum + row.output_tokens, 0),
    cacheReadTokens,
    cacheWriteTokens,
    cacheHitRate: promptCacheHitRate(inputTokens, cacheReadTokens, cacheWriteTokens),
  };
}

function groups(rows: RunRow[], key: (row: RunRow) => string): AgentMetricBreakdown[] {
  const grouped = new Map<string, RunRow[]>();
  for (const row of rows) grouped.set(key(row), [...(grouped.get(key(row)) ?? []), row]);
  return [...grouped.entries()]
    .map(([groupKey, groupRows]) => breakdown(groupKey, groupRows))
    .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
}

function localDay(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getDashboard(range: AgentMetricRange): AgentMetricsDashboard {
  cleanupIfDue();
  const db = ensureOpen();
  const rows = db.prepare("SELECT * FROM metric_runs WHERE started_at >= ? ORDER BY started_at DESC")
    .all(rangeStart(range)) as RunRow[];
  const rootRuns = rows.filter((row) => row.parent_run_id === null);
  const nonToolRuns = rows.filter((row) => row.surface !== "tool");
  // Strategy-review usage is also charged to its root Agent run so overview and
  // per-turn totals stay complete. Keep the child run for diagnosis, but do not
  // count its tokens a second time in aggregate usage.
  const usageRuns = nonToolRuns.filter((row) => row.surface !== "strategy_review");
  const knowledge = rows.filter((row) => row.surface === "skill_maintenance");
  const outcomeMap = new Map<string, number>();
  for (const row of knowledge) {
    const key = row.outcome ?? row.status;
    outcomeMap.set(key, (outcomeMap.get(key) ?? 0) + 1);
  }
  const categoryRows = db.prepare(`
    SELECT e.payload_json
    FROM metric_events e
    JOIN metric_runs r ON r.run_id = e.run_id
    WHERE r.started_at >= ? AND r.surface = 'skill_maintenance'
      AND e.event_type = 'skill_action'
  `).all(rangeStart(range)) as Array<{ payload_json: string | null }>;
  const categoryMap = new Map<string, number>();
  for (const row of categoryRows) {
    const payload = parsePayload(row.payload_json);
    if (!payload || typeof payload !== "object") continue;
    const action = "action" in payload ? payload.action : null;
    const category = "category" in payload ? payload.category : null;
    if (action !== "saved" || typeof category !== "string" || !category) continue;
    categoryMap.set(category, (categoryMap.get(category) ?? 0) + 1);
  }
  const savedSkillCount = [...categoryMap.values()].reduce((sum, count) => sum + count, 0);
  const skillRows = db.prepare(`
    SELECT e.run_id, e.event_type, e.name, e.payload_json
    FROM metric_events e
    JOIN metric_runs r ON r.run_id = e.run_id
    WHERE r.started_at >= ? AND r.surface = 'agent'
      AND e.event_type IN ('skill_candidate', 'skill_loaded')
  `).all(rangeStart(range)) as Array<{
    run_id: string;
    event_type: "skill_candidate" | "skill_loaded";
    name: string | null;
    payload_json: string | null;
  }>;
  const skillMap = new Map<string, {
    category: string | null;
    matchedRunIds: Set<string>;
    usedRunIds: Set<string>;
    loadCount: number;
  }>();
  for (const row of skillRows) {
    if (!row.name) continue;
    const payload = parsePayload(row.payload_json);
    const category = payload && typeof payload === "object" && "category" in payload && typeof payload.category === "string"
      ? payload.category
      : null;
    const item = skillMap.get(row.name) ?? {
      category,
      matchedRunIds: new Set<string>(),
      usedRunIds: new Set<string>(),
      loadCount: 0,
    };
    if (!item.category && category) item.category = category;
    item.matchedRunIds.add(row.run_id);
    if (row.event_type === "skill_loaded") {
      item.usedRunIds.add(row.run_id);
      item.loadCount += 1;
    }
    skillMap.set(row.name, item);
  }
  const skillItems = [...skillMap.entries()]
    .map(([name, item]) => ({
      name,
      category: item.category,
      matchedRuns: item.matchedRunIds.size,
      usedRuns: item.usedRunIds.size,
      loadCount: item.loadCount,
      usageRate: item.matchedRunIds.size > 0 ? item.usedRunIds.size / item.matchedRunIds.size : 0,
    }))
    .sort((a, b) => b.usedRuns - a.usedRuns || b.matchedRuns - a.matchedRuns || a.name.localeCompare(b.name));
  const matchedSkillRuns = skillItems.reduce((sum, item) => sum + item.matchedRuns, 0);
  const usedSkillRuns = skillItems.reduce((sum, item) => sum + item.usedRuns, 0);
  const skillLoadCount = skillItems.reduce((sum, item) => sum + item.loadCount, 0);
  const dailyGroups = new Map<string, RunRow[]>();
  for (const row of rootRuns) {
    const day = localDay(row.started_at);
    dailyGroups.set(day, [...(dailyGroups.get(day) ?? []), row]);
  }
  const inputTokens = usageRuns.reduce((sum, row) => sum + row.input_tokens, 0);
  const outputTokens = usageRuns.reduce((sum, row) => sum + row.output_tokens, 0);
  const cacheReadTokens = usageRuns.reduce((sum, row) => sum + row.cache_read_tokens, 0);
  const cacheWriteTokens = usageRuns.reduce((sum, row) => sum + row.cache_write_tokens, 0);
  const promptTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
  return {
    range,
    generatedAt: Date.now(),
    overview: breakdown("all", rootRuns),
    usage: {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      promptTokens,
      cacheHitRate: promptCacheHitRate(inputTokens, cacheReadTokens, cacheWriteTokens),
    },
    surfaces: groups(nonToolRuns, (row) => row.surface),
    tools: groups(rows.filter((row) => row.surface === "tool"), (row) => row.operation),
    knowledgeOutcomes: [...outcomeMap.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
    knowledgeCategories: [...categoryMap.entries()]
      .map(([category, count]) => ({
        category,
        count,
        share: savedSkillCount > 0 ? count / savedSkillCount : 0,
      }))
      .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category)),
    skillUsage: {
      matchedRuns: matchedSkillRuns,
      usedRuns: usedSkillRuns,
      loadCount: skillLoadCount,
      usageRate: matchedSkillRuns > 0 ? usedSkillRuns / matchedSkillRuns : null,
      items: skillItems,
    },
    daily: [...dailyGroups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, dayRows]) => {
        const item = breakdown(day, dayRows);
        return {
          day,
          total: item.total,
          completed: item.completed,
          errors: item.errors,
          cancelled: item.cancelled,
          durationMs: dayRows.reduce((sum, row) => sum + (row.duration_ms ?? 0), 0),
        };
      }),
  };
}

export function listRuns(filter: AgentMetricRunFilter): AgentMetricRunPage {
  const limit = Math.max(1, Math.min(filter.limit ?? 50, 100));
  const params: Array<string | number> = [rangeStart(filter.range)];
  const clauses = ["started_at >= ?", "surface <> 'inline_completion'"];
  if (filter.surface) {
    clauses.push("surface = ?");
    params.push(filter.surface);
  }
  if (filter.status) {
    clauses.push("status = ?");
    params.push(filter.status);
  }
  if (filter.cursor) {
    const separator = filter.cursor.indexOf(":");
    const timestamp = Number(filter.cursor.slice(0, separator));
    const runId = filter.cursor.slice(separator + 1);
    clauses.push("(started_at < ? OR (started_at = ? AND run_id < ?))");
    params.push(timestamp, timestamp, runId);
  }
  params.push(limit + 1);
  const rows = ensureOpen().prepare(`
    SELECT * FROM metric_runs WHERE ${clauses.join(" AND ")}
    ORDER BY started_at DESC, run_id DESC LIMIT ?
  `).all(...params) as RunRow[];
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    runs: page.map(runSummary),
    nextCursor: rows.length > limit && last ? `${last.started_at}:${last.run_id}` : null,
  };
}

function traceFromRow(db: Database.Database, row: RunRow): AgentMetricTrace {
  const events = db.prepare("SELECT * FROM metric_events WHERE run_id = ? ORDER BY id")
    .all(row.run_id) as Array<{
      id: number; run_id: string; event_type: string; occurred_at: number;
      duration_ms: number | null; ok: number | null; name: string | null;
      payload_json: string | null; truncated: number;
    }>;
  const request = parsePayload(row.request_json);
  const storedResponse = parsePayload(row.response_json);
  const response = storedResponse === null && row.surface === "skill_maintenance" && row.outcome === "no_source"
    ? {
        reasonCode: "legacy_no_source",
        message: "No verified Vault Markdown source documents were available, so the maintenance model was not called.",
        detail: "This record predates detailed skip diagnostics; its request still shows the captured maintenance evidence.",
      }
    : storedResponse;
  return {
    run: runSummary(row),
    request,
    response,
    events: events.map((event): AgentMetricEventRecord => ({
      id: event.id,
      runId: event.run_id,
      type: event.event_type,
      occurredAt: event.occurred_at,
      durationMs: event.duration_ms,
      ok: event.ok === null ? null : event.ok === 1,
      name: event.name,
      payload: parsePayload(event.payload_json),
      truncated: event.truncated === 1,
    })),
  };
}

export function getTrace(runId: string): AgentMetricTrace {
  const db = ensureOpen();
  const row = db.prepare("SELECT * FROM metric_runs WHERE run_id = ?").get(runId) as RunRow | undefined;
  if (!row) throw new AppError("agent_metric_not_found", `Agent metric run not found: ${runId}`);
  return traceFromRow(db, row);
}

export function getRunTree(runId: string): AgentMetricRunTree {
  const db = ensureOpen();
  const rows = db.prepare(`
    WITH RECURSIVE run_tree(run_id) AS (
      SELECT run_id FROM metric_runs WHERE run_id = ?
      UNION ALL
      SELECT child.run_id
      FROM metric_runs child
      JOIN run_tree parent ON child.parent_run_id = parent.run_id
    )
    SELECT runs.*
    FROM metric_runs runs
    JOIN run_tree ON run_tree.run_id = runs.run_id
    ORDER BY runs.started_at, runs.run_id
  `).all(runId) as RunRow[];
  const root = rows.find((row) => row.run_id === runId);
  if (!root) throw new AppError("agent_metric_not_found", `Agent metric run not found: ${runId}`);
  return {
    root: traceFromRow(db, root),
    descendants: rows
      .filter((row) => row.run_id !== runId)
      .map((row) => traceFromRow(db, row)),
  };
}

export function getSessionTrace(history: AgentHistorySession): AgentMetricSessionTrace {
  const turns = history.runs.map((run, index) => {
    let trace: AgentMetricRunTree | null = null;
    try {
      trace = getRunTree(`agent:${run.request.runId}`);
    } catch (err) {
      if (!(err instanceof AppError) || err.code !== "agent_metric_not_found") throw err;
    }
    return { index: index + 1, history: run, trace };
  });
  const trees = turns.flatMap((turn) => turn.trace ? [turn.trace] : []);
  const modelRuns = trees.flatMap((tree) => [tree.root, ...tree.descendants])
    .filter((trace) => trace.run.surface !== "tool" && trace.run.surface !== "strategy_review");
  const inputTokens = modelRuns.reduce((sum, trace) => sum + trace.run.inputTokens, 0);
  const outputTokens = modelRuns.reduce((sum, trace) => sum + trace.run.outputTokens, 0);
  const cacheReadTokens = modelRuns.reduce((sum, trace) => sum + trace.run.cacheReadTokens, 0);
  const cacheWriteTokens = modelRuns.reduce((sum, trace) => sum + trace.run.cacheWriteTokens, 0);
  const promptTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
  return {
    history,
    totals: {
      turnCount: history.runs.length,
      modelStepCount: trees.reduce(
        (sum, tree) => sum + tree.root.events.filter((event) => event.type === "assistant_message").length,
        0,
      ),
      toolCallCount: trees.reduce(
        (sum, tree) => sum + tree.descendants.filter((trace) => trace.run.surface === "tool").length,
        0,
      ),
      durationMs: trees.reduce((sum, tree) => sum + (tree.root.run.durationMs ?? 0), 0),
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      promptTokens,
      cacheHitRate: promptTokens > 0 ? cacheReadTokens / promptTokens : null,
    },
    turns,
  };
}

export function clear(): void {
  const db = ensureOpen();
  db.exec("DELETE FROM metric_runs; VACUUM;");
}

export function __resetForTests(): void {
  close();
}
