/**
 * OpenAI-compatible LLM transport via `@earendil-works/pi-ai`.
 *
 * Credentials stay Stela-owned (safeStorage shards). pi's auth.json is not used.
 */

import {
  createModels,
  createProvider,
  type Credential,
  type CredentialStore,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

import { AppError } from "@shared/errors";
import type {
  AiProviderStatus,
  AiSettings,
  PartialAppSettings,
} from "@shared/types";

import { promises as fs } from "node:fs";
import path from "node:path";

import { atomicWriteFile } from "../atomic-write";
import * as secrets from "../secrets";
import { vaultConfigDir } from "../vault-paths";
import * as settingsStore from "../settings-store";

const SECRETS_DIR = "secrets";
const AI_SECRET_FILE_PREFIX = "ai_";
const STELA_PROVIDER_ID = "stela-openai-compatible";

interface AiSecretShard {
  apiKey?: string;
}

function shardPath(vaultPath: string, slug: string): string {
  return path.join(vaultConfigDir(vaultPath), SECRETS_DIR, `${AI_SECRET_FILE_PREFIX}${slug}.json`);
}

async function readShard(vaultPath: string, slug: string): Promise<AiSecretShard> {
  try {
    const buf = await fs.readFile(shardPath(vaultPath, slug), "utf-8");
    return JSON.parse(buf) as AiSecretShard;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return {};
    throw new AppError("ai_secret_read_failed", `read AI secret failed: ${e.message}`);
  }
}

async function writeShard(
  vaultPath: string,
  slug: string,
  shard: AiSecretShard,
): Promise<void> {
  await atomicWriteFile(shardPath(vaultPath, slug), JSON.stringify(shard, null, 2));
}

export async function loadApiKey(
  vaultPath: string,
  slug: string,
): Promise<string> {
  const shard = await readShard(vaultPath, slug);
  return shard.apiKey ? secrets.decryptToken(shard.apiKey) : "";
}

export async function saveApiKey(
  vaultPath: string,
  slug: string,
  apiKey: string,
): Promise<void> {
  await writeShard(vaultPath, slug, { apiKey: secrets.encryptToken(apiKey) });
}

export async function clearApiKey(vaultPath: string, slug: string): Promise<void> {
  await writeShard(vaultPath, slug, {});
  const settings = await settingsStore.loadAppSettings(vaultPath);
  await settingsStore.patchAppSettings(vaultPath, {
    ai: { ...settings.ai, hasApiKey: false },
  });
}

export async function configureProvider(
  vaultPath: string,
  slug: string,
  settingsPatch: Partial<Omit<AiSettings, "hasApiKey">>,
  apiKey?: string | null,
): Promise<AiProviderStatus> {
  const current = await settingsStore.loadAppSettings(vaultPath);
  let hasApiKey = current.ai.hasApiKey;
  if (apiKey !== undefined && apiKey !== null) {
    const trimmed = apiKey.trim();
    if (trimmed.length > 0) {
      await saveApiKey(vaultPath, slug, trimmed);
      hasApiKey = true;
    }
  }
  const patch: PartialAppSettings = {
    ai: {
      ...settingsPatch,
      hasApiKey,
    },
  };
  await settingsStore.patchAppSettings(vaultPath, patch);
  return getProviderStatus(vaultPath);
}

export async function getProviderStatus(
  vaultPath: string,
): Promise<AiProviderStatus> {
  const settings = await settingsStore.loadAppSettings(vaultPath);
  return {
    enabled: settings.ai.providerMode !== "disabled",
    providerMode: settings.ai.providerMode,
    model: settings.ai.model,
    baseUrl: settings.ai.baseUrl,
    hasApiKey: settings.ai.hasApiKey,
    credentialBackend: secrets.isAvailable() ? "safeStorage" : "plain",
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

function createStelaProvider() {
  return createProvider<"openai-completions">({
    id: STELA_PROVIDER_ID,
    name: "Stela OpenAI-compatible",
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

export function buildOpenAiCompatibleModel(settings: AiSettings): Model<"openai-completions"> {
  const contextWindow = settings.contextWindow || 128_000;
  return {
    id: settings.model,
    name: settings.model,
    api: "openai-completions",
    provider: STELA_PROVIDER_ID,
    baseUrl: settings.baseUrl.replace(/\/+$/, ""),
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
export function createStelaTransport(settings: AiSettings, apiKey: string): {
  models: Models;
  model: Model<"openai-completions">;
} {
  if (settings.providerMode === "disabled") {
    throw new AppError("ai_disabled", "AI provider is disabled.");
  }
  if (!apiKey) {
    throw new AppError("ai_missing_api_key", "AI provider API key is not configured.");
  }
  if (!settings.model.trim()) {
    throw new AppError("ai_missing_model", "AI provider model is not configured.");
  }
  if (!settings.baseUrl.trim()) {
    throw new AppError("ai_missing_base_url", "AI provider base URL is not configured.");
  }
  const models = createModels({ credentials: createStelaCredentialStore(apiKey) });
  models.setProvider(createStelaProvider());
  return { models, model: buildOpenAiCompatibleModel(settings) };
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
}: {
  settings: AiSettings;
  apiKey: string;
  system: string;
  user: string;
}): Promise<string> {
  const { models, model } = createStelaTransport(settings, apiKey);
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
