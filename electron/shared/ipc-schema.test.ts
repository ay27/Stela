import assert from "node:assert/strict";

import { IPC } from "./ipc-channels";
import { parseInput } from "./ipc-schema";

const parsed = parseInput<{
  patch: {
    ai?: {
      agentAllowMutations?: boolean;
    };
  };
}>(IPC.SETTINGS_PATCH, {
  patch: {
    ai: {
      agentAllowMutations: true,
    },
  },
});

assert.equal(parsed.patch.ai?.agentAllowMutations, true);

const profileSwitchPatch = {
  patch: {
    ai: {
      activeProfileId: "profile-deepseek",
      profiles: [{
        id: "profile-deepseek",
        name: "DeepSeek",
        vendorId: "deepseek",
        model: "deepseek-chat",
        baseUrl: "",
        contextWindow: 128_000 as const,
        reasoningEffort: "medium" as const,
        hasApiKey: true,
      }],
    },
  },
};
assert.deepEqual(
  parseInput(IPC.SETTINGS_PATCH, profileSwitchPatch),
  profileSwitchPatch,
  "settings.patch must preserve AI profile selection fields",
);
assert.throws(
  () => parseInput(IPC.SETTINGS_PATCH, {
    patch: {
      ai: {
        profiles: [{ ...profileSwitchPatch.patch.ai.profiles[0], reasoningEffort: "turbo" }],
      },
    },
  }),
  /reasoningEffort/,
);

assert.deepEqual(parseInput(IPC.AI_AGENT_HISTORY_LIST, {}), {});
assert.deepEqual(
  parseInput(IPC.AI_AGENT_HISTORY_LOAD, { sessionId: "sess_abc", deviceSlug: "laptop" }),
  { sessionId: "sess_abc", deviceSlug: "laptop" },
);
assert.throws(
  () => parseInput(IPC.AI_AGENT_HISTORY_LOAD, { sessionId: "../escape", deviceSlug: "laptop" }),
);

assert.deepEqual(
  parseInput(IPC.AI_AGENT_RUN, {
    request: {
      runId: "run_1",
      prompt: "Update the active analysis",
      canvasPath: "/vault/reports/revenue.stela.canvas",
    },
  }),
  {
    request: {
      runId: "run_1",
      prompt: "Update the active analysis",
      canvasPath: "/vault/reports/revenue.stela.canvas",
    },
  },
);

const orderedAgentRequest = {
  request: {
    runId: "run_ordered",
    prompt: "Compare [table: analytics.orders] twice",
    workspaceContext: { kind: "note" as const, path: "reports/orders.md" },
    message: {
      version: 1 as const,
      segments: [
        { kind: "text" as const, text: "Compare " },
        { kind: "resource" as const, resourceId: "resource_table_orders" },
        { kind: "text" as const, text: " with " },
        { kind: "resource" as const, resourceId: "resource_table_orders" },
      ],
      resources: [{
        id: "resource_table_orders",
        kind: "table" as const,
        label: "analytics.orders",
        table: "analytics.orders",
        connectionName: "warehouse",
      }],
    },
  },
};
assert.deepEqual(parseInput(IPC.AI_AGENT_RUN, orderedAgentRequest), orderedAgentRequest);

const canvasRefreshRequest = {
  request: {
    runId: "run_canvas_refresh",
    entryPoint: "canvas-refresh" as const,
    prompt: "Refresh the Canvas",
    canvasRefresh: {
      path: "reports/revenue.stela.canvas",
      sourceId: "revenue_daily",
    },
  },
};
assert.deepEqual(parseInput(IPC.AI_AGENT_RUN, canvasRefreshRequest), canvasRefreshRequest);
assert.throws(() => parseInput(IPC.AI_AGENT_RUN, {
  request: {
    runId: "run_canvas_refresh_invalid",
    entryPoint: "canvas-refresh",
    prompt: "Refresh the Canvas",
    canvasRefresh: { path: "reports/revenue.stela.canvas", sourceId: "../escape" },
  },
}));
assert.throws(() => parseInput(IPC.AI_AGENT_RUN, {
  request: {
    runId: "run_canvas_refresh_missing_scope",
    entryPoint: "canvas-refresh",
    prompt: "Refresh the Canvas",
  },
}));
assert.throws(() => parseInput(IPC.AI_AGENT_RUN, {
  request: {
    runId: "run_canvas_refresh_wrong_entry",
    entryPoint: "chat",
    prompt: "Refresh the Canvas",
    canvasRefresh: { path: "reports/revenue.stela.canvas" },
  },
}));

assert.deepEqual(
  parseInput(IPC.CANVAS_CREATE, {
    directory: "/vault/reports",
    title: "Revenue",
  }),
  {
    directory: "/vault/reports",
    title: "Revenue",
  },
);
assert.deepEqual(parseInput(IPC.CANVAS_UPDATE_FLOW_LAYOUT, {
  path: "/vault/reports/revenue.stela.canvas",
  etag: "b".repeat(64),
  cardId: "pipeline",
  patch: { direction: "LR", positions: [{ nodeId: "source", position: { x: 12, y: 34 } }] },
}), {
  path: "/vault/reports/revenue.stela.canvas",
  etag: "b".repeat(64),
  cardId: "pipeline",
  patch: { direction: "LR", positions: [{ nodeId: "source", position: { x: 12, y: 34 } }] },
});
assert.throws(() => parseInput(IPC.CANVAS_UPDATE_FLOW_LAYOUT, {
  path: "/vault/reports/revenue.stela.canvas",
  etag: "b".repeat(64),
  cardId: "pipeline",
  patch: { positions: [{ nodeId: "source", position: { x: Number.POSITIVE_INFINITY, y: 0 } }] },
}));

assert.deepEqual(parseInput(IPC.AI_PYTHON_RUNTIME_READ_INPUT, {
  jobId: "da9a1a89-41b1-4c12-8b3a-e7b7b4f625c5",
  alias: "orders",
  offset: 0,
  length: 4 * 1024 * 1024,
}), {
  jobId: "da9a1a89-41b1-4c12-8b3a-e7b7b4f625c5",
  alias: "orders",
  offset: 0,
  length: 4 * 1024 * 1024,
});
assert.throws(() => parseInput(IPC.AI_PYTHON_RUNTIME_READ_INPUT, {
  jobId: "da9a1a89-41b1-4c12-8b3a-e7b7b4f625c5",
  alias: "../secret",
  offset: 0,
  length: 1,
}));
assert.throws(() => parseInput(IPC.AI_PYTHON_RUNTIME_READ_INPUT, {
  jobId: "da9a1a89-41b1-4c12-8b3a-e7b7b4f625c5",
  alias: "orders",
  offset: 0,
  length: 4 * 1024 * 1024 + 1,
}));

console.log("ipc-schema tests passed.");
