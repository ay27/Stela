import assert from "node:assert/strict";

import { IPC } from "./ipc-channels";
import { parseInput } from "./ipc-schema";

const parsed = parseInput<{
  patch: {
    ai?: {
      sendResultSamples?: boolean;
      maxSampleRows?: number;
    };
  };
}>(IPC.SETTINGS_PATCH, {
  patch: {
    ai: {
      sendResultSamples: true,
      maxSampleRows: 20,
    },
  },
});

assert.equal(parsed.patch.ai?.sendResultSamples, true);
assert.equal(parsed.patch.ai?.maxSampleRows, 20);

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
assert.deepEqual(
  parseInput(IPC.CANVAS_REFRESH_SOURCE, {
    path: "/vault/reports/revenue.stela.canvas",
    etag: "a".repeat(64),
    sourceId: "revenue_daily",
  }),
  {
    path: "/vault/reports/revenue.stela.canvas",
    etag: "a".repeat(64),
    sourceId: "revenue_daily",
  },
);
assert.throws(() => parseInput(IPC.CANVAS_REFRESH_SOURCE, {
  path: "/vault/reports/revenue.stela.canvas",
  etag: "stale",
  sourceId: "../escape",
}));

console.log("ipc-schema tests passed.");
