import type { AssistantMessage, Message, Models } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isTransientGenerationError, withGenerationRecovery, type IGenerationDiagnostic } from "./generation-recovery";
import { redactForPrompt } from "./redaction";

export const EVIDENCE_CLOSEOUT_PROMPT =
  "The analysis stopped before verified completion. No further tool calls are allowed. " +
  "Summarize only supported results already returned by successful query/Python tools. " +
  "Explicitly say the analysis is incomplete, identify missing evidence, and distinguish estimates from exact results. " +
  "Do not invent an answer, perform new analysis, or claim the original task succeeded. " +
  "Follow the user's language; include the requested value only when already supported by committed evidence.";

export interface ICloseoutResult {
  status: "skipped" | "completed" | "failed" | "cancelled";
  reason: string;
  answer?: string;
  message?: AssistantMessage;
  error?: string;
}

/** Both product and eval use this policy. Caller cancellation is never recoverable. */
export function canCloseout(input: { failure: string; providerError?: string; failureStatus?: number; hasEvidence: boolean; remainingMs: number; cancelled: boolean }): boolean {
  if (input.cancelled || !input.hasEvidence || input.remainingMs <= 0) return false;
  if (input.failureStatus === 401 || input.failureStatus === 403 || /sensitive|content.?filter|safety|refusal|unauthori[sz]ed|forbidden|quota|billing/i.test(input.failure + " " + (input.providerError ?? ""))) return false;
  return isTransientGenerationError(input.failure, input.failureStatus) ||
    /^(task_timeout|tool_call_cap|model_turn_cap|bridge_call_timeout)$/.test(input.failure) ||
    /^Generation interrupted: (response_timeout|first_delta_timeout|idle_timeout|generation_deadline|recovery_deadline)$/.test(input.failure);
}

/** One provider request over committed history, outside the tool-dispatch loop. */
export async function closeoutGeneration(options: {
  models: Models; model: Parameters<Models["streamSimple"]>[0];
  context: { systemPrompt?: string; messages: AgentMessage[] };
  streamOptions?: Parameters<Models["streamSimple"]>[2];
  failure: string; providerError?: string; failureStatus?: number; hasEvidence: boolean; remainingMs: number; signal?: AbortSignal;
  onDiagnostic?: (event: IGenerationDiagnostic) => void;
}): Promise<ICloseoutResult> {
  if (!canCloseout({ ...options, cancelled: options.signal?.aborted === true })) {
    return { status: options.signal?.aborted ? "cancelled" : "skipped", reason: "ineligible" };
  }
  const context = { ...options.context, tools: [], messages: [
    ...options.context.messages
      .filter((m): m is Message => m.role === "user" || m.role === "assistant" || m.role === "toolResult")
      .filter((m) => m.role !== "assistant" || (m.stopReason !== "error" && m.stopReason !== "aborted")),
    { role: "user" as const, content: EVIDENCE_CLOSEOUT_PROMPT, timestamp: Date.now() },
  ] };
  try {
    const message = await withGenerationRecovery(options.models, { signal: options.signal,
      deadlineMs: Math.min(120_000, options.remainingMs), maxAttempts: 1, onDiagnostic: options.onDiagnostic,
    }).streamSimple(options.model, context, { ...options.streamOptions, signal: options.signal, maxRetries: 0 }).result();
    if (options.signal?.aborted) return { status: "cancelled", reason: "caller_cancelled", message };
    if (message.stopReason === "error" || message.stopReason === "aborted" || message.content.some(c => c.type === "toolCall")) {
      return { status: "failed", reason: "closeout_failed", error: message.errorMessage ?? "Closeout attempted a tool call", message };
    }
    const answer = message.content.filter(c => c.type === "text").map(c => c.text).join("\n").trim();
    return answer ? { status: "completed", reason: "evidence_only", answer, message }
      : { status: "failed", reason: "empty_closeout", message };
  } catch (error) {
    return { status: options.signal?.aborted ? "cancelled" : "failed", reason: "closeout_failed", error: redactForPrompt(String(error)).slice(0, 1000) };
  }
}
