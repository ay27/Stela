/**
 * Harness agent via `@earendil-works/pi-agent-core` AgentHarness.
 *
 * Keeps Stela IPC event shapes, proposal gates, and in-memory sessions.
 * Compacts proactively near context budget and once on provider overflow.
 */

import {
  AgentHarness,
  DEFAULT_COMPACTION_SETTINGS,
  InMemorySessionStorage,
  JsonlSessionStorage,
  Session,
  estimateContextTokens,
  shouldCompact,
  formatSkillsForSystemPrompt,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { isContextOverflow } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";

import type {
  AgentEvent,
  AgentPlanSnapshot,
  AgentProposalResponse,
  AgentRunRequest,
  AgentStrategyCheckpoint,
  ConnectionEntry,
  ConnectionMap,
} from "@shared/types";

import * as connectionsStore from "../connections-store";
import * as connectorRegistry from "../connectors/registry";
import * as deviceProfile from "../device-profile";
import * as journal from "../history-journal";
import { getLogger } from "../logger";
import * as resultStore from "../result-store";
import * as settingsStore from "../settings-store";
import * as sqlIndex from "../sql-index";
import {
  createQueryArtifactTarget,
  discardQueryArtifactTarget,
  finalizeMaterializedQueryArtifact,
  resolveQueryArtifact,
  writeBufferedQueryArtifact,
} from "../query-artifacts";
import { assistantText, buildSystemPrompt, buildUserContent, visibleAssistantText } from "./agent-prompt";
import {
  AnalysisEfficiencyLedger,
  efficiencyHintContent,
  formatStrategyCheckpoint,
  runStrategyReview,
  STRATEGY_CHECKPOINT_ENTRY,
  strategyReviewResponseFromError,
} from "./analysis-efficiency";
import {
  AGENT_SKILL_LIMITS_PROMPT,
  loadAgentSkills,
  selectPromptAgentSkills,
  type AgentSkillMaintenanceRecord,
  type LoadedAgentSkill,
} from "./agent-skills";
import {
  createPlanPersistenceBuffer,
  ExecutionPlanStore,
  formatExecutionPlanEntry,
} from "./execution-plan";
import {
  createAgentTools,
  type AgentRunRecorder,
  type ProposalRequest,
} from "./agent-tools";
import { createTransportForProfile, getActiveProfile, loadApiKey } from "./provider";
import { executePython } from "./python-runtime-broker";
import { redactForPrompt } from "./redaction";
import * as agentMetrics from "./agent-metrics";
import {
  buildSkillMaintenanceEvidence,
  formatSkillMaintenanceEvidence,
  hasSkillMaintenanceEvidence,
  type SkillMaintenanceEvidence,
} from "./skill-maintenance";
import {
  appendAgentHistoryEvent,
  appendAgentHistoryFinished,
  appendAgentHistoryProposalResponse,
  appendAgentHistoryStarted,
  openLocalAgentSessionStorage,
  prepareLocalAgentHistorySession,
  pruneLocalAgentHistory,
} from "./agent-history";
import {
  collectSkillSourceNotes,
  getSkillFreshness,
  tablesFromSkill,
  type AgentSkillFreshness,
  type SkillSourceNote,
} from "./skill-source-context";
import {
  cancelSkillMaintenance,
  enqueueSkillMaintenance,
  registerSkillMaintenanceActivity,
  SKILL_MAINTENANCE_MAX_TURNS,
} from "./skill-maintenance-queue";

const log = getLogger("ai.agent");
const TOOL_RESULT_SUMMARY_CHARS = 480;
const AGENT_PROGRESS_EMIT_INTERVAL_MS = 80;
const AGENT_PROGRESS_MAX_CHARS = 6_000;
const EXECUTION_PLAN_ENTRY = "execution_plan";
const OVERFLOW_CONTINUE_PROMPT =
  "The previous request exceeded the model context window. Continue from the compacted history and finish the user's last request.";
const SKILL_PROMPT_LIMIT = 8;
const SKILL_MAINTENANCE_PROMPT = `You are Stela's internal experience-maintenance agent.
The application already retrieved, ordered, and validated the material below. You have one decision: call save_skill exactly once for one durable rule, or make no tool call and give a one-sentence reason. Conversation explains intent; only verified evidence and source documents prove facts. Never copy result rows, absolute counts, snapshots, private data, narration, or one-off SQL. Automatic creation supports only sql-dialect, metric-definition, business-glossary, and data-lineage; never create analysis-runbook.

Use this frontmatter:
---
name: lowercase-hyphenated-name
description: concise reusable purpose
category: sql-dialect | metric-definition | business-glossary | data-lineage
tags: [lowercase-tag, another-tag]
---

Fill exactly one category template:
- sql-dialect: ## Scope; ## Rule; ## Valid Pattern; ## Verify
- metric-definition: ## Scope; ## Definition; ## Grain & Filters; ## Verify
- business-glossary: ## Scope; ## Term Mapping; ## Rule; ## Verify
- data-lineage: ## Scope; ## Source → Transform → Target; ## Keys & Grain; ## Verify

${AGENT_SKILL_LIMITS_PROMPT}`;

const SKILL_REFRESH_PROMPT = `You refresh one existing Stela knowledge Skill from current source documents. Update only the named Skill and keep its category. Preserve supported rules, replace conflicts with the newest source, and omit anything not proved by the supplied documents. Call save_skill exactly once, or make no tool call if a safe complete refresh is impossible. Use the required category headings and never copy result rows, snapshots, private data, narration, or one-off SQL. Analysis-runbook refresh is allowed only for an already source-tracked runbook.`;

function refreshTemplate(category: string | null): string {
  switch (category) {
    case "sql-dialect": return "## Scope; ## Rule; ## Valid Pattern; ## Verify";
    case "metric-definition": return "## Scope; ## Definition; ## Grain & Filters; ## Verify";
    case "business-glossary": return "## Scope; ## Term Mapping; ## Rule; ## Verify";
    case "data-lineage": return "## Scope; ## Source → Transform → Target; ## Keys & Grain; ## Verify";
    case "analysis-runbook": return "## Scope / Trigger; ## Preconditions; ## Ordered Checks; ## Decision → Action; ## Stop Conditions; ## Verify";
    default: return "Use the existing Skill category's required headings.";
  }
}

/**
 * `question` kind 需要把答案文本带回工具，所以 resolve 类型从 `boolean`
 * 放宽为 `boolean | string`：`false` = 拒绝，`true` = 同意，string = 答案。
 */
type ProposalResolver = (outcome: boolean | string) => void;

/** runId -> callId -> resolver，供 IPC 层的 respondToProposal 查找。 */
const activeProposals = new Map<string, Map<string, ProposalResolver>>();

/** `vaultPath + sessionId` -> 已打开的本地 JSONL session，避免每轮重复解析文件。 */
const sessions = new Map<string, { session: Session; storage: JsonlSessionStorage }>();
const historyResponses = new Map<string, AgentProposalResponse[]>();

/** IPC 入口：用户在前端 approve/reject 一个 proposal 时调用。找不到（已超时/run 已结束）返回 false。 */
export function respondToProposal(response: AgentProposalResponse): boolean {
  const pending = activeProposals.get(response.runId);
  const resolver = pending?.get(response.callId);
  if (!resolver) return false;
  historyResponses.get(response.runId)?.push(response);
  if (agentMetrics.isOpen()) {
    agentMetrics.addEvent(`agent:${response.runId}`, {
      type: "proposal_resolved",
      name: response.callId,
      payload: {
        callId: response.callId,
        approve: response.approve,
        answer: response.answer,
      },
    });
  }
  pending!.delete(response.callId);
  resolver(response.approve && response.answer !== undefined ? response.answer : response.approve);
  return true;
}

export function preparePersistentAgentSession(
  vaultPath: string,
  deviceSlug: string,
  sessionId: string | undefined,
) {
  return prepareLocalAgentHistorySession(vaultPath, deviceSlug, sessionId);
}

export async function prunePersistentAgentHistory(
  vaultPath: string,
  deviceSlug: string,
  getProtectedSessionIds: () => ReadonlySet<string>,
): Promise<void> {
  const pruned = await pruneLocalAgentHistory(vaultPath, deviceSlug, getProtectedSessionIds);
  for (const removed of pruned) {
    sessions.delete(`${vaultPath}\0${removed.sessionId}`);
  }
}

async function loadAvailableConnections(
  vaultPath: string,
  slug: string,
): Promise<{
  connections: ConnectionMap;
  dialects: Record<string, string | null>;
  queryLanguages: Record<string, Array<"sql" | "mongodb">>;
  mongoOperations: Record<string, Array<"find" | "aggregate">>;
}> {
  try {
    const connections = await connectionsStore.loadConnections(vaultPath, slug);
    const kinds = connectorRegistry.listKinds();
    const kindDialects = new Map(kinds.map((item) => [item.kind, item.dialect ?? null]));
    const kindLanguages = new Map(kinds.map((item) => [item.kind, item.queryLanguages ?? ["sql"]]));
    const kindMongoOperations = new Map(kinds.map((item) => [item.kind, item.mongoOperations ?? ["find"]]));
    return {
      connections,
      dialects: Object.fromEntries(
        Object.entries(connections).map(([name, connection]) => [
          name,
          kindDialects.get(connection.kind) ?? null,
        ]),
      ),
      queryLanguages: Object.fromEntries(
        Object.entries(connections).map(([name, connection]) => [
          name,
          kindLanguages.get(connection.kind) ?? ["sql"],
        ]),
      ),
      mongoOperations: Object.fromEntries(
        Object.entries(connections).map(([name, connection]) => [
          name,
          kindMongoOperations.get(connection.kind) ?? ["find"],
        ]),
      ),
    };
  } catch (err) {
    log.warn("loadAvailableConnections failed", { err: (err as Error).message });
    return { connections: {}, dialects: {}, queryLanguages: {}, mongoOperations: {} };
  }
}

/**
 * Agent 数据查询走与 RunSQL 相同的落盘路径：SQLite 缓存 + JSONL journal。
 * queryLanguage 区分 SQL 与结构化 MongoDB 查询。
 */
function recordAgentRun(vaultPath: string): AgentRunRecorder {
  return async (run) => {
    resultStore.saveRun({
      runId: run.runId,
      blockId: run.blockId,
      sql: run.sql,
      queryLanguage: run.queryLanguage ?? "sql",
      status: run.status,
      message: run.message,
      startedAt: run.startedAt,
      elapsedMs: run.elapsedMs,
      rowCount: run.rowCount,
      connectionName: run.connectionName,
      notePath: run.notePath,
    });
    if (run.columns.length > 0) resultStore.saveSchema(run.runId, run.columns);
    if (run.rows.length > 0) resultStore.saveRows(run.runId, run.rows, 0);
    await journal.appendRunById(vaultPath, run.runId, await deviceProfile.loadDeviceProfile());
  };
}

function makeRequestProposal(
  runId: string,
  callId: string,
  onEvent: (event: AgentEvent) => void,
  pending: Map<string, ProposalResolver>,
  signal: AbortSignal,
): (proposal: ProposalRequest) => Promise<boolean | string> {
  return (proposal) => {
    onEvent({ type: "proposal", runId, callId, kind: proposal.kind, payload: proposal.payload });
    return new Promise<boolean | string>((resolve) => {
      const onAbort = () => {
        pending.delete(callId);
        resolve(false);
      };
      pending.set(callId, (outcome) => {
        signal.removeEventListener("abort", onAbort);
        resolve(outcome);
      });
      signal.addEventListener("abort", onAbort, { once: true });
    });
  };
}

function toolResultSummary(result: unknown): string {
  if (!result || typeof result !== "object") return String(result ?? "");
  const record = result as { details?: { summary?: unknown }; content?: Array<{ type?: string; text?: string }> };
  if (typeof record.details?.summary === "string") {
    return record.details.summary.slice(0, TOOL_RESULT_SUMMARY_CHARS);
  }
  const text = (record.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text!)
    .join("");
  return text.slice(0, TOOL_RESULT_SUMMARY_CHARS);
}

function buildSkillMaintenanceInput(
  conversation: string,
  evidence: SkillMaintenanceEvidence[],
  notes: SkillSourceNote[],
  skills: LoadedAgentSkill[],
  refreshSkill?: LoadedAgentSkill,
): string {
  return [
    refreshSkill ? `Refresh only this Skill:\n${refreshSkill.content}` : "Create at most one new Skill.",
    `Current-task conversation (context, not proof):\n${conversation}`,
    "Verified tool evidence:",
    formatSkillMaintenanceEvidence(evidence) || "No tool evidence was available.",
    `Source documents, newest first:\n${notes.map((note) =>
      `--- SOURCE ${note.path} · ${note.updatedAt} ---\n${note.content}`
    ).join("\n\n")}`,
    `Existing related Skill metadata:\n${skills.map((skill) =>
      `${skill.metadata.name} · ${skill.metadata.category} · ${skill.metadata.description}`
    ).join("\n") || "none"}`,
  ].join("\n\n");
}

function conversationForMaintenance(messages: unknown[]): string {
  return messages.flatMap((message) => {
    if (!message || typeof message !== "object") return [];
    const record = message as { role?: unknown; content?: unknown };
    if (record.role !== "user" && record.role !== "assistant") return [];
    const text = typeof record.content === "string"
      ? record.content
      : Array.isArray(record.content)
        ? record.content.flatMap((block) =>
          block && typeof block === "object" && (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string"
            ? [(block as { text: string }).text]
            : [],
        ).join("\n")
        : "";
    return text.trim() ? [`${String(record.role).toUpperCase()}:\n${text.trim()}`] : [];
  }).join("\n\n");
}

function createSession(storage: InMemorySessionStorage | JsonlSessionStorage = new InMemorySessionStorage()): Session {
  return new Session(storage, {
    entryProjectors: {
      [EXECUTION_PLAN_ENTRY]: (entry) => {
        const data = entry.data as { runId?: string; plan?: AgentPlanSnapshot } | undefined;
        const snapshot = data?.plan;
        return [{
          role: "user",
          content:
            `Execution plan snapshot for run ${data?.runId ?? snapshot?.runId ?? "unknown"} ` +
            `version ${snapshot?.version ?? 0}. Use only the highest version matching the current run.\n` +
            formatExecutionPlanEntry(data ?? {}),
          timestamp: Date.now(),
        }];
      },
      [STRATEGY_CHECKPOINT_ENTRY]: (entry) => {
        const checkpoint = (entry.data as { checkpoint?: AgentStrategyCheckpoint } | undefined)?.checkpoint;
        return checkpoint
          ? [{ role: "user", content: formatStrategyCheckpoint(checkpoint), timestamp: Date.now() }]
          : [];
      },
    },
  });
}

function appendPlanEntry(session: Session, snapshot: AgentPlanSnapshot): Promise<string> {
  return session.appendCustomEntry(EXECUTION_PLAN_ENTRY, {
    runId: snapshot.runId,
    plan: structuredClone(snapshot),
  });
}

function appendStrategyCheckpoint(session: Session, checkpoint: AgentStrategyCheckpoint): Promise<string> {
  return session.appendCustomEntry(STRATEGY_CHECKPOINT_ENTRY, {
    runId: checkpoint.runId,
    checkpoint: structuredClone(checkpoint),
  });
}

async function getOrCreateSession(
  vaultPath: string,
  deviceSlug: string,
  sessionId: string,
): Promise<{ session: Session; storage: JsonlSessionStorage }> {
  const key = `${vaultPath}\0${sessionId}`;
  const existing = sessions.get(key);
  if (existing) return existing;
  const storage = await openLocalAgentSessionStorage(vaultPath, deviceSlug, sessionId);
  const created = { session: createSession(storage), storage };
  sessions.set(key, created);
  return created;
}

async function runSkillMaintenance(options: {
  vaultPath: string;
  request: AgentRunRequest;
  conversation: string;
  evidence: SkillMaintenanceEvidence[];
  models: Awaited<ReturnType<typeof createTransportForProfile>>["models"];
  model: Awaited<ReturnType<typeof createTransportForProfile>>["model"];
  skills: Awaited<ReturnType<typeof loadAgentSkills>>;
  connection: ConnectionEntry | null;
  dialect: string | null;
  aiSettings: Awaited<ReturnType<typeof settingsStore.loadAppSettings>>["ai"];
  onEvent: (event: AgentEvent) => void;
  signal: AbortSignal;
  refreshSkill?: LoadedAgentSkill;
  emitStatus?: boolean;
  metricRunId?: string;
}): Promise<boolean> {
  const { vaultPath, request, conversation, evidence, models, model, skills, connection, dialect, aiSettings, onEvent, signal, refreshSkill } = options;
  const metricRunId = options.metricRunId ?? `maintenance:${request.runId}:${randomUUID()}`;
  const metricStartedAt = Date.now();
  if (agentMetrics.isOpen() && !options.metricRunId) {
    const profile = getActiveProfile(aiSettings, request.profileId);
    agentMetrics.startRun({
      runId: metricRunId,
      parentRunId: `agent:${request.runId}`,
      surface: "skill_maintenance",
      operation: refreshSkill ? "stale_refresh" : "post_run_create",
      startedAt: metricStartedAt,
      profileId: profile.id,
      vendorId: profile.vendorId,
      model: profile.model,
      request: { conversation, evidence, refreshSkill: refreshSkill?.metadata ?? null },
    });
    agentMetrics.addEvent(metricRunId, { type: "eligible" });
  }
  if (agentMetrics.isOpen()) agentMetrics.addEvent(metricRunId, { type: "started" });
  const finishMetric = (
    status: "completed" | "error" | "cancelled" | "timeout" | "dropped",
    outcome: string,
    response?: unknown,
    error?: unknown,
  ) => {
    if (!agentMetrics.isOpen()) return;
    agentMetrics.finishRun(metricRunId, {
      status,
      outcome,
      response,
      errorCode: error ? "skill_maintenance_failed" : null,
      errorMessage: error instanceof Error ? error.message : error ? String(error) : null,
    });
  };
  const finishWithoutSource = (reasonCode: string, message: string, details: Record<string, unknown>) => {
    const response = { reasonCode, message, ...details };
    if (agentMetrics.isOpen()) agentMetrics.addEvent(metricRunId, { type: "skipped", payload: response });
    finishMetric("completed", "no_source", response);
    return false;
  };
  const actions: AgentSkillMaintenanceRecord[] = [];
  const promptSkills = rankAgentSkillsForRequest(skills.loaded, request, SKILL_PROMPT_LIMIT);
  const maintenanceTables = refreshSkill
    ? tablesFromSkill(refreshSkill)
    : Array.from(new Set(evidence.flatMap((item) => item.tables ?? []))).slice(0, 8);
  if (refreshSkill?.metadata.category === "analysis-runbook" && refreshSkill.metadata.sources.length === 0) {
    return finishWithoutSource(
      "untracked_analysis_runbook",
      "The analysis-runbook has no tracked source documents, so it cannot be refreshed safely.",
      { skill: refreshSkill.metadata.name, sourceDocuments: [] },
    );
  }
  let sourceNotes;
  try {
    sourceNotes = await collectSkillSourceNotes(vaultPath, maintenanceTables, sqlIndex.query);
  } catch (err) {
    finishMetric("error", "error", undefined, err);
    return false;
  }
  if (sourceNotes.length === 0) {
    return finishWithoutSource(
      "no_matching_source_documents",
      "No verified Vault Markdown source documents matched the tables found in this run, so the maintenance model was not called.",
      {
        sourceTables: maintenanceTables,
        evidenceItems: evidence.length,
        suggestion: "Link reusable knowledge to a Vault Markdown note, then run the Agent again.",
      },
    );
  }
  const maxInputChars = Math.max(16_000, Math.floor(model.contextWindow * 2.5));
  if (conversation.length > maxInputChars - 8_000) {
    finishMetric("completed", "input_too_large");
    return false;
  }
  let remaining = Math.max(4_000, maxInputChars - conversation.length - 8_000);
  const boundedNotes = sourceNotes.map((note) => {
    const content = note.content.slice(0, remaining);
    remaining = Math.max(0, remaining - content.length);
    return { ...note, content };
  }).filter((note) => note.content.length > 0);
  if (boundedNotes.length === 0) {
    finishMetric("completed", "input_too_large");
    return false;
  }
  if (options.emitStatus !== false) onEvent({ type: "skill_maintenance_started", runId: request.runId });
  const maintenanceHarness = new AgentHarness({
    env: new NodeExecutionEnv({ cwd: vaultPath }),
    session: createSession(),
    models,
    model,
    thinkingLevel: "off",
    streamOptions: { cacheRetention: "short" },
    systemPrompt: refreshSkill
      ? `${SKILL_REFRESH_PROMPT}\nRequired headings: ${refreshTemplate(refreshSkill.metadata.category)}`
      : SKILL_MAINTENANCE_PROMPT,
    resources: { skills: [] },
    tools: createAgentTools({
      ctx: {
        vaultPath,
        connectionName: request.connectionName ?? null,
        connection,
        maintenanceDialect: dialect,
        maintenanceTables,
        maintenanceSourcePaths: boundedNotes.map((note) => note.path),
        maintenanceRefreshName: refreshSkill?.metadata.name ?? null,
        aiSettings,
        connector: {
          listKinds: connectorRegistry.listKinds,
          listDatabases: connectorRegistry.listDatabases,
          listTables: connectorRegistry.listTables,
          execute: connectorRegistry.execute,
          describeTables: connectorRegistry.describeTables,
        },
        sqlIndex: { query: sqlIndex.query },
        skills: skills.loaded,
        mode: refreshSkill ? "refresh" : "maintenance",
        run: { runId: request.runId, sessionId: request.sessionId, notePath: request.notePath ?? null, questionsAsked: 0 },
        recordRun: recordAgentRun(vaultPath),
        onSkillMaintenance: (record) => actions.push(record),
      },
      requestProposal: async () => false,
    }),
  });
  let turns = 0;
  const unsubscribe = maintenanceHarness.subscribe((event) => {
    if (event.type === "turn_end" && ++turns >= SKILL_MAINTENANCE_MAX_TURNS) {
      void maintenanceHarness.abort();
    }
    if (event.type === "message_end" && event.message.role === "assistant" && agentMetrics.isOpen()) {
      agentMetrics.addUsage(metricRunId, event.message.usage);
      agentMetrics.addEvent(metricRunId, { type: "assistant_message", payload: event.message });
    }
  });
  const onAbort = () => void maintenanceHarness.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const maintenanceInput = buildSkillMaintenanceInput(
      conversation,
      evidence,
      boundedNotes,
      promptSkills,
      refreshSkill,
    );
    if (agentMetrics.isOpen()) {
      agentMetrics.addEvent(metricRunId, { type: "provider_prompt", payload: maintenanceInput });
    }
    const result = await maintenanceHarness.prompt(maintenanceInput);
    const completed = !signal.aborted && result.stopReason !== "aborted";
    if (options.emitStatus !== false) {
      onEvent({
        type: "skill_maintenance",
        runId: request.runId,
        actions,
        summary: !completed
          ? "Knowledge maintenance stopped at its time or turn limit."
          : actions.length > 0
            ? `Updated ${actions.length} internal knowledge Skill${actions.length === 1 ? "" : "s"}.`
            : assistantText(result).trim().slice(0, 120) || "No durable knowledge required a Skill update.",
      });
    }
    if (!completed) {
      const timeout = signal.reason === "timeout";
      finishMetric(timeout ? "timeout" : "cancelled", timeout ? "timeout" : "cancelled", result);
    } else {
      for (const action of actions) {
        if (agentMetrics.isOpen()) agentMetrics.addEvent(metricRunId, { type: "skill_action", name: action.name, payload: action });
      }
      finishMetric(
        "completed",
        actions.length > 0 ? "saved" : "no_change",
        { result, actions },
      );
    }
    return completed && actions.length > 0;
  } catch (err) {
    log.warn("skill maintenance failed", {
      runId: request.runId,
      err: err instanceof Error ? err.message : String(err),
    });
    if (options.emitStatus !== false) {
      onEvent({
        type: "skill_maintenance",
        runId: request.runId,
        actions,
        summary: "Skill maintenance could not complete; the answer above is unaffected.",
      });
    }
    finishMetric("error", "error", undefined, err);
    return false;
  } finally {
    unsubscribe();
    signal.removeEventListener("abort", onAbort);
  }
}

export interface SkillMaintenanceJob {
  run(signal: AbortSignal): Promise<void>;
  dropped(): void;
}

export function startSkillMaintenanceJob(vaultPath: string, job: SkillMaintenanceJob): void {
  enqueueSkillMaintenance(vaultPath, job.run, job.dropped);
}

export interface RunAgentOptions {
  vaultPath: string;
  slug: string;
  request: AgentRunRequest;
  onEvent: (event: AgentEvent) => void;
  signal: AbortSignal;
}

export async function runAgent(options: RunAgentOptions): Promise<SkillMaintenanceJob | null | undefined> {
  const { vaultPath, slug, onEvent, signal } = options;
  let request = options.request;
  if (!request.sessionId) {
    const session = await preparePersistentAgentSession(vaultPath, slug, undefined);
    request = { ...request, sessionId: session.sessionId };
  }
  const runId = request.runId;
  const metricRunId = `agent:${runId}`;
  const metricStartedAt = Date.now();
  let metricStarted = false;
  let metricFinished = false;
  let metricFirstResult = false;
  const pending = new Map<string, ProposalResolver>();
  const historyEvents: AgentEvent[] = [];
  const emit = (event: AgentEvent) => {
    historyEvents.push(event);
    onEvent(event);
    if (!metricStarted || !agentMetrics.isOpen()) return;
    agentMetrics.addEvent(metricRunId, { type: event.type, payload: event });
    if (!metricFirstResult && (event.type === "tool_call" || event.type === "final")) {
      metricFirstResult = true;
      agentMetrics.setFirstResult(metricRunId, Date.now() - metricStartedAt);
    }
    if (metricFinished) return;
    if (event.type === "final") {
      metricFinished = true;
      agentMetrics.finishRun(metricRunId, { status: "completed", response: event });
    } else if (event.type === "error") {
      metricFinished = true;
      agentMetrics.finishRun(metricRunId, {
        status: "error",
        errorCode: "agent_error",
        errorMessage: event.message,
        response: event,
      });
    } else if (event.type === "cancelled") {
      metricFinished = true;
      agentMetrics.finishRun(metricRunId, { status: "cancelled", response: event });
    }
  };
  const emitHistoryOnly = (event: AgentEvent) => {
    historyEvents.push(event);
    onEvent(event);
  };
  activeProposals.set(runId, pending);
  historyResponses.set(runId, []);

  let harness: AgentHarness | null = null;
  let session: Session | null = null;
  let historyStorage: JsonlSessionStorage | null = null;
  let plan: ExecutionPlanStore | null = null;
  const normalSkillActions: AgentSkillMaintenanceRecord[] = [];
  const maintenanceEvidence: SkillMaintenanceEvidence[] = [];
  let maintenanceJob: SkillMaintenanceJob | null = null;
  const onAbort = () => {
    void harness?.abort();
  };
  signal.addEventListener("abort", onAbort);

  try {
    const opened = await getOrCreateSession(vaultPath, slug, request.sessionId);
    session = opened.session;
    historyStorage = opened.storage;
    await appendAgentHistoryStarted(historyStorage, request);
    emit({ type: "started", runId });
    const settings = await settingsStore.loadAppSettings(vaultPath);
    if (settings.ai.providerMode === "disabled") {
      emit({ type: "error", runId, message: "AI provider is disabled. Enable it in Settings → AI." });
      return;
    }
    const profile = getActiveProfile(settings.ai, request.profileId);
    if (agentMetrics.isOpen()) {
      agentMetrics.startRun({
        runId: metricRunId,
        surface: "agent",
        operation: request.entryPoint ?? "chat",
        startedAt: metricStartedAt,
        profileId: profile.id,
        vendorId: profile.vendorId,
        model: profile.model,
        request,
      });
      metricStarted = true;
      agentMetrics.addEvent(metricRunId, { type: "started", payload: { runId } });
    }
    const apiKey = await loadApiKey(vaultPath, slug, profile.id);
    const available = await loadAvailableConnections(vaultPath, slug);
    const connection = request.connectionName
      ? available.connections[request.connectionName] ?? null
      : null;
    const dialect = request.connectionName
      ? available.dialects[request.connectionName] ?? null
      : null;
    const skills = await loadAgentSkills(vaultPath);
    const explicitSkillMaintenance = request.entryPoint === "knowledge-maintenance";
    const skillEvidence = { notePaths: new Set<string>(), tables: new Set<string>() };
    const freshnessCache = new WeakMap<LoadedAgentSkill, Promise<AgentSkillFreshness>>();
    const resolveSkillFreshness = (skill: LoadedAgentSkill): Promise<AgentSkillFreshness> => {
      const cached = freshnessCache.get(skill);
      if (cached) return cached;
      const pending = getSkillFreshness(vaultPath, skill, sqlIndex.query);
      freshnessCache.set(skill, pending);
      return pending;
    };
    const promptSkills = await selectPromptAgentSkills(
      skills.loaded,
      request,
      SKILL_PROMPT_LIMIT,
      async (skill) => await resolveSkillFreshness(skill) === "fresh",
    );
    const { models, model, reasoning } = createTransportForProfile(settings.ai, apiKey, profile.id);
    const contextWindow = model.contextWindow;
    const systemPrompt = buildSystemPrompt();
    const skillMetadata = formatSkillsForSystemPrompt(promptSkills.map((item) => item.skill));
    if (agentMetrics.isOpen()) {
      agentMetrics.addEvent(metricRunId, { type: "system_prompt", payload: systemPrompt });
      for (const skill of promptSkills) {
        agentMetrics.addEvent(metricRunId, {
          type: "skill_candidate",
          name: skill.metadata.name,
          payload: { category: skill.metadata.category, source: "prompt" },
        });
      }
    }
    plan = new ExecutionPlanStore(runId, (snapshot) => {
      emit({ type: "plan_updated", runId, plan: snapshot });
    });
    const planPersistence = createPlanPersistenceBuffer((snapshot) =>
      appendPlanEntry(session!, snapshot).then(() => undefined)
    );

    const emitUsage = async (estimated: boolean) => {
      const context = await session.buildContext();
      const estimate = estimateContextTokens(context.messages);
      emit({
        type: "context_usage",
        runId,
        usedTokens: estimate.tokens,
        contextWindow,
        estimated,
      });
    };

    const compactOnce = async () => {
      if (!harness) return;
      emit({ type: "compaction", runId, phase: "started" });
      await harness.compact(
        "Preserve the current execution plan, completed evidence, the active step, every blocked acceptance condition, and the latest strategy-review checkpoint.",
      );
      emit({ type: "compaction", runId, phase: "completed" });
      await emitUsage(true);
    };

    const harnessThinkingLevel = reasoning.effective;
    harness = new AgentHarness({
      env: new NodeExecutionEnv({ cwd: vaultPath }),
      session,
      models,
      model,
      thinkingLevel: harnessThinkingLevel,
      systemPrompt,
      streamOptions: { cacheRetention: "short" },
      resources: { skills: promptSkills.map((item) => item.skill) },
      tools: createAgentTools({
        ctx: {
          vaultPath,
          connectionName: request.connectionName ?? null,
          connection,
          connections: available.connections,
          connectionDialects: available.dialects,
          aiSettings: settings.ai,
          connector: {
            listKinds: connectorRegistry.listKinds,
            listDatabases: connectorRegistry.listDatabases,
            listTables: connectorRegistry.listTables,
            execute: connectorRegistry.execute,
            executeUnbounded: connectorRegistry.executeUnbounded,
            executeQuery: connectorRegistry.executeQuery,
            materializeQuery: connectorRegistry.materializeQuery,
            materializeDataQuery: connectorRegistry.materializeDataQuery,
            describeTables: connectorRegistry.describeTables,
          },
          queryArtifacts: {
            createTarget: createQueryArtifactTarget,
            finalize: finalizeMaterializedQueryArtifact,
            writeBuffered: writeBufferedQueryArtifact,
            resolve: resolveQueryArtifact,
            discard: discardQueryArtifactTarget,
          },
          pythonExecutor: { execute: executePython },
          signal,
          sqlIndex: { query: sqlIndex.query },
          skills: skills.loaded,
          mode: "normal",
          explicitSkillMaintenance,
          skillEvidence,
          getSkillFreshness: resolveSkillFreshness,
          ensureSkillFresh: async (skill) => {
            if (await resolveSkillFreshness(skill) !== "stale") return skill;
            if (!settings.ai.automaticSkillMaintenanceEnabled) return null;
            if (skill.metadata.category === "analysis-runbook" && skill.metadata.sources.length === 0) {
              return null;
            }
            cancelSkillMaintenance(vaultPath);
            const activity = registerSkillMaintenanceActivity(vaultPath, signal);
            let refreshed: boolean;
            try {
              refreshed = await runSkillMaintenance({
                vaultPath,
                request,
                conversation: conversationForMaintenance((await session!.buildContext()).messages),
                evidence: maintenanceEvidence.slice(-24),
                models,
                model,
                skills,
                connection,
                dialect,
                aiSettings: settings.ai,
                onEvent: emit,
                signal: activity.signal,
                refreshSkill: skill,
                emitStatus: false,
              });
            } finally {
              activity.dispose();
            }
            if (!refreshed) return null;
            const reloaded = await loadAgentSkills(vaultPath);
            skills.loaded.splice(0, skills.loaded.length, ...reloaded.loaded);
            return skills.loaded.find((item) => item.metadata.name === skill.metadata.name) ?? null;
          },
          run: { runId, sessionId: request.sessionId, notePath: request.notePath ?? null, questionsAsked: 0 },
          chartRuns: new Map(),
          canvasRefresh: request.canvasRefresh ? {
            path: request.canvasRefresh.path,
            sourceId: request.canvasRefresh.sourceId ?? null,
            committed: false,
          } : undefined,
          resolveChartRun: async (chartRunId) => {
            if (!resultStore.runExists(chartRunId)) await journal.importRun(vaultPath, chartRunId);
            return resultStore.getRun(chartRunId);
          },
          onCanvasUpdated: (event) => emit({ type: "canvas_updated", runId, ...event }),
          plan,
          persistPlan: planPersistence.enqueue,
          rewriteTargets: new Map(
            (request.attachments ?? []).flatMap((attachment) =>
              attachment.kind === "runsql" && attachment.rewriteTargetId
                ? [[attachment.rewriteTargetId, { sql: attachment.sql, sourcePath: attachment.sourcePath }]]
                : [],
            ),
          ),
          recordRun: recordAgentRun(vaultPath),
          onSkillMaintenance: (record) => normalSkillActions.push(record),
          onSkillUsage: (record) => {
            if (!agentMetrics.isOpen()) return;
            agentMetrics.addEvent(metricRunId, {
              type: record.type === "loaded" ? "skill_loaded" : "skill_candidate",
              name: record.name,
              payload: { category: record.category, source: record.source },
            });
          },
        },
        requestProposal: (toolCallId, proposal) =>
          makeRequestProposal(runId, toolCallId, emit, pending, signal)(proposal),
      }),
    });

    const efficiency = new AnalysisEfficiencyLedger();
    let pendingStrategyCheckpoint: AgentStrategyCheckpoint | null = null;
    const strategyUnsubscribe = harness.on("tool_result", async (event) => {
      const signalResult = efficiency.recordResult({
        toolName: event.toolName,
        args: event.input,
        content: event.content,
        isError: event.isError,
      });
      const content = signalResult.hint
        ? [...event.content, efficiencyHintContent(signalResult.hint)]
        : [...event.content];
      if (!signalResult.reviewTrigger) {
        return signalResult.hint ? { content } : undefined;
      }

      const trigger = signalResult.reviewTrigger;
      const reviewMetricRunId = `strategy:${runId}:${randomUUID()}`;
      emit({ type: "strategy_review", runId, status: "started", trigger });
      if (agentMetrics.isOpen()) {
        agentMetrics.startRun({
          runId: reviewMetricRunId,
          parentRunId: metricRunId,
          surface: "strategy_review",
          operation: trigger,
          profileId: profile.id,
          vendorId: profile.vendorId,
          model: profile.model,
          request: { metrics: efficiency.metrics(), observations: efficiency.recent() },
        });
      }
      try {
        const reviewed = await runStrategyReview({
          models,
          model,
          reasoningEffort: harnessThinkingLevel,
          signal,
          sessionId: `stela-strategy-review:${profile.id}`,
          review: {
            runId,
            goal: redactForPrompt(request.prompt),
            plan: plan.formatForContext(),
            capabilities: redactForPrompt(JSON.stringify({
              activeConnection: request.connectionName ?? null,
              queryLanguages: request.connectionName
                ? available.queryLanguages[request.connectionName] ?? ["sql"]
                : [],
              mongoOperations: request.connectionName
                ? available.mongoOperations[request.connectionName] ?? ["find"]
                : [],
              executePython: true,
            })),
            trigger,
            metrics: efficiency.metrics(),
            observations: efficiency.recent(),
          },
        });
        efficiency.markReviewCompleted();
        reviewed.checkpoint.metrics = efficiency.metrics();
        pendingStrategyCheckpoint = reviewed.checkpoint;
        if (agentMetrics.isOpen()) {
          agentMetrics.addUsage(metricRunId, reviewed.message.usage);
          agentMetrics.addUsage(reviewMetricRunId, reviewed.message.usage);
          agentMetrics.finishRun(reviewMetricRunId, {
            status: "completed",
            outcome: reviewed.checkpoint.advice.assessment,
            response: reviewed.checkpoint,
          });
        }
        emit({
          type: "strategy_review",
          runId,
          status: "completed",
          trigger,
          checkpoint: reviewed.checkpoint,
        });
        content.push(efficiencyHintContent(formatStrategyCheckpoint(reviewed.checkpoint)));
      } catch (error) {
        efficiency.markReviewFailed();
        const message = error instanceof Error ? error.message : String(error);
        const failureResponse = strategyReviewResponseFromError(error);
        if (agentMetrics.isOpen()) {
          if (failureResponse) {
            agentMetrics.addUsage(metricRunId, failureResponse.usage);
            agentMetrics.addUsage(reviewMetricRunId, failureResponse.usage);
          }
          agentMetrics.finishRun(reviewMetricRunId, {
            status: signal.aborted ? "cancelled" : "error",
            outcome: "unavailable",
            errorCode: "strategy_review_failed",
            errorMessage: message,
            response: failureResponse,
          });
        }
        emit({ type: "strategy_review", runId, status: "failed", trigger, message });
        content.push(efficiencyHintContent(
          "Strategy review was unavailable. Continue the main analysis, but prefer a materially different set-based or artifact-backed approach over more probes in the same family.",
        ));
      }
      return { content };
    });

    const toolCalls = new Map<string, { name: string; args: unknown; startedAt: number; metricRunId: string }>();
    let harnessStepIndex = 0;
    let harnessStepStartedAt = metricStartedAt;
    let modelRequestStartedAt: number | null = null;
    let progressTimer: ReturnType<typeof setTimeout> | null = null;
    let progressContent = "";
    let progressLastEmittedAt = 0;
    let progressLastSnapshot = "";
    const clearProgressTimer = () => {
      if (progressTimer !== null) clearTimeout(progressTimer);
      progressTimer = null;
    };
    const boundedProgress = (message: AgentMessage): string => {
      const content = visibleAssistantText(message).trim();
      if (content.length <= AGENT_PROGRESS_MAX_CHARS) return content;
      return `${content.slice(0, AGENT_PROGRESS_MAX_CHARS - 4).trimEnd()}\n\n…`;
    };
    const emitStreamingProgress = () => {
      progressTimer = null;
      if (!progressContent || progressContent === progressLastSnapshot) return;
      progressLastSnapshot = progressContent;
      progressLastEmittedAt = Date.now();
      onEvent({
        type: "assistant_progress",
        runId,
        stepIndex: harnessStepIndex,
        content: progressContent,
        phase: "streaming",
      });
    };
    const scheduleStreamingProgress = (message: AgentMessage) => {
      progressContent = boundedProgress(message);
      if (!progressContent || progressContent === progressLastSnapshot) return;
      const remaining = AGENT_PROGRESS_EMIT_INTERVAL_MS - (Date.now() - progressLastEmittedAt);
      if (remaining <= 0) {
        clearProgressTimer();
        emitStreamingProgress();
      } else if (progressTimer === null) {
        progressTimer = setTimeout(emitStreamingProgress, remaining);
      }
    };
    const completeProgress = (message: AgentMessage) => {
      clearProgressTimer();
      progressContent = boundedProgress(message);
      if (progressContent) {
        progressLastSnapshot = progressContent;
        emitHistoryOnly({
          type: "assistant_progress",
          runId,
          stepIndex: harnessStepIndex,
          content: progressContent,
          phase: "completed",
        });
      }
    };
    const contextUnsubscribe = harness.on("context", (event) => {
      if (agentMetrics.isOpen()) {
        agentMetrics.addEvent(metricRunId, {
          type: "model_context",
          name: `step:${harnessStepIndex}`,
          payload: {
            stepIndex: harnessStepIndex,
            contextWindow,
            model: { provider: model.provider, id: model.id },
            thinkingLevel: harnessThinkingLevel,
            requestedReasoningEffort: reasoning.requested,
            effectiveReasoningEffort: reasoning.effective,
            messages: event.messages,
          },
        });
      }
      return undefined;
    });
    const providerPayloadUnsubscribe = harness.on("before_provider_payload", (event) => {
      modelRequestStartedAt = Date.now();
      if (agentMetrics.isOpen()) {
        agentMetrics.addEvent(metricRunId, {
          type: "provider_payload",
          name: `step:${harnessStepIndex}`,
          occurredAt: modelRequestStartedAt,
          payload: event.payload,
        });
      }
      return undefined;
    });
    const unsubscribe = harness.subscribe(async (event) => {
      if (event.type === "turn_start") {
        clearProgressTimer();
        progressContent = "";
        progressLastSnapshot = "";
        progressLastEmittedAt = 0;
        harnessStepIndex += 1;
        harnessStepStartedAt = Date.now();
        modelRequestStartedAt = null;
        if (agentMetrics.isOpen()) {
          agentMetrics.addEvent(metricRunId, {
            type: "agent_step_start",
            name: `step:${harnessStepIndex}`,
            occurredAt: harnessStepStartedAt,
            payload: { stepIndex: harnessStepIndex },
          });
        }
        return;
      }
      if (event.type === "turn_end") {
        if (pendingStrategyCheckpoint) {
          const checkpoint = pendingStrategyCheckpoint;
          pendingStrategyCheckpoint = null;
          await appendStrategyCheckpoint(session!, checkpoint);
        }
        if (agentMetrics.isOpen()) {
          agentMetrics.addEvent(metricRunId, {
            type: "agent_step_end",
            name: `step:${harnessStepIndex}`,
            durationMs: Date.now() - harnessStepStartedAt,
            payload: {
              stepIndex: harnessStepIndex,
              toolResultCount: event.toolResults.length,
            },
          });
        }
        await planPersistence.flush();
        return;
      }
      if (event.type === "tool_execution_start") {
        const startedAt = Date.now();
        const toolMetricRunId = `tool:${runId}:${event.toolCallId}`;
        toolCalls.set(event.toolCallId, {
          name: event.toolName,
          args: event.args ?? {},
          startedAt,
          metricRunId: toolMetricRunId,
        });
        if (agentMetrics.isOpen()) {
          agentMetrics.startRun({
            runId: toolMetricRunId,
            parentRunId: metricRunId,
            surface: "tool",
            operation: event.toolName,
            startedAt,
            profileId: profile.id,
            vendorId: profile.vendorId,
            model: profile.model,
            request: event.args ?? {},
          });
        }
        emit({
          type: "tool_call",
          runId,
          call: {
            callId: event.toolCallId,
            name: event.toolName,
            arguments: event.args ?? {},
          },
        });
        return;
      }
      if (event.type === "tool_execution_end") {
        const call = toolCalls.get(event.toolCallId);
        if (call) {
          maintenanceEvidence.push(buildSkillMaintenanceEvidence(
            call.name,
            call.args,
            event.result,
            event.isError,
          ));
          toolCalls.delete(event.toolCallId);
          if (agentMetrics.isOpen()) {
            agentMetrics.finishRun(call.metricRunId, {
              status: event.isError ? "error" : "completed",
              endedAt: Date.now(),
              errorCode: event.isError ? "tool_error" : null,
              errorMessage: event.isError ? toolResultSummary(event.result) : null,
              response: event.result,
            });
          }
        }
        emit({
          type: "tool_result",
          runId,
          callId: event.toolCallId,
          ok: !event.isError,
          summary: toolResultSummary(event.result),
        });
        void emitUsage(true);
        return;
      }
      if (event.type === "message_start" && event.message.role === "assistant" && agentMetrics.isOpen()) {
        const now = Date.now();
        agentMetrics.addEvent(metricRunId, {
          type: "model_first_token",
          name: `step:${harnessStepIndex}`,
          occurredAt: now,
          durationMs: modelRequestStartedAt === null ? null : now - modelRequestStartedAt,
          payload: { stepIndex: harnessStepIndex },
        });
        return;
      }
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        scheduleStreamingProgress(event.message);
        return;
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        completeProgress(event.message);
        if (agentMetrics.isOpen()) {
          const now = Date.now();
          agentMetrics.addUsage(metricRunId, event.message.usage);
          agentMetrics.addEvent(metricRunId, {
            type: "assistant_message",
            name: `step:${harnessStepIndex}`,
            occurredAt: now,
            durationMs: modelRequestStartedAt === null ? null : now - modelRequestStartedAt,
            payload: event.message,
          });
        }
        return;
      }
    });

    try {
      await emitUsage(true);
      const before = await session.buildContext();
      if (shouldCompact(estimateContextTokens(before.messages).tokens, contextWindow, DEFAULT_COMPACTION_SETTINGS)) {
        await compactOnce();
      }

      const userContent = buildUserContent(request, {
        connection,
        dialect,
        queryLanguages: request.connectionName
          ? available.queryLanguages[request.connectionName] ?? ["sql"]
          : [],
        mongoOperations: request.connectionName
          ? available.mongoOperations[request.connectionName] ?? ["find"]
          : [],
        contextSources: {
          vault_notes: "unknown",
          skills: skills.loaded.length > 0 ? "available" : "empty",
          sql_history: "unknown",
          canvas: "unknown",
          clarification: "available",
        },
        skillMetadata,
        availableConnections: Object.entries(available.connections)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([name, entry]) => ({
            name,
            kind: entry.kind,
            dialect: available.dialects[name] ?? null,
            queryLanguages: available.queryLanguages[name] ?? ["sql"],
            mongoOperations: available.mongoOperations[name] ?? ["find"],
          })),
      });
      let result = await harness.prompt(userContent);
      await emitUsage(false);

      if (signal.aborted || result.stopReason === "aborted") {
        emit({ type: "cancelled", runId });
        return;
      }

      if (isContextOverflow(result, contextWindow)) {
        try {
          await compactOnce();
          result = await harness.prompt(OVERFLOW_CONTINUE_PROMPT);
          await emitUsage(false);
        } catch (err) {
          if (signal.aborted) {
            emit({ type: "cancelled", runId });
            return;
          }
          emit({
            type: "error",
            runId,
            message: err instanceof Error ? err.message : String(err),
          });
          return;
        }

        if (signal.aborted || result.stopReason === "aborted") {
          emit({ type: "cancelled", runId });
          return;
        }
        if (isContextOverflow(result, contextWindow)) {
          emit({
            type: "error",
            runId,
            message: "Context still overflows after compaction.",
          });
          return;
        }
      }

      if (result.stopReason === "error") {
        emit({
          type: "error",
          runId,
          message: result.errorMessage ?? "Agent run failed.",
        });
        return;
      }

      const finalAnswer = visibleAssistantText(result).trim();
      if (agentMetrics.isOpen()) {
        agentMetrics.addEvent(metricRunId, { type: "analysis_efficiency", payload: efficiency.metrics() });
      }
      emit({ type: "final", runId, content: finalAnswer, stepIndex: harnessStepIndex });
      if (normalSkillActions.length > 0) {
        emit({
          type: "skill_maintenance",
          runId,
          actions: normalSkillActions,
          summary: `Updated ${normalSkillActions.length} internal knowledge Skill${normalSkillActions.length === 1 ? "" : "s"}.`,
        });
      } else if (hasSkillMaintenanceEvidence(maintenanceEvidence) && settings.ai.automaticSkillMaintenanceEnabled) {
        const context = await session.buildContext();
        const maintenanceMetricRunId = `maintenance:${runId}:${randomUUID()}`;
        if (agentMetrics.isOpen()) {
          agentMetrics.startRun({
            runId: maintenanceMetricRunId,
            parentRunId: metricRunId,
            surface: "skill_maintenance",
            operation: "post_run_create",
            profileId: profile.id,
            vendorId: profile.vendorId,
            model: profile.model,
            request: { evidence: maintenanceEvidence.slice(-24) },
          });
          agentMetrics.addEvent(maintenanceMetricRunId, { type: "eligible" });
          agentMetrics.addEvent(maintenanceMetricRunId, { type: "enqueued" });
        }
        const jobOptions = {
          vaultPath,
          request,
          conversation: conversationForMaintenance(context.messages),
          evidence: maintenanceEvidence.slice(-24),
          models,
          model,
          skills,
          connection,
          dialect,
          aiSettings: settings.ai,
          onEvent,
          metricRunId: maintenanceMetricRunId,
        };
        maintenanceJob = {
          run: async (maintenanceSignal) => {
            await runSkillMaintenance({ ...jobOptions, signal: maintenanceSignal });
          },
          dropped: () => {
            if (agentMetrics.isOpen()) {
              agentMetrics.finishRun(maintenanceMetricRunId, { status: "dropped", outcome: "dropped" });
            }
            onEvent({
              type: "skill_maintenance",
              runId,
              actions: [],
              summary: "A newer knowledge-maintenance task replaced this pending task.",
            });
          },
        };
      } else if (hasSkillMaintenanceEvidence(maintenanceEvidence)) {
        const disabledMetricRunId = `maintenance:${runId}:${randomUUID()}`;
        if (agentMetrics.isOpen()) {
          agentMetrics.startRun({
            runId: disabledMetricRunId,
            parentRunId: metricRunId,
            surface: "skill_maintenance",
            operation: "post_run_create",
            profileId: profile.id,
            vendorId: profile.vendorId,
            model: profile.model,
            request: { evidence: maintenanceEvidence.slice(-24) },
          });
          agentMetrics.addEvent(disabledMetricRunId, { type: "eligible" });
          agentMetrics.finishRun(disabledMetricRunId, { status: "completed", outcome: "disabled" });
        }
      }
    } finally {
      clearProgressTimer();
      strategyUnsubscribe();
      contextUnsubscribe();
      providerPayloadUnsubscribe();
      unsubscribe();
    }
  } catch (err) {
    const isAbort = signal.aborted || (err instanceof Error && err.name === "AbortError");
    if (isAbort) {
      emit({ type: "cancelled", runId });
    } else {
      log.error("agent run failed", { runId, err: err instanceof Error ? err.message : String(err) });
      emit({ type: "error", runId, message: err instanceof Error ? err.message : String(err) });
    }
  } finally {
    if (metricStarted && !metricFinished && agentMetrics.isOpen()) {
      metricFinished = true;
      agentMetrics.finishRun(metricRunId, {
        status: signal.aborted ? "cancelled" : "error",
        errorCode: signal.aborted ? null : "agent_unsettled",
        errorMessage: signal.aborted ? null : "Agent run ended without a terminal event.",
      });
    }
    if (historyStorage) {
      try {
        for (const event of historyEvents) {
          await appendAgentHistoryEvent(historyStorage, event);
        }
        for (const response of historyResponses.get(runId) ?? []) {
          await appendAgentHistoryProposalResponse(historyStorage, response);
        }
        await appendAgentHistoryFinished(historyStorage, runId);
        emit({ type: "history_updated", runId });
      } catch (err) {
        log.warn("agent history write failed", {
          runId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    signal.removeEventListener("abort", onAbort);
    activeProposals.delete(runId);
    historyResponses.delete(runId);
  }
  return maintenanceJob;
}
