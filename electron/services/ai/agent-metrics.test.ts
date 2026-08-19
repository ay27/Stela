import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  __resetForTests,
  addEvent,
  clear,
  finishRun,
  getDashboard,
  getRunTree,
  getSessionTrace,
  getTrace,
  listRuns,
  open,
  startRun,
} from "./agent-metrics";
import type { AgentMetricSurface } from "@shared/types";

const root = await mkdtemp(join(tmpdir(), "stela-agent-metrics-"));
try {
  await open(root);
  startRun({
    runId: "agent-1",
    surface: "agent",
    operation: "chat",
    startedAt: Date.now() - 200,
    model: "test-model",
    request: { prompt: "find orders", apiKey: "secret-value" },
  });
  startRun({
    runId: "tool-1",
    parentRunId: "agent-1",
    surface: "tool",
    operation: "run_sql",
    startedAt: Date.now() - 150,
    request: { sql: "select * from demo.orders", authorization: "Bearer secret" },
  });
  addEvent("tool-1", { type: "tool_result", ok: true, durationMs: 25, payload: { rows: 2 } });
  finishRun("tool-1", { status: "completed", endedAt: Date.now() - 100 });
  finishRun("agent-1", {
    status: "completed",
    endedAt: Date.now(),
    inputTokens: 12,
    outputTokens: 5,
    cacheReadTokens: 7,
    response: { text: "done" },
  });

  addEvent("agent-1", {
    type: "skill_candidate",
    name: "orders-metric",
    payload: { category: "metric-definition", source: "prompt" },
  });
  addEvent("agent-1", {
    type: "skill_candidate",
    name: "orders-metric",
    payload: { category: "metric-definition", source: "search" },
  });
  addEvent("agent-1", {
    type: "skill_loaded",
    name: "orders-metric",
    payload: { category: "metric-definition", source: "load" },
  });
  addEvent("agent-1", {
    type: "skill_loaded",
    name: "orders-metric",
    payload: { category: "metric-definition", source: "load" },
  });

  const maintenanceStartedAt = Date.now() - 75;
  startRun({
    runId: "maintenance-1",
    parentRunId: "agent-1",
    surface: "skill_maintenance",
    operation: "post_run_create",
    startedAt: maintenanceStartedAt,
  });
  addEvent("maintenance-1", {
    type: "skill_action",
    name: "orders-metric",
    payload: { action: "saved", name: "orders-metric", category: "metric-definition" },
  });
  finishRun("maintenance-1", { status: "completed", outcome: "saved" });

  const dashboard = getDashboard("7d");
  assert.equal(dashboard.latestKnowledgeMaintenanceAt, maintenanceStartedAt);
  assert.equal(dashboard.overview.total, 1);
  assert.equal(dashboard.usage.cacheReadTokens, 7);
  assert.equal(dashboard.usage.promptTokens, 19);
  assert.equal(dashboard.usage.cacheHitRate, 7 / 19);
  assert.equal(dashboard.surfaces.find((item) => item.key === "agent")?.cacheHitRate, 7 / 19);
  assert.equal(dashboard.tools[0]?.key, "run_sql");
  assert.equal(dashboard.tools[0]?.completed, 1);
  assert.deepEqual(dashboard.skillUsage, {
    matchedRuns: 1,
    usedRuns: 1,
    loadCount: 2,
    usageRate: 1,
    items: [{
      name: "orders-metric",
      category: "metric-definition",
      matchedRuns: 1,
      usedRuns: 1,
      loadCount: 2,
      usageRate: 1,
    }],
  });
  assert.deepEqual(dashboard.knowledgeCategories, [
    { category: "metric-definition", count: 1, share: 1 },
  ]);

  startRun({
    runId: "legacy-no-source",
    parentRunId: "agent-1",
    surface: "skill_maintenance",
    operation: "post_run_create",
    startedAt: maintenanceStartedAt - 10,
    request: { evidence: [{ type: "tool_result" }] },
  });
  finishRun("legacy-no-source", { status: "completed", outcome: "no_source" });
  assert.equal(
    (getTrace("legacy-no-source").response as { reasonCode: string }).reasonCode,
    "legacy_no_source",
  );

  const trace = getTrace("agent-1");
  assert.equal((trace.request as { apiKey: string }).apiKey, "***redacted***");
  assert.equal((trace.response as { text: string }).text, "done");

  startRun({
    runId: "agent:session-run-1",
    surface: "agent",
    operation: "chat",
    startedAt: Date.now() - 90,
  });
  addEvent("agent:session-run-1", {
    type: "assistant_message",
    name: "step:1",
    payload: { role: "assistant", content: [{ type: "text", text: "answer" }] },
  });
  startRun({
    runId: "tool:session-run-1:call-1",
    parentRunId: "agent:session-run-1",
    surface: "tool",
    operation: "run_sql",
    startedAt: Date.now() - 80,
  });
  finishRun("tool:session-run-1:call-1", { status: "completed", endedAt: Date.now() - 60 });
  finishRun("agent:session-run-1", {
    status: "completed",
    endedAt: Date.now() - 50,
    inputTokens: 5,
    outputTokens: 3,
    cacheReadTokens: 7,
  });
  const runTree = getRunTree("agent:session-run-1");
  assert.equal(runTree.root.run.surface, "agent");
  assert.deepEqual(runTree.descendants.map((item) => item.run.operation), ["run_sql"]);
  const sessionTrace = getSessionTrace({
    summary: {
      sessionId: "sess-1",
      deviceSlug: "test-device",
      title: "Session trace",
      createdAt: Date.now() - 100,
      updatedAt: Date.now(),
      isLocal: true,
    },
    runs: [
      {
        request: { runId: "session-run-1", sessionId: "sess-1", prompt: "question" },
        startedAt: Date.now() - 100,
        finishedAt: Date.now() - 50,
        events: [],
        proposalResponses: [],
      },
      {
        request: { runId: "missing-run", sessionId: "sess-1", prompt: "older history" },
        startedAt: Date.now() - 40,
        finishedAt: Date.now() - 30,
        events: [],
        proposalResponses: [],
      },
    ],
  });
  assert.equal(sessionTrace.turns.length, 2);
  assert.equal(sessionTrace.turns[0]?.trace?.descendants.length, 1);
  assert.equal(sessionTrace.turns[1]?.trace, null);
  assert.equal(sessionTrace.totals.modelStepCount, 1);
  assert.equal(sessionTrace.totals.toolCallCount, 1);
  assert.equal(sessionTrace.totals.promptTokens, 12);
  assert.equal(sessionTrace.totals.cacheHitRate, 7 / 12);

  startRun({ runId: "large-trace", surface: "ai_action", operation: "debug", request: "x".repeat(300_000) });
  finishRun("large-trace", { status: "completed" });
  assert.equal(getTrace("large-trace").run.traceTruncated, true);

  const page = listRuns({ range: "7d", limit: 3 });
  assert.equal(page.runs.length, 3);
  assert.ok(page.nextCursor);
  const next = listRuns({ range: "7d", limit: 3, cursor: page.nextCursor! });
  assert.equal(next.runs.length, 3);
  assert.ok(next.nextCursor);
  const last = listRuns({ range: "7d", limit: 3, cursor: next.nextCursor! });
  assert.equal(last.runs.length, 1);
  assert.equal(last.nextCursor, null);

  startRun({
    runId: "maintenance-disabled",
    surface: "skill_maintenance",
    operation: "post_run_create",
    startedAt: maintenanceStartedAt + 10,
  });
  finishRun("maintenance-disabled", { status: "completed", outcome: "disabled" });
  startRun({
    runId: "maintenance-dropped",
    surface: "skill_maintenance",
    operation: "post_run_create",
    startedAt: maintenanceStartedAt + 20,
  });
  finishRun("maintenance-dropped", { status: "dropped", outcome: "dropped" });
  assert.equal(getDashboard("7d").latestKnowledgeMaintenanceAt, maintenanceStartedAt);

  const manualMaintenanceStartedAt = maintenanceStartedAt + 30;
  startRun({
    runId: "manual-maintenance",
    surface: "agent",
    operation: "knowledge-maintenance",
    startedAt: manualMaintenanceStartedAt,
  });
  finishRun("manual-maintenance", { status: "completed", outcome: "no_change" });
  assert.equal(getDashboard("7d").latestKnowledgeMaintenanceAt, manualMaintenanceStartedAt);

  startRun({
    runId: "too-old",
    surface: "agent",
    operation: "chat",
    startedAt: Date.now() - 91 * 24 * 60 * 60 * 1_000,
  });
  finishRun("too-old", { status: "completed" });
  startRun({ runId: "interrupted", surface: "agent", operation: "chat" });
  startRun({
    runId: "legacy-inline",
    surface: "inline_completion" as AgentMetricSurface,
    operation: "sql_inline",
  });
  finishRun("legacy-inline", { status: "completed" });
  __resetForTests();
  const legacyDb = new Database(join(root, ".stela", "agent-metrics.local.sqlite"));
  legacyDb.pragma("user_version = 1");
  legacyDb.close();
  await open(root);
  assert.throws(() => getTrace("too-old"), /not found/i);
  assert.throws(() => getTrace("legacy-inline"), /not found/i);
  assert.equal(getTrace("interrupted").run.outcome, "interrupted");
  assert.equal(getTrace("interrupted").run.status, "cancelled");

  clear();
  assert.equal(getDashboard("90d").overview.total, 0);
  assert.equal(getDashboard("90d").latestKnowledgeMaintenanceAt, null);
} finally {
  __resetForTests();
  await rm(root, { recursive: true, force: true });
}
