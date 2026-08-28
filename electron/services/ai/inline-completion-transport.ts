import { AppError } from "@shared/errors";
import type { AiProviderProfile } from "@shared/types";

const DEEPSEEK_FIM_URL = "https://api.deepseek.com/beta/completions";
const DEEPSEEK_VENDOR_ID = "deepseek";
const DEEPSEEK_FIM_MODEL = "deepseek-v4-flash";
const MAX_OUTPUT_TOKENS = 64;
const LOGPROBS = 5;

export interface IInlineCompletionResult {
  text: string;
  averageLogprob: number | null;
  usage: {
    promptTokens: number;
    completionTokens: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
  } | null;
}

interface DeepSeekCompletionResponse {
  choices?: Array<{
    text?: unknown;
    logprobs?: {
      token_logprobs?: unknown;
    } | null;
  }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    prompt_cache_hit_tokens?: unknown;
    prompt_cache_miss_tokens?: unknown;
  };
  error?: { message?: unknown };
}

export function usesNativeDeepSeekFim(profile: AiProviderProfile): boolean {
  return (
    profile.vendorId === DEEPSEEK_VENDOR_ID &&
    profile.model === DEEPSEEK_FIM_MODEL
  );
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function averageTokenLogprob(value: unknown): number | null {
  if (!Array.isArray(value)) return null;
  const values = value
    .filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry))
    .slice(0, 8);
  if (values.length === 0) return null;
  return values.reduce((sum, entry) => sum + entry, 0) / values.length;
}

export async function completeNativeDeepSeekFim({
  apiKey,
  model,
  prompt,
  suffix,
  signal,
  fetchImpl = fetch,
}: {
  apiKey: string;
  model: string;
  prompt: string;
  suffix: string;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<IInlineCompletionResult> {
  if (signal.aborted) {
    throw new AppError("ai_aborted", "AI request was aborted.");
  }
  if (!apiKey) {
    throw new AppError("ai_missing_api_key", "AI provider API key is not configured.");
  }

  let response: Response;
  try {
    response = await fetchImpl(DEEPSEEK_FIM_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        prompt,
        suffix,
        max_tokens: MAX_OUTPUT_TOKENS,
        temperature: 0,
        logprobs: LOGPROBS,
        stop: ["\n\n"],
        stream: false,
      }),
      signal,
    });
  } catch (err) {
    if (signal.aborted) {
      throw new AppError("ai_aborted", "AI request was aborted.");
    }
    throw new AppError(
      "ai_provider_failed",
      err instanceof Error ? err.message : "DeepSeek FIM request failed.",
    );
  }

  let payload: DeepSeekCompletionResponse;
  try {
    payload = (await response.json()) as DeepSeekCompletionResponse;
  } catch {
    throw new AppError(
      "ai_provider_failed",
      `DeepSeek FIM returned HTTP ${response.status} with an invalid response.`,
    );
  }
  if (!response.ok) {
    const detail =
      typeof payload.error?.message === "string"
        ? payload.error.message
        : `HTTP ${response.status}`;
    throw new AppError("ai_provider_failed", `DeepSeek FIM failed: ${detail}`);
  }

  const choice = payload.choices?.[0];
  if (!choice || typeof choice.text !== "string") {
    throw new AppError("ai_empty_response", "DeepSeek FIM returned no completion text.");
  }
  const usage = payload.usage
    ? {
        promptTokens: finiteNumber(payload.usage.prompt_tokens),
        completionTokens: finiteNumber(payload.usage.completion_tokens),
        cacheHitTokens: finiteNumber(payload.usage.prompt_cache_hit_tokens),
        cacheMissTokens: finiteNumber(payload.usage.prompt_cache_miss_tokens),
      }
    : null;
  return {
    text: choice.text,
    averageLogprob: averageTokenLogprob(choice.logprobs?.token_logprobs),
    usage,
  };
}
