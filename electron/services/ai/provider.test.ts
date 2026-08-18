import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AiReasoningEffort, AiSettings } from "@shared/types";

import { loadAppSettings } from "../settings-store";
import { createTransportForProfile } from "./provider";

function customSettings(reasoningEffort: AiReasoningEffort): AiSettings {
  const profile = {
    id: "custom-test",
    name: "Custom test",
    vendorId: "custom",
    model: "reasoning-model",
    baseUrl: "https://example.com/v1",
    contextWindow: 128_000 as const,
    reasoningEffort,
    hasApiKey: true,
  };
  return {
    providerMode: "openai-compatible",
    activeProfileId: profile.id,
    profiles: [profile],
    inlineCompletionEnabled: false,
    completionProfileId: null,
    baseUrl: profile.baseUrl,
    model: profile.model,
    hasApiKey: true,
    contextWindow: profile.contextWindow,
    agentMaxIterations: 200,
    agentWallClockMs: 300_000,
    agentAllowMutations: false,
    automaticSkillMaintenanceEnabled: true,
  };
}

{
  const transport = createTransportForProfile(customSettings("medium"), "test-key");
  assert.equal(transport.model.reasoning, true);
  assert.equal(transport.model.compat?.supportsReasoningEffort, true);
  assert.equal(transport.reasoning.requested, "medium");
  assert.equal(transport.reasoning.effective, "medium");
  assert.deepEqual(transport.reasoning.supported, [
    "off", "minimal", "low", "medium", "high", "xhigh", "max",
  ]);
}

{
  const transport = createTransportForProfile(customSettings("off"), "test-key");
  assert.equal(transport.model.reasoning, false);
  assert.equal(transport.reasoning.effective, "off");
}

const root = await mkdtemp(path.join(os.tmpdir(), "stela-reasoning-profile-"));
try {
  await mkdir(path.join(root, ".stela"), { recursive: true });
  await writeFile(path.join(root, ".stela", "settings.json"), JSON.stringify({
    ai: {
      providerMode: "openai-compatible",
      activeProfileId: "legacy-custom",
      profiles: [{
        id: "legacy-custom",
        name: "Legacy custom",
        vendorId: "custom",
        model: "legacy-model",
        baseUrl: "https://example.com/v1",
        contextWindow: 128_000,
        hasApiKey: false,
      }],
    },
  }));
  const migrated = await loadAppSettings(root);
  assert.equal(migrated.ai.profiles[0]?.reasoningEffort, "medium");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("ai provider reasoning tests passed.");
