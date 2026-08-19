import assert from "node:assert/strict";

import type { AgentMetricSessionTrace } from "@shared/types";

import { buildAgentSessionWaterfall, buildAgentTurnTrace } from "./agent-dashboard-trace";

const session: AgentMetricSessionTrace = {
  history: {
    summary: {
      sessionId: "sess-1",
      deviceSlug: "local",
      title: "Orders",
      createdAt: 1_000,
      updatedAt: 2_000,
      isLocal: true,
    },
    runs: [],
  },
  totals: {
    turnCount: 1,
    modelStepCount: 1,
    toolCallCount: 1,
    durationMs: 1_000,
    inputTokens: 10,
    outputTokens: 4,
    cacheReadTokens: 5,
    cacheWriteTokens: 0,
    promptTokens: 15,
    cacheHitRate: 1 / 3,
  },
  turns: [{
    index: 1,
    history: {
      request: {
        runId: "run-1",
        sessionId: "sess-1",
        prompt: "Count orders",
        workspaceContext: { kind: "note", path: "orders.md" },
      },
      startedAt: 1_000,
      finishedAt: 2_000,
      events: [],
      proposalResponses: [],
    },
    trace: {
      root: {
        run: {
          runId: "agent:run-1",
          parentRunId: null,
          surface: "agent",
          operation: "chat",
          status: "completed",
          outcome: null,
          startedAt: 1_000,
          endedAt: 2_000,
          durationMs: 1_000,
          firstResultMs: 800,
          profileId: null,
          vendorId: null,
          model: "test",
          inputTokens: 10,
          outputTokens: 4,
          cacheReadTokens: 5,
          cacheWriteTokens: 0,
          errorCode: null,
          errorMessage: null,
          traceTruncated: false,
        },
        request: null,
        response: null,
        events: [
          { id: 1, runId: "agent:run-1", type: "system_prompt", occurredAt: 1_001, durationMs: null, ok: null, name: null, payload: "system", truncated: false },
          { id: 2, runId: "agent:run-1", type: "model_context", occurredAt: 1_090, durationMs: null, ok: null, name: "step:1", payload: { contextWindow: 128_000, thinkingLevel: "low", requestedReasoningEffort: "high", effectiveReasoningEffort: "low", messages: [{ role: "user", content: "Count orders" }] }, truncated: false },
          { id: 3, runId: "agent:run-1", type: "provider_payload", occurredAt: 1_100, durationMs: null, ok: null, name: "step:1", payload: { messages: [{ role: "user", content: "Count orders" }] }, truncated: false },
          { id: 4, runId: "agent:run-1", type: "model_first_token", occurredAt: 1_200, durationMs: 100, ok: null, name: "step:1", payload: { stepIndex: 1 }, truncated: false },
          { id: 5, runId: "agent:run-1", type: "assistant_message", occurredAt: 1_400, durationMs: 300, ok: null, name: "step:1", payload: { role: "assistant", content: [{ type: "thinking", thinking: "I need the exact count." }, { type: "text", text: "I will query." }, { type: "toolCall", name: "run_sql", arguments: { sql: "select count(*) from orders" } }], usage: { input: 10, output: 4, cacheRead: 5, cacheWrite: 1, reasoning: 2, totalTokens: 20, cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.002, total: 0.033 } }, stopReason: "toolUse" }, truncated: false },
          { id: 6, runId: "agent:run-1", type: "plan_updated", occurredAt: 1_450, durationMs: null, ok: null, name: null, payload: { type: "plan_updated", plan: { steps: [] } }, truncated: false },
          { id: 7, runId: "agent:run-1", type: "context_usage", occurredAt: 1_460, durationMs: null, ok: null, name: null, payload: { usedTokens: 20, contextWindow: 128_000, estimated: false }, truncated: false },
          { id: 8, runId: "agent:run-1", type: "compaction", occurredAt: 1_800, durationMs: null, ok: null, name: null, payload: { phase: "started" }, truncated: false },
          { id: 9, runId: "agent:run-1", type: "compaction", occurredAt: 1_900, durationMs: null, ok: null, name: null, payload: { phase: "completed" }, truncated: false },
          { id: 10, runId: "agent:run-1", type: "proposal", occurredAt: 1_910, durationMs: null, ok: null, name: null, payload: { callId: "approval-1", kind: "question", payload: { question: "Continue?" } }, truncated: false },
          { id: 11, runId: "agent:run-1", type: "proposal_resolved", occurredAt: 1_950, durationMs: null, ok: null, name: "approval-1", payload: { callId: "approval-1", approve: true, answer: "Yes" }, truncated: false },
          { id: 12, runId: "agent:run-1", type: "future_diagnostic", occurredAt: 1_960, durationMs: null, ok: null, name: null, payload: { value: true }, truncated: false },
        ],
      },
      descendants: [{
        run: {
          runId: "tool:run-1:call-1",
          parentRunId: "agent:run-1",
          surface: "tool",
          operation: "run_sql",
          status: "completed",
          outcome: null,
          startedAt: 1_500,
          endedAt: 1_700,
          durationMs: 200,
          firstResultMs: null,
          profileId: null,
          vendorId: null,
          model: null,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          errorCode: null,
          errorMessage: null,
          traceTruncated: false,
        },
        request: { sql: "select count(*) from orders" },
        response: { rows: 1 },
        events: [],
      }, {
        run: {
          runId: "strategy:run-1:review-1",
          parentRunId: "agent:run-1",
          surface: "strategy_review",
          operation: "query_churn",
          status: "completed",
          outcome: "change",
          startedAt: 1_710,
          endedAt: 1_790,
          durationMs: 80,
          firstResultMs: null,
          profileId: null,
          vendorId: null,
          model: "test",
          inputTokens: 5,
          outputTokens: 2,
          cacheReadTokens: 3,
          cacheWriteTokens: 0,
          errorCode: null,
          errorMessage: null,
          traceTruncated: false,
        },
        request: { trigger: "query_churn" },
        response: { assessment: "change" },
        events: [],
      }, {
        run: {
          runId: "maintenance:run-1:job-1",
          parentRunId: "agent:run-1",
          surface: "skill_maintenance",
          operation: "post_run_create",
          status: "completed",
          outcome: "saved",
          startedAt: 2_010,
          endedAt: 2_050,
          durationMs: 40,
          firstResultMs: null,
          profileId: null,
          vendorId: null,
          model: "test",
          inputTokens: 2,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          errorCode: null,
          errorMessage: null,
          traceTruncated: false,
        },
        request: { evidence: [] },
        response: { saved: true },
        events: [],
      }],
    },
  }],
};

const projection = buildAgentTurnTrace(session.turns[0]!);
assert.equal(projection.input.systemPrompt, "system");
assert.equal(projection.input.context?.workspaceContext !== undefined, true);
assert.deepEqual(projection.main.map((item) => item.kind), ["model", "tool", "review", "compaction", "approval"]);
assert.deepEqual(projection.maintenance.map((item) => item.kind), ["maintenance"]);
assert.deepEqual(projection.diagnostics.map((event) => event.type), ["future_diagnostic"]);
const model = projection.main.find((item) => item.kind === "model");
assert.equal(model?.label, "Model step 1");
assert.equal(model?.durationMs, 300);
assert.equal(model?.firstTokenMs, 100);
assert.deepEqual(model?.payload, [{ role: "user", content: "Count orders" }]);
assert.equal(model?.contextWindow, 128_000);
assert.equal(model?.thinkingLevel, "low");
assert.equal(model?.requestedThinkingLevel, "high");
assert.equal(model?.usage?.promptTokens, 16);
assert.equal(model?.usage?.totalTokens, 20);
assert.equal(model?.usage?.reasoningTokens, 2);
assert.equal(model?.contextUsedTokens, 16);
assert.equal(model?.modelOutputText, "I will query.");
assert.deepEqual(model?.modelThinking, ["I need the exact count."]);
assert.deepEqual(model?.requestedTools, ["run_sql"]);
assert.deepEqual((model?.raw as { contextUsage: unknown[] }).contextUsage, [{ usedTokens: 20, contextWindow: 128_000, estimated: false }]);
assert.deepEqual(model?.effects.map((effect) => effect.type), ["plan_updated"]);
assert.equal(projection.main.find((item) => item.kind === "tool")?.label, "run_sql");
assert.equal(projection.main.find((item) => item.kind === "review")?.label, "query_churn");
assert.equal(projection.main.find((item) => item.kind === "compaction")?.durationMs, 100);
assert.equal(projection.main.find((item) => item.kind === "approval")?.durationMs, 40);

const waterfall = buildAgentSessionWaterfall(session);
assert.deepEqual(waterfall.map((item) => item.kind), ["model", "tool", "control", "control", "control"]);
