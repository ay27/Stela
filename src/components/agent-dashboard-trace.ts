import type {
  AgentMetricEventRecord,
  AgentMetricSessionTrace,
  AgentMetricSessionTurn,
  AgentMetricStatus,
} from "@shared/types";

export type AgentTraceItemKind =
  | "system"
  | "user"
  | "context"
  | "model"
  | "tool"
  | "review"
  | "maintenance"
  | "event";

export interface AgentTraceItem {
  id: string;
  turnIndex: number;
  kind: AgentTraceItemKind;
  label: string;
  summary: string;
  startedAt: number;
  durationMs: number | null;
  firstTokenMs: number | null;
  status: AgentMetricStatus | "info";
  payload: unknown;
  result: unknown;
}

export interface AgentTraceWaterfallSegment {
  id: string;
  kind: "input" | "model" | "tool";
  startedAt: number;
  durationMs: number;
  status: AgentMetricStatus | "info";
  label: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function assistantText(payload: unknown): string {
  const message = record(payload);
  if (!message || !Array.isArray(message.content)) return "";
  return message.content.flatMap((item) => {
    const content = record(item);
    return content?.type === "text" && typeof content.text === "string" ? [content.text] : [];
  }).join("\n").trim();
}

function modelStatus(payload: unknown): AgentMetricStatus {
  const stopReason = record(payload)?.stopReason;
  return stopReason === "error" ? "error" : stopReason === "aborted" ? "cancelled" : "completed";
}

function stepNumber(event: AgentMetricEventRecord, fallback: number): number {
  const named = event.name?.match(/^step:(\d+)$/)?.[1];
  if (named) return Number(named);
  const payload = record(event.payload);
  return typeof payload?.stepIndex === "number" ? payload.stepIndex : fallback;
}

function contextPayload(turn: AgentMetricSessionTurn): Record<string, unknown> | null {
  const request = turn.history.request;
  const context: Record<string, unknown> = {};
  if (request.workspaceContext) context.workspaceContext = request.workspaceContext;
  if (request.connectionName) context.connectionName = request.connectionName;
  if (request.notePath) context.notePath = request.notePath;
  if (request.canvasPath) context.canvasPath = request.canvasPath;
  if (request.mentionedTables?.length) context.mentionedTables = request.mentionedTables;
  if (request.referencedNotes?.length) context.referencedNotes = request.referencedNotes;
  if (request.message?.resources.length) context.resources = request.message.resources;
  if (request.attachments?.length) context.attachments = request.attachments;
  return Object.keys(context).length > 0 ? context : null;
}

function eventSummary(event: AgentMetricEventRecord): string {
  const payload = record(event.payload);
  if (event.type === "error" && typeof payload?.message === "string") return payload.message;
  if (event.type === "compaction" && typeof payload?.phase === "string") return payload.phase;
  if (event.type === "plan_updated") return "Execution plan updated";
  if (event.type === "context_usage" && typeof payload?.usedTokens === "number") {
    return `${payload.usedTokens} context tokens`;
  }
  return event.name ?? event.type;
}

const HIDDEN_ROOT_EVENTS = new Set([
  "started",
  "system_prompt",
  "provider_payload",
  "model_first_token",
  "assistant_message",
  "agent_step_start",
  "agent_step_end",
  "tool_call",
  "tool_result",
  "strategy_review",
  "final",
  "skill_candidate",
  "skill_loaded",
]);

export function buildAgentTurnTraceItems(turn: AgentMetricSessionTurn): AgentTraceItem[] {
  const trace = turn.trace;
  const rootStartedAt = trace?.root.run.startedAt ?? turn.history.startedAt;
  const items: AgentTraceItem[] = [];
  const systemPrompt = trace?.root.events.find((event) => event.type === "system_prompt");
  if (systemPrompt) {
    items.push({
      id: `turn:${turn.index}:system`,
      turnIndex: turn.index,
      kind: "system",
      label: "System prompt",
      summary: typeof systemPrompt.payload === "string" ? systemPrompt.payload.slice(0, 160) : "Initial system prompt",
      startedAt: rootStartedAt,
      durationMs: null,
      firstTokenMs: null,
      status: "info",
      payload: systemPrompt.payload,
      result: null,
    });
  }
  items.push({
    id: `turn:${turn.index}:user`,
    turnIndex: turn.index,
    kind: "user",
    label: "User",
    summary: turn.history.request.prompt.trim().replace(/\s+/g, " ").slice(0, 180) || "User message",
    startedAt: rootStartedAt,
    durationMs: null,
    firstTokenMs: null,
    status: "info",
    payload: turn.history.request.message ?? turn.history.request.prompt,
    result: null,
  });
  const context = contextPayload(turn);
  if (context) {
    items.push({
      id: `turn:${turn.index}:context`,
      turnIndex: turn.index,
      kind: "context",
      label: "Context",
      summary: Object.keys(context).join(" · "),
      startedAt: rootStartedAt,
      durationMs: null,
      firstTokenMs: null,
      status: "info",
      payload: context,
      result: null,
    });
  }
  if (!trace) return items;

  const providers = trace.root.events.filter((event) => event.type === "provider_payload");
  const firstTokens = trace.root.events.filter((event) => event.type === "model_first_token");
  const assistants = trace.root.events.filter((event) => event.type === "assistant_message");
  assistants.forEach((event, index) => {
    const step = stepNumber(event, index + 1);
    const provider = providers.find((candidate) => stepNumber(candidate, index + 1) === step) ?? providers[index];
    const firstToken = firstTokens.find((candidate) => stepNumber(candidate, index + 1) === step) ?? firstTokens[index];
    const text = assistantText(event.payload);
    items.push({
      id: `turn:${turn.index}:model:${event.id}`,
      turnIndex: turn.index,
      kind: "model",
      label: `Model step ${step}`,
      summary: text.replace(/\s+/g, " ").slice(0, 180) || "Assistant tool request",
      startedAt: provider?.occurredAt ?? Math.max(rootStartedAt, event.occurredAt - (event.durationMs ?? 0)),
      durationMs: event.durationMs ?? (provider ? Math.max(0, event.occurredAt - provider.occurredAt) : null),
      firstTokenMs: firstToken?.durationMs ?? null,
      status: modelStatus(event.payload),
      payload: provider?.payload ?? null,
      result: event.payload,
    });
  });

  for (const child of trace.descendants) {
    const kind = child.run.surface === "tool"
      ? "tool"
      : child.run.surface === "strategy_review"
        ? "review"
        : "maintenance";
    items.push({
      id: `turn:${turn.index}:run:${child.run.runId}`,
      turnIndex: turn.index,
      kind,
      label: child.run.operation,
      summary: child.run.outcome ?? child.run.errorMessage ?? child.run.operation,
      startedAt: child.run.startedAt,
      durationMs: child.run.durationMs,
      firstTokenMs: child.run.firstResultMs,
      status: child.run.status,
      payload: child.request,
      result: child.response,
    });
  }

  for (const event of trace.root.events) {
    if (HIDDEN_ROOT_EVENTS.has(event.type)) continue;
    const payload = record(event.payload);
    const status: AgentMetricStatus | "info" = event.type === "error"
      ? "error"
      : event.type === "cancelled"
        ? "cancelled"
        : "info";
    items.push({
      id: `turn:${turn.index}:event:${event.id}`,
      turnIndex: turn.index,
      kind: "event",
      label: event.type,
      summary: eventSummary(event),
      startedAt: event.occurredAt,
      durationMs: event.durationMs,
      firstTokenMs: null,
      status,
      payload: event.payload,
      result: payload?.result ?? null,
    });
  }

  const fixed = items.filter((item) => item.kind === "system" || item.kind === "user" || item.kind === "context");
  const runtime = items
    .filter((item) => !fixed.includes(item))
    .sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id));
  return [...fixed, ...runtime];
}

export function buildAgentSessionWaterfall(trace: AgentMetricSessionTrace): AgentTraceWaterfallSegment[] {
  return trace.turns.flatMap((turn) => buildAgentTurnTraceItems(turn).flatMap((item) => {
    const kind = item.kind === "model"
      ? "model"
      : item.kind === "tool" || item.kind === "review" || item.kind === "maintenance"
        ? "tool"
        : item.kind === "user" || item.kind === "context"
          ? "input"
          : null;
    if (!kind) return [];
    return [{
      id: item.id,
      kind,
      startedAt: item.startedAt,
      durationMs: Math.max(1, item.durationMs ?? 1),
      status: item.status,
      label: `Turn ${turn.index} · ${item.label}`,
    }];
  }));
}
