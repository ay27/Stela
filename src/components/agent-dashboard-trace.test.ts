import assert from "node:assert/strict";

import type { AgentMetricSessionTrace } from "@shared/types";

import { buildAgentSessionWaterfall, buildAgentTurnTraceItems } from "./agent-dashboard-trace";

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
          { id: 2, runId: "agent:run-1", type: "provider_payload", occurredAt: 1_100, durationMs: null, ok: null, name: "step:1", payload: { messages: [] }, truncated: false },
          { id: 3, runId: "agent:run-1", type: "model_first_token", occurredAt: 1_200, durationMs: 100, ok: null, name: "step:1", payload: { stepIndex: 1 }, truncated: false },
          { id: 4, runId: "agent:run-1", type: "assistant_message", occurredAt: 1_400, durationMs: 300, ok: null, name: "step:1", payload: { role: "assistant", content: [{ type: "text", text: "I will query." }] }, truncated: false },
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
      }],
    },
  }],
};

const items = buildAgentTurnTraceItems(session.turns[0]!);
assert.deepEqual(items.slice(0, 3).map((item) => item.kind), ["system", "user", "context"]);
const model = items.find((item) => item.kind === "model");
assert.equal(model?.label, "Model step 1");
assert.equal(model?.durationMs, 300);
assert.equal(model?.firstTokenMs, 100);
assert.equal(items.find((item) => item.kind === "tool")?.label, "run_sql");

const waterfall = buildAgentSessionWaterfall(session);
assert.deepEqual(waterfall.map((item) => item.kind), ["input", "input", "model", "tool"]);
