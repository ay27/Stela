import { promises as fs } from "node:fs";
import path from "node:path";

import { AppError } from "@shared/errors";
import type {
  AiProviderStatus,
  AiSettings,
  PartialAppSettings,
} from "@shared/types";

import { atomicWriteFile } from "../atomic-write";
import * as secrets from "../secrets";
import { vaultConfigDir } from "../vault-paths";
import * as settingsStore from "../settings-store";

const SECRETS_DIR = "secrets";
const AI_SECRET_FILE_PREFIX = "ai_";

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
  if (settings.providerMode === "disabled") {
    throw new AppError("ai_disabled", "AI provider is disabled.");
  }
  if (!apiKey) {
    throw new AppError("ai_missing_api_key", "AI provider API key is not configured.");
  }
  const baseUrl = settings.baseUrl.replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: settings.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new AppError(
      "ai_provider_failed",
      `AI provider returned ${response.status}: ${body.slice(0, 500)}`,
    );
  }
  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new AppError("ai_empty_response", "AI provider returned an empty response.");
  }
  return content;
}

// ---------- Agent (native function-calling) ----------

export type AgentChatRole = "system" | "user" | "assistant" | "tool";

/** OpenAI-compatible chat message, extended with tool-calling fields. */
export interface AgentChatMessage {
  role: AgentChatRole;
  /** Assistant messages with only tool_calls may have empty/null content. */
  content?: string | null;
  /** Present on assistant messages that requested tool calls. */
  tool_calls?: AgentToolCall[];
  /** Present on role:"tool" messages, echoing which call this answers. */
  tool_call_id?: string;
  /** Present on role:"tool" messages (OpenAI convention: tool result needs the fn name too). */
  name?: string;
}

export interface AgentToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** JSON-Schema tool definition passed as `tools` in the chat completions request. */
export interface AgentToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
}

export interface AgentTurnResult {
  content: string | null;
  toolCalls: AgentToolCall[];
}

/**
 * 一轮 harness 循环的模型调用：带 `tools` + `tool_choice:"auto"`，让模型自己
 * 决定要不要调工具。返回值把 `tool_calls` 透传给调用方处理，不在这里解析。
 */
export async function callAgentTurn({
  settings,
  apiKey,
  messages,
  tools,
  signal,
}: {
  settings: AiSettings;
  apiKey: string;
  messages: AgentChatMessage[];
  tools: AgentToolDef[];
  signal?: AbortSignal;
}): Promise<AgentTurnResult> {
  if (settings.providerMode === "disabled") {
    throw new AppError("ai_disabled", "AI provider is disabled.");
  }
  if (!apiKey) {
    throw new AppError("ai_missing_api_key", "AI provider API key is not configured.");
  }
  const baseUrl = settings.baseUrl.replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: settings.model,
      messages,
      tools,
      tool_choice: "auto",
    }),
    signal,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new AppError(
      "ai_provider_failed",
      `AI provider returned ${response.status}: ${body.slice(0, 500)}`,
    );
  }
  const data = (await response.json()) as {
    choices?: {
      message?: { content?: string | null; tool_calls?: AgentToolCall[] };
    }[];
  };
  const message = data.choices?.[0]?.message;
  if (!message) {
    throw new AppError("ai_empty_response", "AI provider returned an empty response.");
  }
  return {
    content: message.content ?? null,
    toolCalls: message.tool_calls ?? [],
  };
}

