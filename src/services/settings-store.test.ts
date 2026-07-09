import assert from "node:assert/strict";

import type { AppSettings } from "@/contracts/settings";
import { normalizeSettings } from "./settings-store";

const legacy = normalizeSettings({
  ai: {
    providerMode: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    hasApiKey: true,
    sendResultSamples: true,
    maxSampleRows: 20,
  },
} as AppSettings);

assert.equal(legacy.ai.agentMaxIterations, 200);
assert.equal(legacy.ai.agentWallClockMs, 300_000);
assert.equal(legacy.ai.agentAllowMutations, false);

const patched = normalizeSettings({
  ai: {
    providerMode: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    hasApiKey: true,
    sendResultSamples: true,
    maxSampleRows: 20,
    agentAllowMutations: true,
  },
} as AppSettings);

assert.equal(patched.ai.agentAllowMutations, true);
assert.equal(patched.ai.agentMaxIterations, 200);

console.log("settings-store tests passed.");
