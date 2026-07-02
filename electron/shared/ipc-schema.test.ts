import assert from "node:assert/strict";

import { IPC } from "./ipc-channels";
import { parseInput } from "./ipc-schema";

const parsed = parseInput<{
  patch: {
    ai?: {
      inlineCompletionEnabled?: boolean;
      fimBaseUrl?: string;
      fimModel?: string;
    };
  };
}>(IPC.SETTINGS_PATCH, {
  patch: {
    ai: {
      inlineCompletionEnabled: true,
      fimBaseUrl: "https://api.deepseek.com/beta",
      fimModel: "deepseek-v4-pro",
    },
  },
});

assert.equal(parsed.patch.ai?.inlineCompletionEnabled, true);
assert.equal(parsed.patch.ai?.fimBaseUrl, "https://api.deepseek.com/beta");
assert.equal(parsed.patch.ai?.fimModel, "deepseek-v4-pro");

console.log("ipc-schema tests passed.");
