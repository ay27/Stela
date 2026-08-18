import type {
  AgentMetricEventRecord,
  AgentMetricSessionTrace,
  AgentMetricSessionTurn,
  AgentMetricStatus,
} from "@shared/types";

export type AgentTraceItemKind =
  | "model"
  | "tool"
  | "approval"
  | "review"
  | "compaction"
  | "maintenance";

export interface AgentTraceEffect {
  type: "plan_updated" | "canvas_updated";
  payload: unknown;
}

export interface AgentTraceModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  promptTokens: number;
  totalTokens: number;
  reasoningTokens: number | null;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  } | null;
}

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
  raw: unknown;
  rawType: string;
  contextWindow: number | null;
  thinkingLevel: string | null;
  requestedThinkingLevel?: string | null;
  usage: AgentTraceModelUsage | null;
  effects: AgentTraceEffect[];
}

export interface AgentTurnTraceProjection {
  input: {
    user: unknown;
    context: Record<string, unknown> | null;
    systemPrompt: unknown;
    skills: Array<{ type: string; name: string | null; payload: unknown }>;
  };
  main: AgentTraceItem[];
  maintenance: AgentTraceItem[];
  diagnostics: AgentMetricEventRecord[];
  analysisEfficiency: unknown;
  latestPlan: unknown;
  status: AgentMetricStatus | "unavailable";
  errorMessage: string | null;
}

export interface AgentTraceWaterfallSegment {
  id: string;
  kind: "model" | "tool" | "control";
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

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function assistantText(payload: unknown): string {
  const message = record(payload);
  if (!message || !Array.isArray(message.content)) return "";
  return message.content.flatMap((item) => {
    const content = record(item);
    return content?.type === "text" && typeof content.text === "string" ? [content.text] : [];
  }).join("\n").trim();
}

function assistantToolNames(payload: unknown): string[] {
  const message = record(payload);
  if (!message || !Array.isArray(message.content)) return [];
  return message.content.flatMap((item) => {
    const content = record(item);
    if (content?.type !== "toolCall") return [];
    return typeof content.name === "string" ? [content.name] : [];
  });
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

function eventForStep(events: AgentMetricEventRecord[], step: number, fallbackIndex: number): AgentMetricEventRecord | undefined {
  return events.find((event) => stepNumber(event, fallbackIndex + 1) === step) ?? events[fallbackIndex];
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

function parseModelUsage(payload: unknown): AgentTraceModelUsage | null {
  const usage = record(record(payload)?.usage);
  if (!usage) return null;
  const inputTokens = number(usage.input) ?? 0;
  const outputTokens = number(usage.output) ?? 0;
  const cacheReadTokens = number(usage.cacheRead) ?? 0;
  const cacheWriteTokens = number(usage.cacheWrite) ?? 0;
  const promptTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
  const totalTokens = number(usage.totalTokens) ?? promptTokens + outputTokens;
  const rawCost = record(usage.cost);
  const cost = rawCost ? {
    input: number(rawCost.input) ?? 0,
    output: number(rawCost.output) ?? 0,
    cacheRead: number(rawCost.cacheRead) ?? 0,
    cacheWrite: number(rawCost.cacheWrite) ?? 0,
    total: number(rawCost.total) ?? 0,
  } : null;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    promptTokens,
    totalTokens,
    reasoningTokens: number(usage.reasoning),
    cost,
  };
}

function fallbackContextWindow(events: AgentMetricEventRecord[]): number | null {
  for (const event of events) {
    if (event.type !== "context_usage") continue;
    const contextWindow = number(record(event.payload)?.contextWindow);
    if (contextWindow !== null) return contextWindow;
  }
  return null;
}

function proposalCallId(event: AgentMetricEventRecord): string | null {
  const payload = record(event.payload);
  return typeof payload?.callId === "string" ? payload.callId : event.name;
}

function findContainingOrPrevious(items: AgentTraceItem[], occurredAt: number): AgentTraceItem | null {
  const containing = items.find((item) => item.durationMs !== null &&
    item.startedAt <= occurredAt && occurredAt <= item.startedAt + item.durationMs);
  if (containing) return containing;
  return items
    .filter((item) => item.startedAt <= occurredAt)
    .sort((left, right) => right.startedAt - left.startedAt)[0] ?? null;
}

const CONSUMED_ROOT_EVENTS = new Set([
  "started",
  "system_prompt",
  "model_context",
  "provider_payload",
  "model_first_token",
  "assistant_message",
  "agent_step_start",
  "agent_step_end",
  "tool_call",
  "tool_result",
  "proposal",
  "proposal_resolved",
  "strategy_review",
  "compaction",
  "context_usage",
  "plan_updated",
  "canvas_updated",
  "final",
  "error",
  "cancelled",
  "skill_candidate",
  "skill_loaded",
  "skill_maintenance_started",
  "skill_maintenance",
  "analysis_efficiency",
  "history_updated",
]);

export function buildAgentTurnTrace(turn: AgentMetricSessionTurn): AgentTurnTraceProjection {
  const trace = turn.trace;
  const events = trace?.root.events ?? [];
  const rootStartedAt = trace?.root.run.startedAt ?? turn.history.startedAt;
  const main: AgentTraceItem[] = [];
  const maintenance: AgentTraceItem[] = [];
  const contexts = events.filter((event) => event.type === "model_context");
  const providers = events.filter((event) => event.type === "provider_payload");
  const firstTokens = events.filter((event) => event.type === "model_first_token");
  const assistants = events.filter((event) => event.type === "assistant_message");
  const legacyContextWindow = fallbackContextWindow(events);

  assistants.forEach((event, index) => {
    const step = stepNumber(event, index + 1);
    const modelContext = eventForStep(contexts, step, index);
    const provider = eventForStep(providers, step, index);
    const firstToken = eventForStep(firstTokens, step, index);
    const contextRecord = record(modelContext?.payload);
    const text = assistantText(event.payload);
    const toolNames = assistantToolNames(event.payload);
    main.push({
      id: `turn:${turn.index}:model:${event.id}`,
      turnIndex: turn.index,
      kind: "model",
      label: `Model step ${step}`,
      summary: text.replace(/\s+/g, " ").slice(0, 180) ||
        (toolNames.length > 0 ? `Requested ${toolNames.join(", ")}` : "Assistant response"),
      startedAt: provider?.occurredAt ?? modelContext?.occurredAt ??
        Math.max(rootStartedAt, event.occurredAt - (event.durationMs ?? 0)),
      durationMs: event.durationMs ?? (provider ? Math.max(0, event.occurredAt - provider.occurredAt) : null),
      firstTokenMs: firstToken?.durationMs ?? null,
      status: modelStatus(event.payload),
      payload: Array.isArray(contextRecord?.messages) ? contextRecord.messages : provider?.payload ?? null,
      result: event.payload,
      raw: {
        context: modelContext?.payload ?? null,
        providerPayload: provider?.payload ?? null,
        assistantMessage: event.payload,
      },
      rawType: "assistant_message",
      contextWindow: number(contextRecord?.contextWindow) ?? legacyContextWindow,
      thinkingLevel:
        typeof contextRecord?.effectiveReasoningEffort === "string"
          ? contextRecord.effectiveReasoningEffort
          : typeof contextRecord?.thinkingLevel === "string"
            ? contextRecord.thinkingLevel
            : null,
      requestedThinkingLevel:
        typeof contextRecord?.requestedReasoningEffort === "string"
          ? contextRecord.requestedReasoningEffort
          : typeof contextRecord?.thinkingLevel === "string"
            ? contextRecord.thinkingLevel
            : null,
      usage: parseModelUsage(event.payload),
      effects: [],
    });
  });

  if (trace) {
    for (const child of trace.descendants) {
      if (child.run.surface === "tool") {
        main.push({
          id: `turn:${turn.index}:run:${child.run.runId}`,
          turnIndex: turn.index,
          kind: "tool",
          label: child.run.operation,
          summary: child.run.outcome ?? child.run.errorMessage ?? child.run.operation,
          startedAt: child.run.startedAt,
          durationMs: child.run.durationMs,
          firstTokenMs: child.run.firstResultMs,
          status: child.run.status,
          payload: child.request,
          result: child.response,
          raw: child,
          rawType: child.run.surface,
          contextWindow: null,
          thinkingLevel: null,
          usage: null,
          effects: [],
        });
      } else if (child.run.surface === "strategy_review") {
        main.push({
          id: `turn:${turn.index}:run:${child.run.runId}`,
          turnIndex: turn.index,
          kind: "review",
          label: child.run.operation,
          summary: child.run.outcome ?? child.run.errorMessage ?? child.run.operation,
          startedAt: child.run.startedAt,
          durationMs: child.run.durationMs,
          firstTokenMs: child.run.firstResultMs,
          status: child.run.status,
          payload: child.request,
          result: child.response,
          raw: child,
          rawType: child.run.surface,
          contextWindow: null,
          thinkingLevel: null,
          usage: {
            inputTokens: child.run.inputTokens,
            outputTokens: child.run.outputTokens,
            cacheReadTokens: child.run.cacheReadTokens,
            cacheWriteTokens: child.run.cacheWriteTokens,
            promptTokens: child.run.inputTokens + child.run.cacheReadTokens + child.run.cacheWriteTokens,
            totalTokens: child.run.inputTokens + child.run.outputTokens + child.run.cacheReadTokens + child.run.cacheWriteTokens,
            reasoningTokens: null,
            cost: null,
          },
          effects: [],
        });
      } else if (child.run.surface === "skill_maintenance") {
        maintenance.push({
          id: `turn:${turn.index}:run:${child.run.runId}`,
          turnIndex: turn.index,
          kind: "maintenance",
          label: child.run.operation,
          summary: child.run.outcome ?? child.run.errorMessage ?? child.run.operation,
          startedAt: child.run.startedAt,
          durationMs: child.run.durationMs,
          firstTokenMs: child.run.firstResultMs,
          status: child.run.status,
          payload: child.request,
          result: child.response,
          raw: child,
          rawType: child.run.surface,
          contextWindow: null,
          thinkingLevel: null,
          usage: null,
          effects: [],
        });
      }
    }
  }

  const resolvedProposals = events.filter((event) => event.type === "proposal_resolved");
  const historyResponses = new Map(turn.history.proposalResponses.map((response) => [response.callId, response]));
  for (const event of events.filter((candidate) => candidate.type === "proposal")) {
    const payload = record(event.payload);
    const callId = proposalCallId(event);
    if (!callId) continue;
    const resolved = resolvedProposals.find((candidate) => proposalCallId(candidate) === callId);
    const response = resolved?.payload ?? historyResponses.get(callId) ?? null;
    const proposalKind = typeof payload?.kind === "string" ? payload.kind : "approval";
    main.push({
      id: `turn:${turn.index}:approval:${event.id}`,
      turnIndex: turn.index,
      kind: "approval",
      label: proposalKind,
      summary: resolved ? "User responded" : response ? "User response recorded" : "Waiting for user",
      startedAt: event.occurredAt,
      durationMs: resolved ? Math.max(0, resolved.occurredAt - event.occurredAt) : null,
      firstTokenMs: null,
      status: resolved || response ? "completed" : trace?.root.run.status === "running" ? "running" : "cancelled",
      payload: payload?.payload ?? event.payload,
      result: response,
      raw: { proposal: event.payload, response },
      rawType: "proposal",
      contextWindow: null,
      thinkingLevel: null,
      usage: null,
      effects: [],
    });
  }

  const compactionStarts: AgentMetricEventRecord[] = [];
  let compactionIndex = 0;
  for (const event of events.filter((candidate) => candidate.type === "compaction")) {
    const phase = record(event.payload)?.phase;
    if (phase === "started") {
      compactionStarts.push(event);
      continue;
    }
    if (phase !== "completed") continue;
    const started = compactionStarts.shift();
    compactionIndex += 1;
    main.push({
      id: `turn:${turn.index}:compaction:${started?.id ?? event.id}`,
      turnIndex: turn.index,
      kind: "compaction",
      label: `Compaction ${compactionIndex}`,
      summary: "Context compacted",
      startedAt: started?.occurredAt ?? event.occurredAt,
      durationMs: started ? Math.max(0, event.occurredAt - started.occurredAt) : null,
      firstTokenMs: null,
      status: "completed",
      payload: started?.payload ?? null,
      result: event.payload,
      raw: { started: started?.payload ?? null, completed: event.payload },
      rawType: "compaction",
      contextWindow: legacyContextWindow,
      thinkingLevel: null,
      usage: null,
      effects: [],
    });
  }
  for (const started of compactionStarts) {
    compactionIndex += 1;
    main.push({
      id: `turn:${turn.index}:compaction:${started.id}`,
      turnIndex: turn.index,
      kind: "compaction",
      label: `Compaction ${compactionIndex}`,
      summary: "Compaction did not complete",
      startedAt: started.occurredAt,
      durationMs: null,
      firstTokenMs: null,
      status: trace?.root.run.status === "running" ? "running" : "error",
      payload: started.payload,
      result: null,
      raw: { started: started.payload, completed: null },
      rawType: "compaction",
      contextWindow: legacyContextWindow,
      thinkingLevel: null,
      usage: null,
      effects: [],
    });
  }

  if (maintenance.length === 0) {
    for (const event of events.filter((candidate) => candidate.type === "skill_maintenance")) {
      const payload = record(event.payload);
      maintenance.push({
        id: `turn:${turn.index}:maintenance:${event.id}`,
        turnIndex: turn.index,
        kind: "maintenance",
        label: "skill_maintenance",
        summary: typeof payload?.summary === "string" ? payload.summary : "Skill maintenance completed",
        startedAt: event.occurredAt,
        durationMs: null,
        firstTokenMs: null,
        status: "completed",
        payload: null,
        result: event.payload,
        raw: event.payload,
        rawType: "skill_maintenance",
        contextWindow: null,
        thinkingLevel: null,
        usage: null,
        effects: [],
      });
    }
  }

  main.sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id));
  maintenance.sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id));
  for (const event of events) {
    if (event.type !== "plan_updated" && event.type !== "canvas_updated") continue;
    const owner = findContainingOrPrevious(main, event.occurredAt);
    owner?.effects.push({ type: event.type, payload: event.payload });
  }

  const systemPrompt = events.find((event) => event.type === "system_prompt")?.payload ?? null;
  const skills = events
    .filter((event) => event.type === "skill_candidate" || event.type === "skill_loaded")
    .map((event) => ({ type: event.type, name: event.name, payload: event.payload }));
  const diagnostics = events.filter((event) => !CONSUMED_ROOT_EVENTS.has(event.type));
  const latestPlan = events.findLast((event) => event.type === "plan_updated")?.payload ?? null;
  const analysisEfficiency = events.findLast((event) => event.type === "analysis_efficiency")?.payload ?? null;
  return {
    input: {
      user: turn.history.request.message ?? turn.history.request.prompt,
      context: contextPayload(turn),
      systemPrompt,
      skills,
    },
    main,
    maintenance,
    diagnostics,
    analysisEfficiency,
    latestPlan,
    status: trace?.root.run.status ?? "unavailable",
    errorMessage: trace?.root.run.errorMessage ?? null,
  };
}

export function buildAgentTurnTraceItems(turn: AgentMetricSessionTurn): AgentTraceItem[] {
  const projection = buildAgentTurnTrace(turn);
  return [...projection.main, ...projection.maintenance];
}

export function buildAgentSessionWaterfall(trace: AgentMetricSessionTrace): AgentTraceWaterfallSegment[] {
  return trace.turns.flatMap((turn) => buildAgentTurnTrace(turn).main.map((item) => ({
    id: item.id,
    kind: item.kind === "model" ? "model" : item.kind === "tool" ? "tool" : "control",
    startedAt: item.startedAt,
    durationMs: Math.max(1, item.durationMs ?? 1),
    status: item.status,
    label: `Turn ${turn.index} · ${item.label}`,
  })));
}
