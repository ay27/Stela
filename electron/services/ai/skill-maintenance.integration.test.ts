import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import { createModels, createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { runSkillMaintenance, startSkillMaintenanceJob } from "./agent";
import * as metrics from "./agent-metrics";
import * as sqlIndex from "../sql-index";
import { loadAppSettings } from "../settings-store";
import { loadAgentSkills } from "./agent-skills";
import type { AgentEvent } from "@shared/types";
import { openLocalAgentSessionStorage, appendAgentHistoryStarted, appendAgentHistoryEvent,
  appendAgentHistoryFinished, loadAgentHistory } from "./agent-history";

const root = await mkdtemp(join(tmpdir(), "stela-maintenance-integration-"));
const model: Model<"openai-completions"> = {
  id: "offline", name: "offline", api: "openai-completions", provider: "offline",
  baseUrl: "https://offline.invalid", reasoning: false, input: ["text"], contextWindow: 128000,
  maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const models = createModels();
let replies: AssistantMessage[] = [];
let calls = 0;
models.streamSimple = () => {
  calls++;
  const reply = replies.shift();
  assert.ok(reply, "unexpected model invocation (no network is allowed)");
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: reply });
  if (reply.stopReason === "error" || reply.stopReason === "aborted") {
    stream.push({ type: "error", reason: reply.stopReason, error: reply });
  } else stream.push({ type: "done", reason: reply.stopReason, message: reply });
  stream.end(reply);
  return stream;
};
const reply = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage => ({
  role: "assistant", content, stopReason, api: model.api, provider: model.provider, model: model.id,
  timestamp: Date.now(), errorMessage: stopReason === "error" ? "offline provider failed" : undefined,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
const content = `---
name: orders-paid-revenue
description: Revenue counts paid orders only.
category: metric-definition
tags: [orders, revenue]
---
## Scope
demo.orders revenue.
## Definition
Revenue is SUM(amount) for paid orders.
## Grain & Filters
One row per order; status = 'paid'.
## Verify
Check the current source note before applying this definition.
`;

try {
  await metrics.open(root);
  await writeFile(join(root, "orders.md"), "# Revenue\nRevenue sums paid orders only.\n\n```runsql\nSELECT SUM(amount) FROM demo.orders WHERE status = 'paid';\n```\n");
  await sqlIndex.start(root);
  assert.ok((await sqlIndex.query({ readTable: "demo.orders" })).length);
  const aiSettings = (await loadAppSettings(root)).ai;
  const skills = await loadAgentSkills(root);
  const events: AgentEvent[] = [];
  const base = {
    vaultPath: root, request: { runId: "offline-parent", prompt: "Explain orders revenue" },
    conversation: "Revenue sums paid orders only, as verified in orders.md.",
    evidence: [{ tool: "run_query", kind: "success" as const, source: ["demo.orders"], tables: ["demo.orders"] }],
    model, models, skills, connection: null, dialect: null, aiSettings,
    onEvent: (event: AgentEvent) => { events.push(event); }, signal: new AbortController().signal,
  };
  const run = async (id: string, overrides: Partial<Parameters<typeof runSkillMaintenance>[0]> = {}) => {
    metrics.startRun({ runId: id, surface: "skill_maintenance", operation: "post_run_create" });
    metrics.addEvent(id, { type: "eligible" });
    metrics.addEvent(id, { type: "enqueued" });
    let resolve!: (value: boolean) => void;
    let reject!: (error: unknown) => void;
    const done = new Promise<boolean>((yes, no) => { resolve = yes; reject = no; });
    startSkillMaintenanceJob(root, {
      run: async signal => {
        try { resolve(await runSkillMaintenance({ ...base, signal, ...overrides, metricRunId: id })); }
        catch (err) { reject(err); throw err; }
      }, dropped: () => reject(new Error("unexpected dropped job")),
    });
    const saved = await done;
    const trace = metrics.getTrace(id);
    assert.notEqual(trace.run.status, "running", "every attempted job must reach a terminal metric");
    return { saved, trace };
  };

  // Real production entry, queue, ranking, source index, Harness and save_skill filesystem write.
  replies = [reply([{ type: "toolCall", id: "save-1", name: "save_skill",
    arguments: { name: "orders-paid-revenue", content, reason: "Source note defines reusable revenue." } }], "toolUse"),
    reply([{ type: "text", text: "Saved." }])];
  const saved = await run("saved");
  assert.equal(saved.saved, true);
  assert.equal(saved.trace.run.outcome, "saved");
  assert.ok(saved.trace.events.some(e => e.type === "provider_prompt"));
  const file = await readFile(join(root, ".stela/skills/orders-paid-revenue/SKILL.md"), "utf8");
  assert.match(file, /Revenue is SUM/);
  assert.match(file, /orders\.md/);
  assert.ok(events.some(e => e.type === "skill_maintenance" && e.actions.length === 1));

  const before = calls;
  const skipped = await run("no-source", { evidence: [] });
  assert.equal(skipped.trace.run.outcome, "no_source");
  assert.equal(calls, before, "no source must not invoke the model");

  // The original defect was an exception during ranking, before the old try/catch.
  const brokenSkills = { ...skills, get vault(): typeof skills.vault { throw new Error("ranking initialization failed"); } };
  const failed = await run("init-error", { skills: brokenSkills });
  assert.equal(failed.trace.run.status, "error");
  assert.match(failed.trace.run.errorMessage ?? "", /ranking initialization failed/);
  assert.equal(calls, before);

  const storage = await openLocalAgentSessionStorage(root, "offline", "maintenance-history");
  await appendAgentHistoryStarted(storage, base.request);
  await appendAgentHistoryEvent(storage, { type: "final", runId: base.request.runId, content: "Answer already delivered." });
  await appendAgentHistoryFinished(storage, base.request.runId);
  const secret = "private-example-credential";
  const sensitiveFailure = { ...skills, get vault(): typeof skills.vault {
    throw new Error(`initialization failed; token=${secret}`);
  } };
  await run("persisted-error", { skills: sensitiveFailure, historyStorage: storage });
  const restored = await loadAgentHistory(root, { deviceSlug: "offline", sessionId: "maintenance-history" });
  const terminal = restored.runs[0].events.find(e => e.type === "skill_maintenance");
  assert.ok(terminal?.type === "skill_maintenance");
  assert.equal(terminal.outcome, "error");
  assert.equal(terminal.diagnostic?.metricRunId, "persisted-error");
  assert.match(terminal.diagnostic?.message ?? "", /redacted/);
  assert.ok(!JSON.stringify(restored).includes(secret), "raw credentials must not enter persisted maintenance diagnostics");
  assert.ok(events.some(e => e.type === "history_updated"));

  const harnessFailure = await run("harness-init-error", {
    onEvent: event => {
      if (event.type === "skill_maintenance_started") throw new Error("startup observer failed");
    },
  });
  assert.equal(harnessFailure.trace.run.status, "error");
  assert.equal((harnessFailure.trace.response as { stage: string }).stage, "harness_initialization");
  assert.match((harnessFailure.trace.response as { stack: string }).stack, /startup observer failed/);
  assert.equal(calls, before);

  replies = [reply([], "error")];
  const providerError = await run("provider-error");
  assert.equal(providerError.trace.run.status, "error");
  assert.match(providerError.trace.run.errorMessage ?? "", /offline provider failed/);

  for (const reason of ["cancelled", "timeout"] as const) {
    const controller = new AbortController(); controller.abort(reason);
    const cancelled = await run(reason, { signal: controller.signal });
    assert.equal(cancelled.trace.run.outcome, reason);
  }
  // Cancellation after the provider starts must also close the metric correctly.
  const streamSimple = models.streamSimple;
  for (const reason of ["cancelled", "timeout"] as const) {
    const controller = new AbortController();
    let started = false;
    models.streamSimple = (_model, _context, options) => {
      started = true;
      const stream = createAssistantMessageEventStream();
      const abort = () => {
        const message = reply([], "aborted");
        stream.push({ type: "error", reason: "aborted", error: message });
        stream.end(message);
      };
      if (options?.signal?.aborted) abort();
      else options?.signal?.addEventListener("abort", abort, { once: true });
      return stream;
    };
    const pending = run(`in-flight-${reason}`, { signal: controller.signal });
    while (!started) await flush();
    controller.abort(reason);
    assert.equal((await pending).trace.run.outcome, reason);
  }
  models.streamSimple = streamSimple;
  replies = [reply([{ type: "text", text: "No new durable knowledge." }])];
  assert.equal((await run("after-failure")).trace.run.outcome, "no_change");
  console.log("skill-maintenance integration: saved/readback, no source, init/provider failures, cancellation, timeout, queue continuation passed");
} finally {
  await sqlIndex.stop();
  metrics.close();
  await rm(root, { recursive: true, force: true });
}
