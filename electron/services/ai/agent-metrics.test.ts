import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  __resetForTests,
  addEvent,
  clear,
  finishRun,
  getDashboard,
  getTrace,
  listRuns,
  open,
  recordInlineDisposition,
  startRun,
} from "./agent-metrics";

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

  startRun({
    runId: "inline-1",
    surface: "inline_completion",
    operation: "sql_inline",
    request: { prefix: "select " },
  });
  finishRun("inline-1", { status: "completed", firstResultMs: 40 });
  recordInlineDisposition({ requestId: "inline-1", outcome: "shown", suggestedChars: 8 });
  recordInlineDisposition({ requestId: "inline-1", outcome: "shown", suggestedChars: 8 });
  recordInlineDisposition({ requestId: "inline-1", outcome: "accepted", visibleMs: 20 });

  startRun({
    runId: "maintenance-1",
    parentRunId: "agent-1",
    surface: "skill_maintenance",
    operation: "post_run_create",
  });
  addEvent("maintenance-1", {
    type: "skill_action",
    name: "orders-metric",
    payload: { action: "saved", name: "orders-metric", category: "metric-definition" },
  });
  finishRun("maintenance-1", { status: "completed", outcome: "saved" });

  const dashboard = getDashboard("7d");
  assert.equal(dashboard.overview.total, 2);
  assert.equal(dashboard.usage.cacheReadTokens, 7);
  assert.equal(dashboard.tools[0]?.key, "run_sql");
  assert.equal(dashboard.tools[0]?.completed, 1);
  assert.equal(dashboard.completion.shown, 1);
  assert.equal(dashboard.completion.accepted, 1);
  assert.equal(dashboard.completion.acceptanceRate, 1);
  assert.deepEqual(dashboard.knowledgeCategories, [
    { category: "metric-definition", count: 1, share: 1 },
  ]);

  startRun({
    runId: "legacy-no-source",
    parentRunId: "agent-1",
    surface: "skill_maintenance",
    operation: "post_run_create",
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

  startRun({ runId: "large-trace", surface: "ai_action", operation: "debug", request: "x".repeat(300_000) });
  finishRun("large-trace", { status: "completed" });
  assert.equal(getTrace("large-trace").run.traceTruncated, true);

  const page = listRuns({ range: "7d", limit: 3 });
  assert.equal(page.runs.length, 3);
  assert.ok(page.nextCursor);
  const next = listRuns({ range: "7d", limit: 3, cursor: page.nextCursor! });
  assert.equal(next.runs.length, 3);
  assert.equal(next.nextCursor, null);

  startRun({
    runId: "too-old",
    surface: "agent",
    operation: "chat",
    startedAt: Date.now() - 91 * 24 * 60 * 60 * 1_000,
  });
  finishRun("too-old", { status: "completed" });
  startRun({ runId: "interrupted", surface: "agent", operation: "chat" });
  __resetForTests();
  await open(root);
  assert.throws(() => getTrace("too-old"), /not found/i);
  assert.equal(getTrace("interrupted").run.outcome, "interrupted");
  assert.equal(getTrace("interrupted").run.status, "cancelled");

  clear();
  assert.equal(getDashboard("90d").overview.total, 0);
} finally {
  __resetForTests();
  await rm(root, { recursive: true, force: true });
}
