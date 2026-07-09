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

console.log("ipc-schema tests passed.");
