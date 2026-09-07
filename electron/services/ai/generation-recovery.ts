import { createAssistantMessageEventStream, type AssistantMessage, type Models } from "@earendil-works/pi-ai";
import { setTimeout as delay } from "node:timers/promises";
import { redactForPrompt } from "./redaction";
import { randomUUID } from "node:crypto";

export type GenerationStopCause = "completed" | "caller_cancelled" | "response_timeout" | "first_delta_timeout" |
  "idle_timeout" | "generation_deadline" | "recovery_deadline" | "provider_error";

export interface IGenerationDiagnostic {
  type: "generation_attempt";
  attempt: number;
  status?: number;
  statusSource?: "response" | "sdk_error_prefix";
  requestId?: string;
  receivedPartial: boolean;
  error?: string;
  retry: boolean;
  usage: AssistantMessage["usage"];
  firstEventMs?: number;
  startedAt: number;
  generationId: string;
  stopCause: GenerationStopCause;
  lastEventMs?: number;
  maxDeltaGapMs: number;
  deltaCount: number;
  deltaBytes: number;
  usageCompleteness: "complete" | "partial" | "unknown";
  requestStarted: boolean;
  callerAbortReason?: string;
}

// pi-ai normalizes non-2xx errors as "503: ..." before onResponse can run.
// Accept only that anchored SDK prefix, never arbitrary numbers in provider prose.
function sdkErrorStatus(error: string): number | undefined {
  const match = /^([45]\d{2}):(?:\s|$)/.exec(error);
  return match ? Number(match[1]) : undefined;
}

export function isTransientGenerationError(error: string, status?: number): boolean {
  if (/sensitive|content.?filter|safety|refusal|unauthori[sz]ed|forbidden|quota|billing|abort|cancel/i.test(error)) return false;
  status ??= sdkErrorStatus(error);
  if (status !== undefined && status >= 400) return [408, 429, 500, 502, 503, 504].includes(status);
  return /^(?:TypeError:\s*)?terminated$/i.test(error.trim()) ||
    /ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR_SOCKET|socket hang up|fetch failed|premature close/i.test(error);
}

/** Retries only a provider generation, never AgentHarness.prompt or any tool.
 * Failed attempt content stays outside the agent context and its UI consumers.
 * All attempt usage is charged once on the final message, with per-attempt logs. */
export function withGenerationRecovery(models: Models, options: {
  signal?: AbortSignal;
  onDiagnostic?: (event: IGenerationDiagnostic) => void;
  deadlineMs?: number;
  responseTimeoutMs?: number;
  firstDeltaTimeoutMs?: number;
  idleTimeoutMs?: number;
  /** Starts after the first transient failure, never at normal generation start. */
  recoveryWindowMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  onPreview?: (message: AssistantMessage | null) => void;
} = {}): Models {
  const streamSimple: Models["streamSimple"] = (model, context, requestOptions) => {
    const output = createAssistantMessageEventStream();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const clear = (timer?: ReturnType<typeof setTimeout>) => {
      if (timer) { clearTimeout(timer); timers.delete(timer); }
    };
    void (async () => {
      const generationId = randomUUID();
      const timeout = new AbortController();
      const arm = (ms: number | undefined, cause: GenerationStopCause) => {
        if (ms === undefined) return undefined;
        const timer = setTimeout(() => timeout.abort(cause), Math.max(0, ms));
        timers.add(timer); return timer;
      };
      arm(options.deadlineMs, "generation_deadline");
      const signals = [options.signal, requestOptions?.signal, timeout.signal]
        .filter((s): s is AbortSignal => !!s);
      const signal = AbortSignal.any(signals);
      const usage: AssistantMessage["usage"] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      let final: AssistantMessage | undefined;
      let recoveryStarted = false;
      for (let attempt = 1; attempt <= Math.max(1, Math.min(3, options.maxAttempts ?? 3)); attempt++) {
        const started = Date.now();
        let firstEventMs: number | undefined;
        let status: number | undefined;
        let statusSource: IGenerationDiagnostic["statusSource"];
        let requestId: string | undefined;
        let receivedPartial = false;
        let retryAfterMs = 0;
        let lastEventMs: number | undefined;
        let maxDeltaGapMs = 0;
        let deltaCount = 0;
        let deltaBytes = 0;
        let observedUsage: AssistantMessage["usage"] | undefined;
        let requestStarted = false;
        const responseTimer = arm(options.responseTimeoutMs, "response_timeout");
        const firstTimer = arm(options.firstDeltaTimeoutMs, "first_delta_timeout");
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        let removeAbort = () => {};
        try {
          signal.throwIfAborted();
          requestStarted = true;
          const stream = models.streamSimple(model, context, { ...requestOptions, signal, maxRetries: 0,
            onResponse: async (response) => {
              clear(responseTimer);
              status = response.status;
              statusSource = "response";
              requestId = response.headers["x-request-id"] ?? response.headers["request-id"];
              const retryAfter = response.headers["retry-after"];
              if (retryAfter) retryAfterMs = /^\d+(\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now());
              await requestOptions?.onResponse?.(response, model);
            },
          });
          // Drain immediately; retain only the bounded final snapshot, not every delta.
          const aborted = new Promise<never>((_resolve, reject) => {
            const onAbort = () => reject(new Error("Generation interrupted"));
            signal.addEventListener("abort", onAbort, { once: true });
            removeAbort = () => signal.removeEventListener("abort", onAbort);
            if (signal.aborted) onAbort();
          });
          final = await Promise.race([aborted, (async () => {
            for await (const event of stream) {
              if (signal.aborted) break;
              if ("partial" in event) observedUsage = event.partial.usage;
              if (event.type === "done") observedUsage = event.message.usage;
              if (event.type === "error") observedUsage = event.error.usage;
              if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") {
                if (event.delta.length > 0) {
                  const elapsed = Date.now() - started;
                  firstEventMs ??= elapsed;
                  maxDeltaGapMs = Math.max(maxDeltaGapMs, elapsed - (lastEventMs ?? 0));
                  lastEventMs = elapsed;
                  deltaCount++; deltaBytes += Buffer.byteLength(event.delta);
                  receivedPartial = true;
                  clear(firstTimer); clear(responseTimer); clear(idleTimer);
                  idleTimer = arm(options.idleTimeoutMs, "idle_timeout");
                }
              }
              if (event.type === "text_delta") {
                try { options.onPreview?.(event.partial); } catch { /* UI cannot affect inference */ }
              }
            }
            return stream.result();
          })()]);
        } catch (error) {
          const cause = error instanceof Error && error.cause instanceof Error ? `; cause: ${error.cause.message}` : "";
          final = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
            timestamp: Date.now(), stopReason: signal.aborted ? "aborted" : "error",
            errorMessage: redactForPrompt(String(error) + cause).slice(0, 1000),
            usage: observedUsage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        } finally { removeAbort(); clear(responseTimer); clear(firstTimer); clear(idleTimer); }
        if (status === undefined && final.errorMessage) {
          status = sdkErrorStatus(final.errorMessage);
          if (status !== undefined) statusSource = "sdk_error_prefix";
        }
        for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) usage[key] += final.usage[key] ?? 0;
        for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) usage.cost[key] += final.usage.cost[key] ?? 0;
        const retry = !signal.aborted && attempt < (options.maxAttempts ?? 3) && attempt < 3 && final.stopReason === "error" &&
          retryAfterMs <= 10_000 && isTransientGenerationError(final.errorMessage ?? "", status);
        if (final.stopReason === "error" || final.stopReason === "aborted") {
          try { options.onPreview?.(null); } catch { /* UI cannot affect recovery */ }
        }
        const stopCause: GenerationStopCause = signal.aborted
          ? options.signal?.aborted || requestOptions?.signal?.aborted ? "caller_cancelled" : timeout.signal.reason as GenerationStopCause
          : final.stopReason === "error" || final.stopReason === "aborted" ? "provider_error" : "completed";
        const usageCompleteness = final.stopReason !== "error" && final.stopReason !== "aborted" && final.usage.totalTokens > 0
          ? "complete" : final.usage.totalTokens > 0 ? "partial" : "unknown";
        try { options.onDiagnostic?.({ type: "generation_attempt", attempt, status, statusSource, firstEventMs, startedAt: started,
          generationId, stopCause, lastEventMs, maxDeltaGapMs: Math.max(maxDeltaGapMs, Date.now() - started - (lastEventMs ?? 0)),
          deltaCount, deltaBytes, usageCompleteness,
          requestStarted,
          ...(stopCause === "caller_cancelled" ? { callerAbortReason: redactForPrompt(String(options.signal?.aborted ? options.signal.reason : requestOptions?.signal?.reason)).slice(0, 160) } : {}),
          requestId: requestId ? redactForPrompt(requestId).slice(0, 128) : undefined,
          receivedPartial, error: final.errorMessage ? redactForPrompt(final.errorMessage).slice(0, 1000) : undefined,
          retry, usage: final.usage }); } catch { /* diagnostics cannot affect inference */ }
        if (!retry) break;
        if (!recoveryStarted) { arm(options.recoveryWindowMs ?? 180_000, "recovery_deadline"); recoveryStarted = true; }
        try { await delay(Math.max(retryAfterMs || 0, (options.retryDelayMs ?? 500) * attempt), undefined, { signal }); }
        catch { final = { ...final, content: [], stopReason: "aborted", errorMessage: "Generation cancelled during recovery" }; break; }
      }
      if (!final) throw new Error("Generation did not produce a terminal message");
      if (signal.aborted) {
        const cancelled = options.signal?.aborted || requestOptions?.signal?.aborted;
        final = { ...final, content: [], stopReason: cancelled ? "aborted" : "error",
          errorMessage: cancelled ? "Generation cancelled" : `Generation interrupted: ${String(timeout.signal.reason)}` };
      }
      final = { ...final, usage };
      if (final.stopReason === "error" || final.stopReason === "aborted") {
        try { options.onPreview?.(null); } catch { /* presentation is best effort */ }
        const reason = final.stopReason;
        final = { ...final, content: [] };
        output.push({ type: "error", reason, error: final });
      } else {
        output.push({ type: "start", partial: final });
        output.push({ type: "done", reason: final.stopReason, message: final });
      }
      output.end(final);
    })().catch((error: unknown) => {
      const message: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), stopReason: "error", errorMessage: redactForPrompt(String(error)).slice(0, 1000),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      output.push({ type: "error", reason: "error", error: message }); output.end(message);
    }).finally(() => { for (const timer of timers) clearTimeout(timer); timers.clear(); });
    return output;
  };
  return new Proxy(models, { get(target, key) {
    if (key === "streamSimple") return streamSimple;
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
