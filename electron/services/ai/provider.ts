/**
 * LLM transport via `@earendil-works/pi-ai`.
 *
 * - Builtin vendors: pi provider factories (catalog + native API).
 * - Custom: createProvider + openAICompletionsApi (arbitrary OpenAI-compatible gateways).
 * Credentials stay Stela-owned (safeStorage shards). pi's auth.json is not used.
 */

import {
  createModels,
  createProvider,
  type Credential,
  type CredentialStore,
  type Model,
  type Models,
  type Provider,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

import { AppError, isAppError } from "@shared/errors";
import type {
  AiProviderProfile,
  AiProviderStatus,
  AiSettings,
  AiVendorInfo,
  PartialAppSettings,
} from "@shared/types";

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { atomicWriteFile } from "../atomic-write";
import * as secrets from "../secrets";
import { vaultConfigDir } from "../vault-paths";
import * as settingsStore from "../settings-store";

const SECRETS_DIR = "secrets";
const AI_SECRET_FILE_PREFIX = "ai_";
const CUSTOM_VENDOR_ID = "custom";
const CUSTOM_PROVIDER_ID = "stela-custom";

interface AiSecretShard {
  apiKey?: string;
}

function legacyShardPath(vaultPath: string, slug: string): string {
  return path.join(vaultConfigDir(vaultPath), SECRETS_DIR, `${AI_SECRET_FILE_PREFIX}${slug}.json`);
}

function shardPath(vaultPath: string, slug: string, profileId: string): string {
  return path.join(
    vaultConfigDir(vaultPath),
    SECRETS_DIR,
    `${AI_SECRET_FILE_PREFIX}${slug}_${profileId}.json`,
  );
}

async function readShardFile(filePath: string): Promise<AiSecretShard> {
  try {
    const buf = await fs.readFile(filePath, "utf-8");
    return JSON.parse(buf) as AiSecretShard;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return {};
    throw new AppError("ai_secret_read_failed", `read AI secret failed: ${e.message}`);
  }
}

async function writeShardFile(filePath: string, shard: AiSecretShard): Promise<void> {
  await atomicWriteFile(filePath, JSON.stringify(shard, null, 2));
}

let cachedBuiltinProviders: Provider[] | undefined;

function allBuiltinProviders(): Provider[] {
  // ponytail: cache once; catalog is static for process lifetime
  return (cachedBuiltinProviders ??= builtinProviders());
}

export function listAiVendors(): AiVendorInfo[] {
  const builtins = allBuiltinProviders().map((provider) => ({
    id: provider.id,
    name: provider.name,
    models: provider.getModels().map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
    })),
  }));
  return [
    ...builtins,
    { id: CUSTOM_VENDOR_ID, name: "Custom (OpenAI-compatible)", models: [] },
  ];
}

function resolvePiProvider(vendorId: string): Provider | undefined {
  return allBuiltinProviders().find((provider) => provider.id === vendorId);
}

export function getActiveProfile(ai: AiSettings, profileId?: string | null): AiProviderProfile {
  const id = profileId?.trim() || ai.activeProfileId;
  const found = ai.profiles.find((p) => p.id === id);
  if (found) return found;
  if (ai.profiles[0]) return ai.profiles[0];
  throw new AppError("ai_missing_profile", "No AI provider profile is configured.");
}

export async function loadApiKey(
  vaultPath: string,
  slug: string,
  profileId: string,
): Promise<string> {
  const primary = await readShardFile(shardPath(vaultPath, slug, profileId));
  if (primary.apiKey) return secrets.decryptToken(primary.apiKey);
  // ponytail: one-shot legacy migrate from ai_{slug}.json
  const legacy = await readShardFile(legacyShardPath(vaultPath, slug));
  if (!legacy.apiKey) return "";
  const decrypted = secrets.decryptToken(legacy.apiKey);
  await saveApiKey(vaultPath, slug, profileId, decrypted);
  return decrypted;
}

export async function saveApiKey(
  vaultPath: string,
  slug: string,
  profileId: string,
  apiKey: string,
): Promise<void> {
  await writeShardFile(shardPath(vaultPath, slug, profileId), {
    apiKey: secrets.encryptToken(apiKey),
  });
}

export async function clearApiKey(
  vaultPath: string,
  slug: string,
  profileId?: string | null,
): Promise<void> {
  const settings = await settingsStore.loadAppSettings(vaultPath);
  const profile = getActiveProfile(settings.ai, profileId);
  await writeShardFile(shardPath(vaultPath, slug, profile.id), {});
  const profiles = settings.ai.profiles.map((item) =>
    item.id === profile.id ? { ...item, hasApiKey: false } : item,
  );
  await settingsStore.patchAppSettings(vaultPath, {
    ai: {
      ...settings.ai,
      profiles,
      activeProfileId: settings.ai.activeProfileId,
      hasApiKey: false,
    },
  });
}

function withUpdatedProfile(
  ai: AiSettings,
  profileId: string,
  patch: Partial<AiProviderProfile>,
): AiProviderProfile[] {
  return ai.profiles.map((item) =>
    item.id === profileId ? { ...item, ...patch, id: item.id } : item,
  );
}

export async function configureProvider(
  vaultPath: string,
  slug: string,
  settingsPatch: Partial<Omit<AiSettings, "hasApiKey" | "baseUrl" | "model" | "contextWindow">> & {
    baseUrl?: string;
    model?: string;
    contextWindow?: AiSettings["contextWindow"];
    hasApiKey?: boolean;
  },
  apiKey?: string | null,
  profileId?: string | null,
): Promise<AiProviderStatus> {
  const current = await settingsStore.loadAppSettings(vaultPath);
  let nextAi: AiSettings = { ...current.ai, ...settingsPatch } as AiSettings;

  if (settingsPatch.profiles) {
    nextAi = {
      ...nextAi,
      profiles: settingsPatch.profiles,
      activeProfileId: settingsPatch.activeProfileId ?? nextAi.activeProfileId,
    };
  }

  const target = getActiveProfile(
    {
      ...nextAi,
      profiles: nextAi.profiles.length > 0 ? nextAi.profiles : current.ai.profiles,
    },
    profileId ?? settingsPatch.activeProfileId,
  );

  // Flat field patches apply to the target profile (settings UI / legacy).
  const profilePatch: Partial<AiProviderProfile> = {};
  if (settingsPatch.model !== undefined) profilePatch.model = settingsPatch.model;
  if (settingsPatch.baseUrl !== undefined) profilePatch.baseUrl = settingsPatch.baseUrl;
  if (settingsPatch.contextWindow !== undefined) {
    profilePatch.contextWindow = settingsPatch.contextWindow;
  }

  let profiles = nextAi.profiles.length > 0 ? [...nextAi.profiles] : [...current.ai.profiles];
  if (!profiles.some((p) => p.id === target.id)) {
    profiles = [...profiles, target];
  }
  if (Object.keys(profilePatch).length > 0) {
    profiles = withUpdatedProfile({ ...nextAi, profiles }, target.id, profilePatch);
  }

  let hasApiKey = profiles.find((p) => p.id === target.id)?.hasApiKey ?? false;
  if (apiKey !== undefined && apiKey !== null) {
    const trimmed = apiKey.trim();
    if (trimmed.length > 0) {
      await saveApiKey(vaultPath, slug, target.id, trimmed);
      hasApiKey = true;
    }
  }
  profiles = withUpdatedProfile({ ...nextAi, profiles }, target.id, { hasApiKey });

  const patch: PartialAppSettings = {
    ai: {
      providerMode: settingsPatch.providerMode ?? current.ai.providerMode,
      sendResultSamples: settingsPatch.sendResultSamples ?? current.ai.sendResultSamples,
      maxSampleRows: settingsPatch.maxSampleRows ?? current.ai.maxSampleRows,
      agentMaxIterations: settingsPatch.agentMaxIterations ?? current.ai.agentMaxIterations,
      agentWallClockMs: settingsPatch.agentWallClockMs ?? current.ai.agentWallClockMs,
      agentAllowMutations: settingsPatch.agentAllowMutations ?? current.ai.agentAllowMutations,
      inlineCompletionEnabled:
        settingsPatch.inlineCompletionEnabled ?? current.ai.inlineCompletionEnabled,
      completionProfileId:
        settingsPatch.completionProfileId === undefined
          ? current.ai.completionProfileId
          : settingsPatch.completionProfileId,
      activeProfileId: settingsPatch.activeProfileId ?? target.id,
      profiles,
    },
  };
  await settingsStore.patchAppSettings(vaultPath, patch);
  return getProviderStatus(vaultPath);
}

export async function upsertProfile(
  vaultPath: string,
  slug: string,
  profile: Omit<AiProviderProfile, "hasApiKey"> & { hasApiKey?: boolean },
  apiKey?: string | null,
  makeActive = true,
): Promise<AiProviderStatus> {
  const current = await settingsStore.loadAppSettings(vaultPath);
  const id = profile.id.trim() || randomUUID();
  let hasApiKey = profile.hasApiKey === true;
  if (apiKey !== undefined && apiKey !== null && apiKey.trim()) {
    await saveApiKey(vaultPath, slug, id, apiKey.trim());
    hasApiKey = true;
  } else {
    const existing = await loadApiKey(vaultPath, slug, id);
    hasApiKey = hasApiKey || existing.length > 0;
  }
  const nextProfile: AiProviderProfile = {
    id,
    name: profile.name.trim() || profile.vendorId,
    vendorId: profile.vendorId.trim() || CUSTOM_VENDOR_ID,
    model: profile.model.trim(),
    baseUrl: profile.baseUrl.trim(),
    contextWindow: profile.contextWindow,
    hasApiKey,
  };
  const profiles = current.ai.profiles.some((p) => p.id === id)
    ? current.ai.profiles.map((p) => (p.id === id ? nextProfile : p))
    : [...current.ai.profiles, nextProfile];
  await settingsStore.patchAppSettings(vaultPath, {
    ai: {
      ...current.ai,
      profiles,
      activeProfileId: makeActive ? id : current.ai.activeProfileId,
    },
  });
  return getProviderStatus(vaultPath);
}

export async function deleteProfile(
  vaultPath: string,
  slug: string,
  profileId: string,
): Promise<AiProviderStatus> {
  const current = await settingsStore.loadAppSettings(vaultPath);
  if (current.ai.profiles.length <= 1) {
    throw new AppError("ai_last_profile", "Cannot delete the last AI provider profile.");
  }
  const profiles = current.ai.profiles.filter((p) => p.id !== profileId);
  const activeProfileId =
    current.ai.activeProfileId === profileId ? profiles[0].id : current.ai.activeProfileId;
  const deletedCompletionProfile = current.ai.completionProfileId === profileId;
  try {
    await fs.unlink(shardPath(vaultPath, slug, profileId));
  } catch {
    // ignore missing shard
  }
  await settingsStore.patchAppSettings(vaultPath, {
    ai: {
      ...current.ai,
      profiles,
      activeProfileId,
      completionProfileId: deletedCompletionProfile
        ? null
        : current.ai.completionProfileId,
      inlineCompletionEnabled:
        !deletedCompletionProfile && current.ai.inlineCompletionEnabled,
    },
  });
  return getProviderStatus(vaultPath);
}

export async function getProviderStatus(vaultPath: string): Promise<AiProviderStatus> {
  const settings = await settingsStore.loadAppSettings(vaultPath);
  const active = getActiveProfile(settings.ai);
  return {
    enabled: settings.ai.providerMode !== "disabled",
    providerMode: settings.ai.providerMode,
    model: active.model,
    baseUrl: active.baseUrl,
    hasApiKey: active.hasApiKey,
    credentialBackend: secrets.isAvailable() ? "safeStorage" : "plain",
    activeProfileId: active.id,
    profiles: settings.ai.profiles,
    vendors: listAiVendors(),
  };
}

/** In-memory CredentialStore that serves one Stela-decrypted API key. */
export function createStelaCredentialStore(apiKey: string): CredentialStore {
  let credential: Credential | undefined = apiKey
    ? { type: "api_key", key: apiKey }
    : undefined;
  return {
    async read() {
      return credential;
    },
    async modify(_providerId, fn) {
      credential = await fn(credential);
      return credential;
    },
    async delete() {
      credential = undefined;
    },
  };
}

function createCustomProvider(): Provider<"openai-completions"> {
  return createProvider<"openai-completions">({
    id: CUSTOM_PROVIDER_ID,
    name: "Custom OpenAI-compatible",
    auth: {
      apiKey: {
        name: "Stela API key",
        resolve: async ({ credential }) => {
          if (!credential?.key) return undefined;
          return {
            auth: { apiKey: credential.key },
            source: "stela-safeStorage",
          };
        },
      },
    },
    models: [],
    api: openAICompletionsApi(),
  });
}

function buildCustomModel(profile: AiProviderProfile): Model<"openai-completions"> {
  const contextWindow = profile.contextWindow || 128_000;
  return {
    id: profile.model,
    name: profile.model,
    api: "openai-completions",
    provider: CUSTOM_PROVIDER_ID,
    baseUrl: profile.baseUrl.replace(/\/+$/, ""),
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: Math.min(16_384, Math.max(1_024, Math.floor(contextWindow / 8))),
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
  };
}

/** Shared Models + Model for one-shot actions and AgentHarness. */
export function createTransportForProfile(
  ai: AiSettings,
  apiKey: string,
  profileId?: string | null,
): {
  models: Models;
  model: Model;
  profile: AiProviderProfile;
} {
  if (ai.providerMode === "disabled") {
    throw new AppError("ai_disabled", "AI provider is disabled.");
  }
  if (!apiKey) {
    throw new AppError("ai_missing_api_key", "AI provider API key is not configured.");
  }
  const profile = getActiveProfile(ai, profileId);
  if (!profile.model.trim()) {
    throw new AppError("ai_missing_model", "AI provider model is not configured.");
  }

  const credentials = createStelaCredentialStore(apiKey);
  const models = createModels({ credentials });

  if (profile.vendorId === CUSTOM_VENDOR_ID) {
    if (!profile.baseUrl.trim()) {
      throw new AppError("ai_missing_base_url", "AI provider base URL is not configured.");
    }
    models.setProvider(createCustomProvider());
    return { models, model: buildCustomModel(profile), profile };
  }

  const provider = resolvePiProvider(profile.vendorId);
  if (!provider) {
    throw new AppError(
      "ai_unknown_vendor",
      `Unknown AI vendor "${profile.vendorId}". Pick another vendor or use Custom.`,
    );
  }
  models.setProvider(provider);
  const model = models.getModel(provider.id, profile.model);
  if (!model) {
    throw new AppError(
      "ai_unknown_model",
      `Model "${profile.model}" is not in the ${provider.name} catalog.`,
    );
  }
  return { models, model, profile };
}

/** @deprecated use createTransportForProfile */
export function createStelaTransport(settings: AiSettings, apiKey: string): {
  models: Models;
  model: Model;
} {
  const { models, model } = createTransportForProfile(settings, apiKey);
  return { models, model };
}

function assistantText(message: { content: Array<{ type: string; text?: string }> }): string {
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

export async function callChatCompletions({
  settings,
  apiKey,
  system,
  user,
  profileId,
}: {
  settings: AiSettings;
  apiKey: string;
  system: string;
  user: string;
  profileId?: string | null;
}): Promise<string> {
  const { models, model } = createTransportForProfile(settings, apiKey, profileId);
  const message = await models.completeSimple(model, {
    systemPrompt: system,
    messages: [
      {
        role: "user",
        content: user,
        timestamp: Date.now(),
      },
    ],
  });

  if (message.stopReason === "aborted") {
    throw new AppError("ai_aborted", message.errorMessage ?? "AI request was aborted.");
  }
  if (message.stopReason === "error") {
    throw new AppError(
      "ai_provider_failed",
      message.errorMessage ?? "AI provider returned an error.",
    );
  }
  const content = assistantText(message);
  if (!content) {
    throw new AppError("ai_empty_response", "AI provider returned an empty response.");
  }
  return content;
}

export async function streamChatCompletions({
  settings,
  apiKey,
  system,
  user,
  profileId,
  signal,
  onDelta,
}: {
  settings: AiSettings;
  apiKey: string;
  system: string;
  user: string;
  profileId: string;
  signal: AbortSignal;
  onDelta: (text: string) => void;
}): Promise<void> {
  try {
    if (signal.aborted) {
      throw new AppError("ai_aborted", "AI request was aborted.");
    }
    const { models, model } = createTransportForProfile(settings, apiKey, profileId);
    const stream = models.streamSimple(
      model,
      {
        systemPrompt: system,
        messages: [{ role: "user", content: user, timestamp: Date.now() }],
      },
      { signal, temperature: 0.2, maxTokens: 48 },
    );
    for await (const event of stream) {
      if (event.type === "text_delta" && event.delta) onDelta(event.delta);
    }
    const message = await stream.result();
    if (message.stopReason === "aborted") {
      throw new AppError("ai_aborted", message.errorMessage ?? "AI request was aborted.");
    }
    if (message.stopReason === "error") {
      throw new AppError(
        "ai_provider_failed",
        message.errorMessage ?? "AI provider returned an error.",
      );
    }
  } catch (err) {
    if (isAppError(err)) throw err;
    if (signal.aborted) throw new AppError("ai_aborted", "AI request was aborted.");
    throw new AppError(
      "ai_provider_failed",
      err instanceof Error ? err.message : String(err),
    );
  }
}
