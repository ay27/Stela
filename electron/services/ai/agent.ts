import { PrivacySession, openPrivacySession, type IPrivacyPersistence } from "./privacy-session";
import { privacyHistory } from "./privacy-history";
import { AgentHarness } from "./pi-harness";
import { Session, JsonlSessionStorage, InMemorySessionStorage } from "./pi-session";
import { ToolRepairBudget } from "./tool-repair";
import { buildSkillMaintenanceInput, MAINTENANCE_INPUT_CHARS, maintenanceModel, maintenanceHash, maintenanceNotes, maintenanceSkip, recordMaintenance } from "./maintenance-policy";
import { analysisToolSummary, readAnalysisSnapshot } from "../../shared/analysis-contract";
/**
 * Harness agent via `@earendil-works/pi-agent-core` AgentHarness.
 *
 * Keeps Stela IPC event shapes, proposal gates, and in-memory sessions.
 * Pi owns automatic compaction scheduling and context-overflow recovery.
 */

import {
  estimateContextTokens,
  formatSkillsForSystemPrompt,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
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

import { runsqlRewriteTargets } from "@shared/agent-message";

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
import { assistantText, buildSystemPrompt, buildUserContent, repairLegacyWorkspacePrompts, visibleAssistantText } from "./agent-prompt";
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
  rankAgentSkillsForRequest,
  selectPromptAgentSkills,
  type AgentSkillMaintenanceRecord,
  type LoadedAgentSkill,
} from "./agent-skills";
import { bundledSystemSkillsRoot } from "./bundled-skills";
import {
  createPlanPersistenceBuffer,
  ExecutionPlanStore,
  formatExecutionPlanEntry,
  formatPlanDeliveries,
  restoreSessionPlan,
} from "./execution-plan";
import {
  createAgentTools,
  proposalApprovalMode,
  type AgentAnalysisRunEvidence,
  type AgentRunRecorder,
  type ProposalRequest,
} from "./agent-tools";
import { createTransportForProfile, getActiveProfile, loadApiKey } from "./provider";
import { executePython, resetPythonWorkspace, describePythonWorkspace, setPythonWorkspaceClearListener } from "./python-runtime-broker";
import { createSemanticAgent, clearSemanticWorkspace } from "./semantic-agent";
import { withGenerationRecovery } from "./generation-recovery";
import { closeoutGeneration } from "./generation-closeout";
import { redactForPrompt } from "./redaction";
import * as agentMetrics from "./agent-metrics";
import {
  buildSkillMaintenanceEvidence,
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
  enqueueSkillMaintenance,
  SKILL_MAINTENANCE_MAX_TURNS,
} from "./skill-maintenance-queue";

const log = getLogger("ai.agent");
const TOOL_RESULT_SUMMARY_CHARS = 480;
const AGENT_PROGRESS_EMIT_INTERVAL_MS = 80;
const AGENT_PROGRESS_MAX_CHARS = 6_000;
const EXECUTION_PLAN_ENTRY = "execution_plan";
const SKILL_PROMPT_LIMIT = 8;
const SKILL_MAINTENANCE_PROMPT = `You are Stela's internal experience-maintenance agent.
The application retrieved source excerpts and observed tool outcomes. File identity does not establish business truth. You have one decision: call save_skill exactly once for one durable rule, or make no tool call and give a one-sentence reason. Conversation explains intent; only verified evidence and source documents prove facts. Source documents may be excerpts: never infer absence or universal rules from omitted material. A query snapshot does not prove a permanent business rule. If evidence is insufficient, do not save. Never copy result rows, absolute counts, snapshots, private data, narration, or one-off SQL. Automatic creation supports only sql-dialect, metric-definition, business-glossary, and data-lineage; never create analysis-runbook.

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
setPythonWorkspaceClearListener(clearSemanticWorkspace);
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
    clearSemanticWorkspace(vaultPath, removed.sessionId);
    await resetPythonWorkspace(vaultPath, removed.sessionId);
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
export function recordAgentRun(vaultPath: string): AgentRunRecorder {
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
  autoApplyEdits: boolean,
): (proposal: ProposalRequest) => Promise<boolean | string> {
  return (proposal) => {
    const approvalMode = proposalApprovalMode(autoApplyEdits, proposal.kind);
    return new Promise<boolean | string>((resolve) => {
      if (signal.aborted) { resolve(false); return; }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        pending.delete(callId);
        resolve(false);
      };
      if (proposal.kind === 'privacy_release') timer = setTimeout(onAbort, 5 * 60 * 1000);
      pending.set(callId, (outcome) => {
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(outcome);
      });
      signal.addEventListener("abort", onAbort, { once: true });
      // Register before emitting: automatic renderer responses can arrive in the
      // same event turn, unlike a human click.
      onEvent({
        type: "proposal",
        runId,
        callId,
        kind: proposal.kind,
        payload: proposal.payload,
        approvalMode,
      });
    });
  };
}

function toolResultSummary(result: unknown): string {
  if (!result || typeof result !== "object") return String(result ?? "");
  const record = result as { details?: { summary?: unknown }; content?: Array<{ type?: string; text?: string }> };
  if (typeof record.details?.summary === "string") {
    return analysisToolSummary(record.details.summary, TOOL_RESULT_SUMMARY_CHARS);
  }
  const text = (record.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text!)
    .join("");
  return analysisToolSummary(text, TOOL_RESULT_SUMMARY_CHARS);
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
    entryTransforms: [repairLegacyWorkspacePrompts],
    entryProjectors: {
      [EXECUTION_PLAN_ENTRY]: (entry) => {
        const data = entry.data as { runId?: string; plan?: AgentPlanSnapshot } | undefined;
        const snapshot = data?.plan;
        return [{
          role: "user",
          content:
            `Execution plan snapshot for run ${data?.runId ?? snapshot?.runId ?? "unknown"} ` +
            `version ${snapshot?.version ?? 0}. Historical snapshot only. The current runtime plan below is authoritative for progress; never replay old tools.\n` +
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

export async function runSkillMaintenance(options: {
  privacy?: PrivacySession;
  vaultPath: string;
  request: AgentRunRequest;
  conversation: string;
  evidence: SkillMaintenanceEvidence[];
  generatedNotePaths?: ReadonlySet<string>;
  observedColumns?: string[];
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
  /** Explicit retry and isolated replay bypass automatic candidate receipts. */
  forceMaintenance?: boolean;
  historyStorage?: JsonlSessionStorage | null;
}): Promise<boolean> {
  const { vaultPath, request, conversation, evidence, models, model, skills, connection, dialect, aiSettings, onEvent, signal, refreshSkill } = options;
  const metricRunId = options.metricRunId ?? `maintenance:${request.runId}:${randomUUID()}`;
  const metricStartedAt = Date.now();
  let metricRegistered = !!options.metricRunId;
  const maintenanceEvents: AgentEvent[] = [];
  const notify = (event: AgentEvent) => {
    if (options.privacy) event = { ...event, privacy: options.privacy.display(event) };
    maintenanceEvents.push(event);
    onEvent(event);
  };
  const finishMetric = (
    status: "completed" | "error" | "cancelled" | "timeout" | "dropped",
    outcome: string,
    response?: unknown,
    error?: unknown,
  ) => {
    if (!agentMetrics.isOpen()) return;
    if (!metricRegistered) {
      agentMetrics.startRun({
        runId: metricRunId, parentRunId: `agent:${request.runId}`,
        surface: "skill_maintenance", operation: refreshSkill ? "stale_refresh" : "post_run_create",
        startedAt: metricStartedAt, model: model.id,
      });
      metricRegistered = true;
    }
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
    if (options.emitStatus !== false) notify({
      type: "skill_maintenance", runId: request.runId, outcome: "no_source", actions: [], summary: message,
    });
    return false;
  };
  const actions: AgentSkillMaintenanceRecord[] = [];
  let unsubscribe: (() => void) | undefined;
  let onAbort: (() => void) | undefined;
  let stage = "initialization";
  let candidateKey: string | null = null;
  let candidateOutcome: string | null = null;
  let stoppedAfterSave = false;
  let candidateRejected = false;
  const phaseStarted = Date.now();
  try {
    const profile = getActiveProfile(aiSettings, request.profileId);
    if (agentMetrics.isOpen() && !options.metricRunId) {
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
      metricRegistered = true;
      agentMetrics.addEvent(metricRunId, { type: "eligible" });
    }
    if (agentMetrics.isOpen()) agentMetrics.addEvent(metricRunId, { type: "started" });
    signal.throwIfAborted();
    const promptSkills = rankAgentSkillsForRequest(skills.vault, request, SKILL_PROMPT_LIMIT);
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
    stage = "source_collection";
    const sourceDiagnostics = { candidates: [] as string[], excluded: [] as string[], unreadable: [] as string[] };
    const sourceNotes = await collectSkillSourceNotes(vaultPath, maintenanceTables, sqlIndex.query, 3,
      refreshSkill?.metadata.sources.map(source => source.path) ?? evidence.filter(item => item.kind === "success").flatMap(item => item.source).filter(source => source.endsWith(".md")), options.generatedNotePaths, sourceDiagnostics);
    signal.throwIfAborted();
    if (sourceNotes.length === 0) {
      const generatedOnly = sourceDiagnostics.candidates.length > 0
        && sourceDiagnostics.excluded.length === sourceDiagnostics.candidates.length;
      const unreadable = sourceDiagnostics.unreadable.length > 0;
      const chinese = request.locale === "zh";
      return finishWithoutSource(
        generatedOnly ? "only_self_authored_sources" : unreadable ? "source_documents_unreadable" : "no_matching_source_documents",
        generatedOnly
          ? (chinese ? "本轮来源笔记均由 Agent 新建或修改，不能作为独立依据，因此未调用知识维护模型。" : "All candidate notes were created or modified by the Agent in this run. They cannot serve as independent evidence, so knowledge maintenance was skipped.")
          : unreadable
            ? (chinese ? "候选来源笔记无法读取，且没有其他可用来源，因此未调用知识维护模型。" : "Candidate source notes could not be read and no other usable sources remained, so knowledge maintenance was skipped.")
            : (chinese ? "本轮未找到可用的来源笔记，因此未调用知识维护模型。" : "No usable source notes were found for this run, so knowledge maintenance was skipped."),
        {
          sourceTables: maintenanceTables,
          evidenceItems: evidence.length,
          sourceDiagnostics,
          suggestion: generatedOnly
            ? "Use independently verified source notes for knowledge maintenance."
            : "Read a relevant existing Vault Markdown note, then run the Agent again.",
        },
      );
    }
    const currentSkills = (await loadAgentSkills(vaultPath)).vault;
    const skillsHash = (items: typeof currentSkills) => maintenanceHash(items.map(skill => [skill.metadata.name, skill.content]).sort());
    candidateKey = maintenanceHash({ version: 1, operation: refreshSkill?.metadata.name ?? "create",
      intent: request.prompt, connection: request.connectionName, dialect,
      sources: sourceNotes.map(note => [note.path, note.sha256]).sort(),
      evidence: [...new Set(evidence.map(item => JSON.stringify([item.kind, item.tool, [...item.source].sort()])))].sort() });
    const skip = options.forceMaintenance ? null : await maintenanceSkip(vaultPath, candidateKey, skillsHash(currentSkills));
    if (skip) {
      finishMetric("completed", skip);
      if (options.emitStatus !== false) notify({ type: "skill_maintenance", runId: request.runId,
        outcome: skip, actions: [], summary: skip === "unchanged"
          ? "The same evidence and source versions have already been reviewed."
          : "This candidate is cooling down after an incomplete attempt; previous details remain in Metrics." });
      return false;
    }
    // Context is explicitly not proof. Bound it separately from source blocks.
    const boundedConversation = `User intent:\n${request.prompt.slice(0, 900)}\nFinal answer context (not proof):\n${conversation.slice(-1500)}`;
    const boundedEvidence = evidence.slice(-12);
    const boundedSkills = promptSkills.slice(0, 4);
    const envelope = buildSkillMaintenanceInput(boundedConversation, boundedEvidence, [], boundedSkills, refreshSkill);
    const boundedNotes = maintenanceNotes(sourceNotes, maintenanceTables, MAINTENANCE_INPUT_CHARS - envelope.length);
    const maintenanceInput = buildSkillMaintenanceInput(boundedConversation, boundedEvidence, boundedNotes, boundedSkills, refreshSkill);
    if (boundedNotes.length === 0 || maintenanceInput.length > MAINTENANCE_INPUT_CHARS) {
      finishMetric("completed", "input_too_large");
      if (options.emitStatus !== false) notify({ type: "skill_maintenance", runId: request.runId,
        outcome: "input_too_large", actions: [], summary: "No complete source block fits within the maintenance evidence budget." });
      return false;
    }
    candidateOutcome = "error";
    if (agentMetrics.isOpen()) agentMetrics.addEvent(metricRunId, { type: "evidence_packet", payload: {
      inputChars: maintenanceInput.length, sourceChars: boundedNotes.reduce((sum, note) => sum + note.content.length, 0),
      sourceCollectionMs: Date.now() - phaseStarted, sources: boundedNotes.map(note => ({ path: note.path, sha256: note.sha256 })),
      thinkingRequested: "off", maxOutputTokens: maintenanceModel(model).maxTokens,
    } });
    stage = "harness_initialization";
    if (options.emitStatus !== false) notify({ type: "skill_maintenance_started", runId: request.runId });
    const maintenanceHarness = new AgentHarness({
      env: new NodeExecutionEnv({ cwd: vaultPath }),
      session: createSession(),
      models,
      model: maintenanceModel(model),
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
          maintenanceSourceNotes: boundedNotes,
          maintenanceObservedColumns: options.observedColumns,
          onMaintenanceCandidate: candidate => {
            candidateRejected = true;
            if (agentMetrics.isOpen()) agentMetrics.addEvent(metricRunId, { type: "candidate_not_published", payload: candidate });
          },
          maintenanceRefreshName: refreshSkill?.metadata.name ?? null,
          aiSettings,
          privacy: options.privacy,
          connector: {
            listKinds: connectorRegistry.listKinds,
            listDatabases: connectorRegistry.listDatabases,
            listTables: connectorRegistry.listTables,
            execute: connectorRegistry.execute,
            describeTables: connectorRegistry.describeTables,
          },
          sqlIndex: { query: sqlIndex.query },
          skills: skills.vault,
          reservedSkillNames: skills.system.map((skill) => skill.metadata.name),
          mode: refreshSkill ? "refresh" : "maintenance",
          run: { runId: request.runId, sessionId: request.sessionId, notePath: request.notePath ?? null, questionsAsked: 0, toolFailureStreak: new Map(), repairBudget: new ToolRepairBudget() },
          recordRun: recordAgentRun(vaultPath),
          onSkillMaintenance: (record) => actions.push(record),
        },
        requestProposal: async () => false,
      }),
    });
    let turns = 0;
    let thinkingChars = 0;
    let saveStartedAt = 0;
    unsubscribe = maintenanceHarness.subscribe((event) => {
      if (event.type === "usage" && agentMetrics.isOpen()) agentMetrics.addUsage(metricRunId, event.row.usage);
      if (event.type === "tool_execution_start") saveStartedAt = Date.now();
      if (event.type === "tool_execution_end" && !event.isError && (actions.length > 0 || candidateRejected)) {
        stoppedAfterSave = true;
        if (agentMetrics.isOpen()) agentMetrics.addEvent(metricRunId, { type: candidateRejected ? "candidate_retained" : "save_completed", payload: { elapsedMs: Date.now() - phaseStarted, saveMs: Date.now() - saveStartedAt, actions: actions.length } });
      }
      if (event.type === "turn_end" && ++turns >= SKILL_MAINTENANCE_MAX_TURNS && event.message.stopReason === "toolUse" && !stoppedAfterSave) {
        void maintenanceHarness.abort();
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        thinkingChars += event.message.content.reduce((sum, block) => sum + (block.type === "thinking" ? block.thinking.length : 0), 0);
      }
      if (event.type === "message_end" && event.message.role === "assistant" && agentMetrics.isOpen()) {
        agentMetrics.addEvent(metricRunId, { type: "assistant_message", payload: event.message });
      }
    });
    onAbort = () => void maintenanceHarness.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    signal.throwIfAborted();
    if (agentMetrics.isOpen()) {
      agentMetrics.addEvent(metricRunId, { type: "provider_prompt", payload: maintenanceInput });
    }
    stage = "model_execution";
    const modelStartedAt = Date.now();
    const result = await maintenanceHarness.prompt(maintenanceInput);
    if (agentMetrics.isOpen()) agentMetrics.addEvent(metricRunId, { type: "generation_finished", payload: { modelMs: Date.now() - modelStartedAt, thinkingChars, stopReason: result.stopReason, turns } });
    if (result.stopReason === "error") {
      throw new Error(result.errorMessage || "Knowledge maintenance model failed.");
    }
    const completed = !signal.aborted && (stoppedAfterSave || result.stopReason !== "aborted");
    if (completed && !candidateRejected && actions.length === 0 && (result.stopReason === "length" || !assistantText(result).trim())) {
      throw new Error("Maintenance produced no decision before its output limit; thinking-only output is not a no-change decision.");
    }
    candidateOutcome = completed ? (actions.length ? "saved" : candidateRejected ? "candidate_not_published" : "no_change")
      : signal.reason === "timeout" ? "timeout" : signal.aborted ? "cancelled" : "turn_limit";
    if (agentMetrics.isOpen()) agentMetrics.addEvent(metricRunId, { type: "decision", payload: {
      turns, saved: actions.length, stoppedAfterSave, stopReason: result.stopReason,
      thinkingChars,
      elapsedMs: Date.now() - phaseStarted,
    } });
    if (options.emitStatus !== false) {
      notify({
        type: "skill_maintenance",
        runId: request.runId,
        outcome: completed ? (actions.length > 0 ? "saved" : candidateRejected ? "candidate_not_published" : "no_change")
          : signal.reason === "timeout" ? "timeout" : signal.aborted ? "cancelled" : "turn_limit",
        actions,
        summary: !completed
          ? "Knowledge maintenance stopped at its time or turn limit."
          : actions.length > 0
            ? `Updated ${actions.length} internal knowledge Skill${actions.length === 1 ? "" : "s"}.`
            : candidateRejected ? "Knowledge candidate retained for review; independent evidence was insufficient. No Skill was published." : assistantText(result).trim().slice(0, 120) || "No durable knowledge required a Skill update.",
      });
    }
    if (!completed) {
      const timeout = signal.reason === "timeout";
      const turnLimit = !signal.aborted && turns >= SKILL_MAINTENANCE_MAX_TURNS;
      finishMetric(timeout || turnLimit ? "timeout" : "cancelled", timeout ? "timeout" : turnLimit ? "turn_limit" : "cancelled", result);
    } else {
      for (const action of actions) {
        if (agentMetrics.isOpen()) agentMetrics.addEvent(metricRunId, { type: "skill_action", name: action.name, payload: action });
      }
      finishMetric(
        "completed",
        actions.length > 0 ? "saved" : candidateRejected ? "candidate_not_published" : "no_change",
        { result, actions },
      );
    }
    return completed && actions.length > 0;
  } catch (err) {
    const cancelled = signal.aborted;
    const timeout = cancelled && signal.reason === "timeout";
    if (candidateOutcome) candidateOutcome = timeout ? "timeout" : cancelled ? "cancelled" : "error";
    finishMetric(
      timeout ? "timeout" : cancelled ? "cancelled" : "error",
      timeout ? "timeout" : cancelled ? "cancelled" : "error",
      { stage, actions, ...(!cancelled && err instanceof Error && err.stack
        ? { stack: redactForPrompt(err.stack).slice(0, 8000) } : {}) },
      cancelled ? undefined : err,
    );
    const diagnostic = {
      stage,
      message: String(redactForPrompt(err instanceof Error ? err.message : String(err))).slice(0, 2000),
      metricRunId,
    };
    (cancelled ? log.info : log.error)("skill maintenance failed", {
      runId: request.runId,
      ...diagnostic,
    });
    if (options.emitStatus !== false) {
      notify({
        type: "skill_maintenance",
        runId: request.runId,
        outcome: timeout ? "timeout" : cancelled ? "cancelled" : "error",
        ...(!cancelled ? { diagnostic } : {}),
        actions,
        summary: cancelled
          ? "Knowledge maintenance stopped at its time limit or was cancelled."
          : "Skill maintenance could not complete; the answer above is unaffected.",
      });
    }
    return false;
  } finally {
    if (candidateKey && candidateOutcome) {
      try {
        const latestSkills = (await loadAgentSkills(vaultPath)).vault;
        await recordMaintenance(vaultPath, { key: candidateKey,
          skills: maintenanceHash(latestSkills.map(skill => [skill.metadata.name, skill.content]).sort()),
          at: Date.now(), outcome: candidateOutcome });
      } catch (error) { log.error("maintenance receipt write failed", { error: redactForPrompt(String(error)) }); }
    }
    unsubscribe?.();
    if (onAbort) signal.removeEventListener("abort", onAbort);
    if (options.historyStorage && maintenanceEvents.length > 0) {
      try {
        for (const event of maintenanceEvents) await appendAgentHistoryEvent(options.historyStorage, event);
        onEvent({ type: "history_updated", runId: request.runId });
      } catch (error) {
        log.error("maintenance history write failed", {
          metricRunId, error: redactForPrompt(error instanceof Error ? error.message : String(error)),
        });
        if (agentMetrics.isOpen()) agentMetrics.addEvent(metricRunId, {
          type: "history_write_failed", payload: { message: error instanceof Error ? error.message : String(error) },
        });
      }
    }
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
  privacyModeEnabled?: boolean;
  privacyPersistence?: IPrivacyPersistence;
  storage?: JsonlSessionStorage;
  recordRun?: AgentRunRecorder;
  conversationRunIds?: string[];
  conversationContext?: string;
  beforeTool?: () => Promise<void>;
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
  let privacy: PrivacySession | undefined;
  const historyEvents: AgentEvent[] = [];
  const emit = (event: AgentEvent) => {
    if (privacy) event = { ...event, privacy: privacy.display(event) };
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
    if (privacy) event = { ...event, privacy: privacy.display(event) };
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
    const opened = options.storage
      ? { session: createSession(options.storage), storage: options.storage }
      : await getOrCreateSession(vaultPath, slug, request.sessionId);
    session = opened.session;
    historyStorage = opened.storage;
    await appendAgentHistoryStarted(historyStorage, request);
    const settings = await settingsStore.loadAppSettings(vaultPath);
    if (options.privacyModeEnabled !== undefined) settings.ai.privacyModeEnabled = options.privacyModeEnabled;
    privacy = openPrivacySession(`${vaultPath}\0${request.sessionId}`, settings.ai.privacyModeEnabled === true, options.privacyPersistence ?? await privacyHistory(vaultPath, slug, request.sessionId!)).forkTask();
    const inputMessage = request.message ?? { version: 1 as const, segments: [{ kind: "text" as const, text: request.prompt }], resources: [] };
    const privacyInput = privacy.enabled ? { ...inputMessage, segments: await Promise.all(inputMessage.segments.map(async segment => segment.kind === "text" ? { ...segment, text: await privacy!.maskText(redactForPrompt(segment.text), "", signal) } : segment)) } : undefined;
    await privacy.flush();
    emit({ type: "started", runId, privacyInput });
    if (settings.ai.providerMode === "disabled") {
      emit({ type: "error", runId, message: "AI provider is disabled. Enable it in Settings → AI." });
      return;
    }
    const profile = getActiveProfile(settings.ai, request.profileId);
    const semanticProfile = getActiveProfile(settings.ai, settings.ai.semanticProfileId ?? profile.id);
    privacy.setRecipients([profile, semanticProfile].map(p => `${p.name} / ${p.model} (${p.baseUrl || p.vendorId})`));
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
    const skills = await loadAgentSkills(vaultPath, { systemSkillDir: bundledSystemSkillsRoot() });
    if (!skills.system.some((skill) => skill.metadata.name === "chart-authoring")) {
      log.warn("Bundled chart-authoring System Skill is unavailable", {
        rejected: skills.rejected.filter((item) => item.origin === "system"),
      });
    }
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
    const { models, model, reasoning } = createTransportForProfile(settings.ai, apiKey, profile.id, privacy);
    const maintenancePrivacy = privacy.forkTask();
    const maintenanceModels = createTransportForProfile(settings.ai, apiKey, profile.id, maintenancePrivacy).models;
    const semantic = createSemanticAgent({
      privacy, vault: vaultPath, session: request.sessionId!, slug, settings: settings.ai, profile, signal,
      chinese: request.locale === "zh",
      approve: (description, allow, approvalSignal) => makeRequestProposal(runId, `semantic-${randomUUID()}`, emit, pending, approvalSignal)({
        kind: "question", payload: { description, question: description, options: [allow, request.locale === "zh" ? "拒绝" : "Deny"] },
      }),
      onProgress: (response, semanticModel) => {
        emit({ type: "semantic_progress", runId, sessionId: request.sessionId!, ...response.usage,
          failed: response.rows.filter((r) => r.status === "failed" || r.status === "unprocessed").length,
          unresolved: response.rows.filter((r) => r.status === "unresolved").length });
        if (agentMetrics.isOpen()) agentMetrics.addEvent(metricRunId, { type: response.phase === "preflight" ? "semantic_preflight" : "semantic_batch", name: semanticModel,
          payload: { usage: response.usage, cached: response.cached, rows: response.rows.map(({ id, status }) => ({ id, status })) } });
      },
      onUsage: (usage) => { if (agentMetrics.isOpen()) agentMetrics.addUsage(metricRunId, usage); },
    });
    const contextWindow = model.contextWindow;
    const systemPrompt = buildSystemPrompt() + (privacy.enabled ? "\nPrivacy mode is enabled. PII_ hexadecimal tokens (and legacy STELA_PII tokens) represent masked data, including unknown numeric cells; keep tokens exact. Query text and unknown numbers are masked by default, JSON recursively. Nulls, booleans and proven COUNT and binary CASE SUM results remain usable. Call request_column_access with the exact result runId and a concrete reason when original text semantics or numeric arithmetic is necessary. Submit all known access requests in the same assistant step so the user can decide once for the batch. The user selects columns/JSON paths. A new query gets no inherited permission. Reuse approved data via execute_python.sources [{alias, runId}]. Approval resets Python variables, so redeclare sources. Python receives only masked or explicitly released inputs. Grants expire after this task. Never infer real spelling, phone prefixes or locations from tokens. Use full tokens as quoted SQL values when filtering; the host resolves them locally. Do not encode or split identities to bypass privacy.\n" : "");
    const skillMetadata = formatSkillsForSystemPrompt(promptSkills.map((item) => item.skill));
    if (agentMetrics.isOpen()) {
      agentMetrics.addEvent(metricRunId, { type: "system_prompt", payload: systemPrompt });
      for (const skill of promptSkills) {
        agentMetrics.addEvent(metricRunId, {
          type: "skill_candidate",
          name: skill.metadata.name,
          payload: { category: skill.metadata.category, source: "prompt", origin: skill.metadata.origin },
        });
      }
    }
    plan = new ExecutionPlanStore(runId, (snapshot) => {
      emit({ type: "plan_updated", runId, plan: snapshot });
    });
    const restored = await restoreSessionPlan(plan, session);
    if (restored) await appendPlanEntry(session, restored);
    const comparisonLimits = new Map<string, string>();
    const generatedNotePaths = new Set<string>();
    const repairBudget = new ToolRepairBudget();
    const analysisRuns = new Map<string, AgentAnalysisRunEvidence>();
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

    const harnessThinkingLevel = reasoning.effective;
    let generationStatus: number | undefined;
    harness = new AgentHarness({
      env: new NodeExecutionEnv({ cwd: vaultPath }),
      session,
      models: withGenerationRecovery(models, { signal, onPreview: (message) => {
        if (message) scheduleStreamingProgress(message);
        else {
          clearProgressTimer();
          progressContent = "";
          progressLastSnapshot = "";
          onEvent({ type: "assistant_progress", runId, stepIndex: harnessStepIndex, content: "", phase: "streaming" });
        }
      }, onDiagnostic: (event) => {
        generationStatus = event.status;
        if (agentMetrics.isOpen()) agentMetrics.addEvent(metricRunId, { type: "generation_attempt", payload: event });
        if (agentMetrics.isOpen() && event.attempt === 1 && event.firstEventMs !== undefined) {
          agentMetrics.addEvent(metricRunId, { type: "model_first_token", name: `step:${harnessStepIndex}`,
            occurredAt: event.startedAt + event.firstEventMs, durationMs: event.firstEventMs,
            payload: { stepIndex: harnessStepIndex } });
        }
      } }),
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
          privacy,
          pythonExecutor: { execute: input => executePython({ ...input, privacy, onPrivacyProgress: (rows, total) => emit({ type: "assistant_progress", runId, stepIndex: -2, content: request.locale === "zh" ? `正在脱敏查询结果：${rows} / ${total} 行` : `Preparing private query data: ${rows} / ${total} rows`, phase: rows === total ? "completed" : "streaming" }) }), reset: async (vault, sessionId) => {
            await resetPythonWorkspace(vault, sessionId);
            clearSemanticWorkspace(vault, sessionId);
          } },
          analysisContext: { runId, question: redactForPrompt(request.prompt), semanticOptimization: settings.ai.semanticOptimizationEnabled === true, automaticContracts: settings.ai.automaticAnalysisContractsEnabled === true },
          runSemantic: (raw, jobSignal, onAuthorizationWait) => semantic.execute(raw, jobSignal, onAuthorizationWait),
          signal,
          sqlIndex: { query: sqlIndex.query },
          skills: skills.loaded,
          reservedSkillNames: skills.system.map((skill) => skill.metadata.name),
          mode: "normal",
          explicitSkillMaintenance,
          skillEvidence,
          getSkillFreshness: resolveSkillFreshness,
          scheduleSkillRefresh: (skill) => {
            // 走和 post_run_create 相同的队列：自带 60s 超时与 per-vault 串行，
            // 刷新结果留给下一次 run 使用，不再让 load_skill 等一次 LLM 往返。
            void (async () => {
              if (await resolveSkillFreshness(skill) !== "stale") return;
              if (!settings.ai.automaticSkillMaintenanceEnabled) return;
              if (skill.metadata.category === "analysis-runbook" && skill.metadata.sources.length === 0) return;
              const jobOptions = {
                privacy: maintenancePrivacy,
                vaultPath,
                request,
                conversation: conversationForMaintenance((await session!.buildContext()).messages),
                evidence: maintenanceEvidence.slice(-24),
                generatedNotePaths: new Set(generatedNotePaths),
                observedColumns: [...new Set([...analysisRuns.values()].flatMap(run => run.columns.map(column => column.name)))],
                models: maintenanceModels,
                model,
                skills,
                connection,
                dialect,
                aiSettings: settings.ai,
                onEvent: emit,
                refreshSkill: skill,
                emitStatus: false,
              };
              enqueueSkillMaintenance(
                vaultPath,
                async (maintenanceSignal) => {
                  await runSkillMaintenance({ ...jobOptions, signal: maintenanceSignal });
                },
                () => {},
              );
            })().catch((error) => log.warn("scheduleSkillRefresh failed", { error }));
          },
          run: { runId, sessionId: request.sessionId, notePath: request.notePath ?? null, questionsAsked: 0, toolFailureStreak: new Map(), repairBudget },
          chartRuns: new Map(),
          conversationRunIds: options.conversationRunIds,
          analysisRuns,
          canvasRefresh: request.canvasRefresh ? {
            path: request.canvasRefresh.path,
            sourceId: request.canvasRefresh.sourceId ?? null,
            committed: false,
          } : undefined,
          resolveChartRun: async (chartRunId) => {
            if (!resultStore.runExists(chartRunId)) await journal.importRun(vaultPath, chartRunId);
            return resultStore.getRun(chartRunId);
          },
          onNoteWritten: path => generatedNotePaths.add(path),
          onCanvasUpdated: (event) => emit({ type: "canvas_updated", runId, ...event }),
          plan,
          persistPlan: planPersistence.enqueue,
          rewriteTargets: runsqlRewriteTargets(request),
          recordRun: options.recordRun ?? recordAgentRun(vaultPath),
          onSkillMaintenance: (record) => normalSkillActions.push(record),
          onSkillUsage: (record) => {
            if (!agentMetrics.isOpen()) return;
            agentMetrics.addEvent(metricRunId, {
              type: record.type === "loaded" ? "skill_loaded" : "skill_candidate",
              name: record.name,
              payload: { category: record.category, source: record.source, origin: record.origin },
            });
          },
        },
        requestProposal: (toolCallId, proposal) =>
          makeRequestProposal(
            runId,
            toolCallId,
            emit,
            pending,
            signal,
            settings.ai.agentAutoApplyEdits,
          )(proposal),
      }),
    });

    const efficiency = new AnalysisEfficiencyLedger();
    let pendingStrategyCheckpoint: AgentStrategyCheckpoint | null = null;
    const strategyUnsubscribe = harness.on("tool_result", async (event) => {
      for (const block of event.content) if (block.type === "text") {
        const snapshot = readAnalysisSnapshot(block.text);
        for (const comparison of snapshot?.comparisons ?? []) comparisonLimits.set(comparison.name,
          request.locale === "zh"
            ? `${comparison.name}：${comparison.state === "identity_checked" ? "已检查 ID 包含关系" : "阶段关系未验证"}（${comparison.reason}）；业务口径仍需独立证据确认。`
            : `${comparison.name}: ${comparison.state} (${comparison.reason}); source population scope still requires independent justification.`);
      }
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
          models: maintenanceModels,
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
      const hint = repairBudget.contextHint();
      const messages = hint ? [...event.messages, { role: "user" as const,
        content: `Host tool repair budget (current run):\n${hint}`, timestamp: Date.now() }] : event.messages;
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
            messages,
          },
        });
      }
      return hint ? { messages } : undefined;
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
      if (event.type === "usage") {
        if (agentMetrics.isOpen()) agentMetrics.addUsage(metricRunId, event.row.usage);
        return;
      }
      if (event.type === "compaction_start") {
        emit({ type: "compaction", runId, phase: "started" });
        return;
      }
      if (event.type === "compaction_end") {
        if (event.status === "completed") {
          emit({ type: "compaction", runId, phase: "completed" });
          await emitUsage(true);
        }
        return;
      }
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
        await options.beforeTool?.();
        if (signal.aborted) throw new Error("Agent cancelled before tool execution.");
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
        await options.beforeTool?.();
        return;
      }
      if (event.type === "tool_execution_end") {
        const repairHint = repairBudget.observeHarnessResult(event.toolName, event.toolCallId, event.isError);
        if (repairHint && agentMetrics.isOpen()) agentMetrics.addEvent(metricRunId, { type: "tool_validation", name: event.toolName, payload: { kind: "schema_validation", hint: repairHint } });
        const contentValidation = event.isError && toolResultSummary(event.result).includes("[content_validation]");
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
              errorCode: event.isError ? (repairHint ? "schema_validation" : contentValidation ? "content_validation" : "tool_error") : null,
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
          summary: toolResultSummary(event.result) + (repairHint ? `\n${repairHint}` : ""),
        });
        void emitUsage(true);
        return;
      }
      if (event.type === "message_start" && event.message.role === "assistant" && agentMetrics.isOpen()) {
        const now = Date.now();
        agentMetrics.addEvent(metricRunId, {
          type: "model_generation_committed",
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
        privacy?.planReleaseRequests(event.message.content);
        completeProgress(event.message);
        if (agentMetrics.isOpen()) {
          const now = Date.now();
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
          skills: skills.vault.length > 0 ? "available" : "empty",
          sql_history: "unknown",
          canvas: "unknown",
          clarification: "available",
        },
        skillMetadata,
        pythonWorkspace: describePythonWorkspace(vaultPath, request.sessionId!),
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
      if (options.conversationContext) {
        await session.appendMessage({ role: "user", content: [{ type: "text", text: options.conversationContext }], timestamp: Date.now() });
      }
      const result = await harness.prompt(userContent);
      await emitUsage(false);

      if (signal.aborted || result.stopReason === "aborted") {
        emit({ type: "cancelled", runId });
        return;
      }

      if (result.stopReason === "error") {
        const failure = result.errorMessage ?? "Agent run failed.";
        const closeout = await closeoutGeneration({ models, model, context: { ...await session.buildContext(), systemPrompt },
          streamOptions: { reasoning: reasoning.effective === "off" ? undefined : reasoning.effective, cacheRetention: "short" },
          failure, failureStatus: generationStatus, hasEvidence: analysisRuns.size > 0, remainingMs: 120_000, signal,
          onDiagnostic: event => {
            if (agentMetrics.isOpen()) agentMetrics.addEvent(metricRunId, { type: "generation_attempt", payload: { ...event, phase: "closeout" } });
          },
        });
        if (agentMetrics.isOpen()) {
          if (closeout.message) agentMetrics.addUsage(metricRunId, closeout.message.usage);
          agentMetrics.addEvent(metricRunId, { type: "generation_closeout", payload: {
            executionFailure: failure, status: closeout.status, reason: closeout.reason, error: closeout.error,
          } });
        }
        if (closeout.status === "cancelled" || signal.aborted) { emit({ type: "cancelled", runId }); return; }
        if (closeout.status === "completed" && closeout.message) await session.appendMessage(closeout.message);
        emit({
          type: "error",
          runId,
          message: failure,
          ...(closeout.answer ? { partialAnswer: closeout.answer } : {}),
        });
        return;
      }

      await planPersistence.flush();
      const deliverySummary = formatPlanDeliveries(plan.get(), request.locale === "zh");
      const finalAnswer = visibleAssistantText(result).trim() + (plan.get()?.deliveries?.length ? `\n\n${deliverySummary}` : "") +
        (comparisonLimits.size ? `\n\n${request.locale === "zh" ? "比较证据的限制：" : "Comparison evidence limitations:"}\n${[...comparisonLimits.values()].join("\n")}` : "");
      if (agentMetrics.isOpen()) agentMetrics.addEvent(metricRunId, { type: "delivery_status", payload: { summary: deliverySummary, deliveries: plan.get()?.deliveries ?? null } });

      if (agentMetrics.isOpen()) {
        agentMetrics.addEvent(metricRunId, { type: "analysis_efficiency", payload: efficiency.metrics() });
      }
      emit({ type: "final", runId, content: finalAnswer, stepIndex: harnessStepIndex });
      if (normalSkillActions.length > 0) {
        emit({
          type: "skill_maintenance",
          runId,
          outcome: "saved",
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
          privacy: maintenancePrivacy,
          vaultPath,
          request,
          conversation: conversationForMaintenance(context.messages),
          evidence: maintenanceEvidence.slice(-24),
          generatedNotePaths: new Set(generatedNotePaths),
          observedColumns: [...new Set([...analysisRuns.values()].flatMap(run => run.columns.map(column => column.name)))],
          models: maintenanceModels,
          model,
          skills,
          connection,
          dialect,
          aiSettings: settings.ai,
          onEvent,
          metricRunId: maintenanceMetricRunId,
          historyStorage,
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
              outcome: "dropped",
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
      await planPersistence.flush();
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
    if (privacy?.enabled) {
      privacy.closeTask();
      await resetPythonWorkspace(vaultPath, request.sessionId!).catch(error => log.warn('Privacy workspace cleanup failed', { error: String(error) }));
    }
    signal.removeEventListener("abort", onAbort);
    activeProposals.delete(runId);
    historyResponses.delete(runId);
  }
  return maintenanceJob;
}
