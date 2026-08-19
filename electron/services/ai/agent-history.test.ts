import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AgentRunRequest } from "@shared/types";

import {
  appendAgentHistoryEvent,
  appendAgentHistoryFinished,
  appendAgentHistoryStarted,
  forkAgentHistorySession,
  listAgentHistory,
  loadAgentHistory,
  openLocalAgentSessionStorage,
  pruneLocalAgentHistory,
} from "./agent-history";

const vaultPath = await mkdtemp(path.join(os.tmpdir(), "stela-agent-history-"));
const request: AgentRunRequest = {
  runId: "run_1",
  sessionId: "session_1",
  entryPoint: "canvas-refresh",
  canvasRefresh: { path: "reports/revenue.stela.canvas", sourceId: "revenue_daily" },
  prompt: "Show daily revenue",
  workspaceContext: { kind: "note", path: "reports/revenue.md" },
  message: {
    version: 1,
    segments: [
      { kind: "text", text: "Show daily revenue from " },
      { kind: "resource", resourceId: "resource_runsql_revenue" },
    ],
    resources: [{
      id: "resource_runsql_revenue",
      kind: "runsql",
      label: "Revenue SQL",
      sql: "SELECT sum(revenue) FROM orders",
      sourcePath: "reports/revenue.md",
      locator: { blockId: "block_revenue", blockIndex: 0 },
      rewriteTargetId: "target_1",
    }],
  },
  canvasPath: "reports/revenue.stela.canvas",
  attachments: [
    {
      kind: "runsql",
      label: "Revenue SQL",
      sql: "SELECT sum(revenue) FROM orders",
      sourcePath: "reports/revenue.md",
      rewriteTargetId: "target_1",
      errorMessage: "Unknown column 'revenue'",
    },
  ],
};

try {
  const storage = await openLocalAgentSessionStorage(vaultPath, "laptop", "session_1");
  await appendAgentHistoryStarted(storage, request);
  await appendAgentHistoryEvent(storage, {
    type: "canvas_updated",
    runId: "run_1",
    path: "reports/revenue.stela.canvas",
    title: "Revenue",
    action: "created",
  });
  await appendAgentHistoryEvent(storage, { type: "final", runId: "run_1", content: "Revenue is 42." });
  await appendAgentHistoryFinished(storage, "run_1");
  const lastEntry = (await storage.getEntries()).at(-1);
  await appendFile(
    path.join(vaultPath, ".stela", "agent-history", "laptop", "session_1.jsonl"),
    [
      { type: "plan_updated", runId: "run_1" },
      {
        type: "plan_updated",
        runId: "run_1",
        plan: { runId: "run_1", version: 1, steps: [null] },
      },
      {
        type: "skill_maintenance",
        runId: "run_1",
        actions: [{ action: "saved", name: 1, path: "bad", reason: "bad" }],
        summary: "bad",
      },
    ]
      .map((event, index) =>
        JSON.stringify({
          type: "custom",
          id: `invalid_event_${index}`,
          parentId: lastEntry?.id ?? null,
          timestamp: new Date().toISOString(),
          customType: "stela_agent_run_event",
          data: { runId: "run_1", event },
        }),
      )
      .join("\n") + "\n",
  );

  const history = await loadAgentHistory(vaultPath, { sessionId: "session_1", deviceSlug: "laptop" });
  assert.equal(history.summary.title, "Show daily revenue");
  assert.equal(history.runs.length, 1);
  assert.equal(history.runs[0]?.finishedAt !== null, true);
  assert.deepEqual(history.runs[0]?.request.attachments, request.attachments);
  assert.equal(history.runs[0]?.request.canvasPath, request.canvasPath);
  assert.equal(history.runs[0]?.request.entryPoint, request.entryPoint);
  assert.deepEqual(history.runs[0]?.request.canvasRefresh, request.canvasRefresh);
  assert.deepEqual(history.runs[0]?.request.message, request.message);
  assert.deepEqual(history.runs[0]?.request.workspaceContext, request.workspaceContext);
  assert.deepEqual(history.runs[0]?.events, [
    {
      type: "canvas_updated",
      runId: "run_1",
      path: "reports/revenue.stela.canvas",
      title: "Revenue",
      action: "created",
    },
    { type: "final", runId: "run_1", content: "Revenue is 42." },
  ]);

  const maintenanceRequest: AgentRunRequest = {
    runId: "run_2",
    sessionId: "session_1",
    entryPoint: "knowledge-maintenance",
    prompt: "Maintain experience knowledge",
  };
  await appendAgentHistoryStarted(storage, maintenanceRequest);
  await appendAgentHistoryFinished(storage, maintenanceRequest.runId);
  const historyWithMaintenance = await loadAgentHistory(
    vaultPath,
    { sessionId: "session_1", deviceSlug: "laptop" },
  );
  assert.equal(historyWithMaintenance.runs[1]?.request.entryPoint, "knowledge-maintenance");

  const outside = await mkdtemp(path.join(os.tmpdir(), "stela-agent-history-outside-"));
  try {
    await symlink(
      outside,
      path.join(vaultPath, ".stela", "agent-history", "escaped"),
      "dir",
    );
    await assert.rejects(
      () => loadAgentHistory(vaultPath, { sessionId: "session_1", deviceSlug: "escaped" }),
      /escapes vault/,
    );
  } finally {
    await rm(outside, { force: true, recursive: true });
  }

  const remoteStorage = await openLocalAgentSessionStorage(vaultPath, "desktop", "remote_1");
  await appendAgentHistoryStarted(remoteStorage, {
    ...request,
    runId: "run_remote",
    sessionId: "remote_1",
    prompt: "Inspect orders",
    message: undefined,
  });
  await mkdir(path.join(vaultPath, ".stela", "agent-history", "broken"), { recursive: true });
  await writeFile(
    path.join(vaultPath, ".stela", "agent-history", "broken", "invalid.jsonl"),
    "not-json\n",
  );
  const summaries = await listAgentHistory(vaultPath, "laptop");
  assert.deepEqual(
    summaries.map((summary) => [summary.sessionId, summary.deviceSlug, summary.isLocal]),
    [
      ["remote_1", "desktop", false],
      ["session_1", "laptop", true],
    ],
  );

  const forked = await forkAgentHistorySession(vaultPath, "laptop", {
    sessionId: "remote_1",
    deviceSlug: "desktop",
  });
  assert.notEqual(forked.sessionId, "remote_1");
  assert.equal(forked.deviceSlug, "laptop");
  const forkedHistory = await loadAgentHistory(vaultPath, forked);
  assert.equal(forkedHistory.runs[0]?.request.prompt, "Inspect orders");

  const remoteHistory = await loadAgentHistory(vaultPath, { sessionId: "remote_1", deviceSlug: "desktop" });
  assert.equal(remoteHistory.runs[0]?.finishedAt, null);

  for (let index = 0; index <= 20; index++) {
    const sessionId = `limit_${String(index).padStart(2, "0")}`;
    const limitStorage = await openLocalAgentSessionStorage(vaultPath, "retention", sessionId);
    await appendAgentHistoryStarted(limitStorage, { runId: `run_${sessionId}`, sessionId, prompt: sessionId });
    await appendAgentHistoryFinished(limitStorage, `run_${sessionId}`);
  }
  assert.deepEqual(
    await pruneLocalAgentHistory(vaultPath, "retention", () => new Set(["limit_00"])),
    [],
  );
  assert.equal(
    (await listAgentHistory(vaultPath, "retention")).filter((summary) => summary.deviceSlug === "retention").length,
    21,
  );
  assert.deepEqual(
    await pruneLocalAgentHistory(vaultPath, "retention"),
    [{ deviceSlug: "retention", sessionId: "limit_00" }],
  );
  assert.equal(
    (await listAgentHistory(vaultPath, "retention")).filter((summary) => summary.deviceSlug === "retention").length,
    20,
  );
} finally {
  await rm(vaultPath, { force: true, recursive: true });
}

console.log("agent history tests passed.");
