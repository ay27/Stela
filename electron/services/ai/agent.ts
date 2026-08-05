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
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { isContextOverflow } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";

import type {
  AgentEvent,
  AgentPlanSnapshot,
  AgentProposalResponse,
  AgentRunRequest,
  ConnectionEntry,
} from "@shared/types";

import * as connectionsStore from "../connections-store";
import * as connectorRegistry from "../connectors/registry";
import * as deviceProfile from "../device-profile";
import * as journal from "../history-journal";
import { getLogger } from "../logger";
import * as resultStore from "../result-store";
import * as settingsStore from "../settings-store";
import * as sqlIndex from "../sql-index";
import { assistantText, buildSystemPrompt, buildUserContent } from "./agent-prompt";
import {
  AGENT_SKILL_LIMITS_PROMPT,
  loadAgentSkills,
  rankAgentSkills,
  type AgentSkillMaintenanceRecord,
  type LoadedAgentSkill,
} from "./agent-skills";
import { ExecutionPlanStore, formatExecutionPlanEntry } from "./execution-plan";
import {
  createAgentTools,
  type AgentRunRecorder,
  type ProposalRequest,
} from "./agent-tools";
import { createTransportForProfile, getActiveProfile, loadApiKey } from "./provider";
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
  isSkillStale,
  tablesFromSkill,
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

async function resolveConnection(
  vaultPath: string,
  slug: string,
  connectionName: string | null | undefined,
): Promise<{ connection: ConnectionEntry | null; dialect: string | null }> {
  if (!connectionName) return { connection: null, dialect: null };
  try {
    const connections = await connectionsStore.loadConnections(vaultPath, slug);
    const connection = connections[connectionName] ?? null;
    if (!connection) return { connection: null, dialect: null };
    const meta = connectorRegistry.listKinds().find((item) => item.kind === connection.kind);
    return { connection, dialect: meta?.dialect ?? null };
  } catch (err) {
    log.warn("resolveConnection failed", { err: (err as Error).message });
    return { connection: null, dialect: null };
  }
}

/**
 * agent 执行的 SQL 走与 RunSQL 完全相同的落盘路径：SQLite 缓存 + JSONL journal。
 * 这样 Run History 能看到、Git 能同步、用户能复核 agent 究竟查了什么。
 */
function recordAgentRun(vaultPath: string): AgentRunRecorder {
  return async (run) => {
    resultStore.saveRun({
      runId: run.runId,
      blockId: run.blockId,
      sql: run.sql,
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
    entryTransforms: [
      (entries) => {
        let latestPlan = -1;
        entries.forEach((entry, index) => {
          if (entry.type === "custom" && entry.customType === EXECUTION_PLAN_ENTRY) latestPlan = index;
        });
        return entries.filter(
          (entry, index) =>
            entry.type !== "custom" || entry.customType !== EXECUTION_PLAN_ENTRY || index === latestPlan,
        );
      },
    ],
    entryProjectors: {
      [EXECUTION_PLAN_ENTRY]: (entry) => {
        const data = entry.data as { plan?: ExecutionPlanStore | AgentPlanSnapshot } | undefined;
        return [{
          role: "user",
          content: `Current execution plan:\n${formatExecutionPlanEntry(data ?? {})}`,
          timestamp: Date.now(),
        }];
      },
    },
  });
}

function appendPlanEntry(session: Session, runId: string, plan: ExecutionPlanStore): Promise<string> {
  return session.appendCustomEntry(EXECUTION_PLAN_ENTRY, { runId, plan });
}

function appendPersistedPlanEntry(
  session: Session,
  runId: string,
  snapshot: AgentPlanSnapshot | null,
): Promise<string> {
  return session.appendCustomEntry(EXECUTION_PLAN_ENTRY, { runId, plan: snapshot });
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
  const promptSkills = rankAgentSkills(skills.loaded, request.prompt, SKILL_PROMPT_LIMIT);
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
        run: { runId: request.runId, notePath: request.notePath ?? null, questionsAsked: 0 },
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
        operation: "chat",
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
    const { connection, dialect } = await resolveConnection(vaultPath, slug, request.connectionName);
    const skills = await loadAgentSkills(vaultPath);
    const promptSkills = rankAgentSkills(skills.loaded, request.prompt, SKILL_PROMPT_LIMIT);
    const { models, model } = createTransportForProfile(settings.ai, apiKey, profile.id);
    const contextWindow = model.contextWindow;
    const systemPrompt =
      `${buildSystemPrompt(request, connection, dialect, AGENT_SKILL_LIMITS_PROMPT)}\n` +
      "Use search_skills before relying on domain knowledge that may exist in the internal Skill library.\n" +
      formatSkillsForSystemPrompt(promptSkills.map((item) => item.skill));
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
    await appendPlanEntry(session, runId, plan);

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
        "Preserve the current execution plan, completed evidence, the active step, and every blocked acceptance condition.",
      );
      emit({ type: "compaction", runId, phase: "completed" });
      await emitUsage(true);
    };

    harness = new AgentHarness({
      env: new NodeExecutionEnv({ cwd: vaultPath }),
      session,
      models,
      model,
      thinkingLevel: "off",
      systemPrompt,
      resources: { skills: promptSkills.map((item) => item.skill) },
      tools: createAgentTools({
        ctx: {
          vaultPath,
          connectionName: request.connectionName ?? null,
          connection,
          aiSettings: settings.ai,
          connector: {
            listKinds: connectorRegistry.listKinds,
            listDatabases: connectorRegistry.listDatabases,
            listTables: connectorRegistry.listTables,
            execute: connectorRegistry.execute,
            describeTables: connectorRegistry.describeTables,
          },
          sqlIndex: { query: sqlIndex.query },
          skills: skills.loaded,
          mode: "normal",
          ensureSkillFresh: async (skill) => {
            if (!(await isSkillStale(vaultPath, skill, sqlIndex.query))) return skill;
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
          run: { runId, notePath: request.notePath ?? null, questionsAsked: 0 },
          chartRuns: new Map(),
          resolveChartRun: async (chartRunId) => {
            if (!resultStore.runExists(chartRunId)) await journal.importRun(vaultPath, chartRunId);
            return resultStore.getRun(chartRunId);
          },
          plan,
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

    const toolCalls = new Map<string, { name: string; args: unknown; startedAt: number; metricRunId: string }>();
    const unsubscribe = harness.subscribe((event) => {
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
      if (event.type === "message_end" && event.message.role === "assistant" && agentMetrics.isOpen()) {
        agentMetrics.addUsage(metricRunId, event.message.usage);
        agentMetrics.addEvent(metricRunId, { type: "assistant_message", payload: event.message });
        return;
      }
      if (event.type === "before_provider_payload" && agentMetrics.isOpen()) {
        agentMetrics.addEvent(metricRunId, { type: "provider_payload", payload: event.payload });
      }
    });

    try {
      await emitUsage(true);
      const before = await session.buildContext();
      if (shouldCompact(estimateContextTokens(before.messages).tokens, contextWindow, DEFAULT_COMPACTION_SETTINGS)) {
        await compactOnce();
      }

      const userContent = buildUserContent(request);
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

      const finalAnswer = assistantText(result)
        .replace(
          /<\s*([A-Za-z][\w:.-]*(?:think|thinking|reasoning)[\w:.-]*)\b[^>]*>[\s\S]*?<\/\s*\1\s*>/gi,
          "",
        )
        .trim();
      emit({ type: "final", runId, content: finalAnswer });
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
        if (session && plan) {
          await appendPersistedPlanEntry(session, runId, plan.get());
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
