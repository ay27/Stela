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

assert.equal(legacy.ai.inlineCompletionEnabled, false);
assert.equal(legacy.ai.fimBaseUrl, "https://api.deepseek.com/beta");
assert.equal(legacy.ai.fimModel, "deepseek-v4-pro");

const patched = normalizeSettings({
  ai: {
    providerMode: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    hasApiKey: true,
    sendResultSamples: true,
    maxSampleRows: 20,
    inlineCompletionEnabled: true,
  },
} as AppSettings);

assert.equal(patched.ai.inlineCompletionEnabled, true);
assert.equal(patched.ai.fimBaseUrl, "https://api.deepseek.com/beta");

console.log("settings-store tests passed.");
