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

console.log("ipc-schema tests passed.");
