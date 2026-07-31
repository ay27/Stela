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
} from "./agent-skills";
import { ExecutionPlanStore, formatExecutionPlanEntry } from "./execution-plan";
import {
  createAgentTools,
  type AgentRunRecorder,
  type ProposalRequest,
} from "./agent-tools";
import { createTransportForProfile, getActiveProfile, loadApiKey } from "./provider";
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

const log = getLogger("ai.agent");
const TOOL_RESULT_SUMMARY_CHARS = 480;
const EXECUTION_PLAN_ENTRY = "execution_plan";
const OVERFLOW_CONTINUE_PROMPT =
  "The previous request exceeded the model context window. Continue from the compacted history and finish the user's last request.";
const SKILL_PROMPT_LIMIT = 8;
const SKILL_MAINTENANCE_ANSWER_CHARS = 2_400;
const SKILL_MAINTENANCE_PROMPT = `You are Stela's internal experience-maintenance agent.
Review the completed request and bounded tool evidence below. Save nothing by default. Preserve only durable, specific data-analysis knowledge that is verified, applies beyond this request, and does not duplicate an existing Skill: SQL dialect constraints, metric definitions, business glossary mappings, data lineage, or analysis runbooks.

First search existing Skills when relevant. Use save_skill only when all three conditions hold: reusable scope, direct evidence in the completed work, and no existing equivalent. Do not copy the answer, SQL, result rows, absolute counts, date snapshots, or error logs into a Skill. A failed_attempt is not proof by itself: save a failure gotcha only if later successful tool evidence explains the cause and replacement. Never save transient_failure. Keep a saved Skill to its scope, rule, and minimal verification or exception. Automatic maintenance may create only a new compact validated SKILL.md; it cannot overwrite or archive an existing Skill. A saved file must use this frontmatter shape:
---
name: lowercase-hyphenated-name
description: concise reusable purpose
category: sql-dialect | metric-definition | business-glossary | data-lineage | analysis-runbook
tags: [lowercase-tag, another-tag]
---

${AGENT_SKILL_LIMITS_PROMPT}

For each candidate table named in the evidence, call search_sql_usage with its table parameter before saving. Its matched notes are ordered by document update time; you may read at most the first three with read_note. Distill only rules shared across those records. If records conflict, the newest updated note takes precedence; do not retain a rule whose scope remains unclear. Tags may only use verified tables, business terms, and the active connection dialect; never guess another SQL dialect. Do not save one-off answers, speculative claims, user-private data, credentials, SQL result rows, analysis narration, or instructions requiring tools Stela does not have. If there is no safe durable knowledge, make no tool call and reply with a one-sentence reason.`;

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
  request: AgentRunRequest,
  finalAnswer: string,
  evidence: SkillMaintenanceEvidence[],
): string {
  const answer = finalAnswer.trim().slice(0, SKILL_MAINTENANCE_ANSWER_CHARS);
  return [
    `Completed user request:\n${request.prompt}`,
    `Agent run ID: ${request.runId}`,
    "Bounded tool evidence (extract only reusable verified facts; never copy this text verbatim):",
    formatSkillMaintenanceEvidence(evidence) || "No tool evidence was available.",
    "Final answer is task background only, not evidence:",
    answer || "No final answer was available.",
  ].join("\n\n");
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
  finalAnswer: string;
  evidence: SkillMaintenanceEvidence[];
  models: Awaited<ReturnType<typeof createTransportForProfile>>["models"];
  model: Awaited<ReturnType<typeof createTransportForProfile>>["model"];
  skills: Awaited<ReturnType<typeof loadAgentSkills>>;
  connection: ConnectionEntry | null;
  dialect: string | null;
  aiSettings: Awaited<ReturnType<typeof settingsStore.loadAppSettings>>["ai"];
  onAbortHarness: (harness: AgentHarness) => void;
  onEvent: (event: AgentEvent) => void;
  signal: AbortSignal;
}): Promise<void> {
  const { vaultPath, request, finalAnswer, evidence, models, model, skills, connection, dialect, aiSettings, onAbortHarness, onEvent, signal } = options;
  const actions: AgentSkillMaintenanceRecord[] = [];
  const promptSkills = rankAgentSkills(skills.loaded, request.prompt, SKILL_PROMPT_LIMIT);
  const maintenanceTables = Array.from(new Set(evidence.flatMap((item) => item.tables ?? [])));
  const maintenanceRelatedNotes = { paths: new Set<string>(), reads: 0 };
  onEvent({ type: "skill_maintenance_started", runId: request.runId });
  const maintenanceHarness = new AgentHarness({
    env: new NodeExecutionEnv({ cwd: vaultPath }),
    session: createSession(),
    models,
    model,
    thinkingLevel: "off",
    systemPrompt: `${SKILL_MAINTENANCE_PROMPT}\n${formatSkillsForSystemPrompt(promptSkills.map((item) => item.skill))}`,
    resources: { skills: promptSkills.map((item) => item.skill) },
    tools: createAgentTools({
      ctx: {
        vaultPath,
        connectionName: request.connectionName ?? null,
        connection,
        maintenanceDialect: dialect,
        maintenanceTables,
        maintenanceRelatedNotes,
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
        mode: "maintenance",
        run: { runId: request.runId, notePath: request.notePath ?? null, questionsAsked: 0 },
        recordRun: recordAgentRun(vaultPath),
        onSkillMaintenance: (record) => actions.push(record),
      },
      requestProposal: async () => false,
    }),
  });
  onAbortHarness(maintenanceHarness);
  try {
    const result = await maintenanceHarness.prompt(buildSkillMaintenanceInput(request, finalAnswer, evidence));
    if (signal.aborted || result.stopReason === "aborted") return;
    onEvent({
      type: "skill_maintenance",
      runId: request.runId,
      actions,
      summary: actions.length > 0
        ? `Updated ${actions.length} internal knowledge Skill${actions.length === 1 ? "" : "s"}.`
        : assistantText(result).trim().slice(0, 120) || "No durable knowledge required a Skill update.",
    });
  } catch (err) {
    log.warn("skill maintenance failed", {
      runId: request.runId,
      err: err instanceof Error ? err.message : String(err),
    });
    if (!signal.aborted) {
      onEvent({
        type: "skill_maintenance",
        runId: request.runId,
        actions,
        summary: "Skill maintenance could not complete; the answer above is unaffected.",
      });
    }
  }
}

export interface RunAgentOptions {
  vaultPath: string;
  slug: string;
  request: AgentRunRequest;
  onEvent: (event: AgentEvent) => void;
  signal: AbortSignal;
}

export async function runAgent(options: RunAgentOptions): Promise<void> {
  const { vaultPath, slug, onEvent, signal } = options;
  let request = options.request;
  if (!request.sessionId) {
    const session = await preparePersistentAgentSession(vaultPath, slug, undefined);
    request = { ...request, sessionId: session.sessionId };
  }
  const runId = request.runId;
  const pending = new Map<string, ProposalResolver>();
  const historyEvents: AgentEvent[] = [];
  const emit = (event: AgentEvent) => {
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
    const apiKey = await loadApiKey(vaultPath, slug, profile.id);
    const { connection, dialect } = await resolveConnection(vaultPath, slug, request.connectionName);
    const skills = await loadAgentSkills(vaultPath);
    const promptSkills = rankAgentSkills(skills.loaded, request.prompt, SKILL_PROMPT_LIMIT);
    const { models, model } = createTransportForProfile(settings.ai, apiKey, profile.id);
    const contextWindow = model.contextWindow;
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
      systemPrompt:
        `${buildSystemPrompt(request, connection, dialect, AGENT_SKILL_LIMITS_PROMPT)}\n` +
        "Use search_skills before relying on domain knowledge that may exist in the internal Skill library.\n" +
        formatSkillsForSystemPrompt(promptSkills.map((item) => item.skill)),
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
          run: { runId, notePath: request.notePath ?? null, questionsAsked: 0 },
          plan,
          recordRun: recordAgentRun(vaultPath),
          onSkillMaintenance: (record) => normalSkillActions.push(record),
        },
        requestProposal: (toolCallId, proposal) =>
          makeRequestProposal(runId, toolCallId, emit, pending, signal)(proposal),
      }),
    });

    const toolCalls = new Map<string, { name: string; args: unknown }>();
    const unsubscribe = harness.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        toolCalls.set(event.toolCallId, { name: event.toolName, args: event.args ?? {} });
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
        }
        emit({
          type: "tool_result",
          runId,
          callId: event.toolCallId,
          ok: !event.isError,
          summary: toolResultSummary(event.result),
        });
        void emitUsage(true);
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
      } else if (hasSkillMaintenanceEvidence(maintenanceEvidence)) {
        await runSkillMaintenance({
          vaultPath,
          request,
          finalAnswer,
          evidence: maintenanceEvidence.slice(-24),
          models,
          model,
          skills,
          connection,
          dialect,
          aiSettings: settings.ai,
          onAbortHarness: (nextHarness) => {
            harness = nextHarness;
          },
          onEvent: emit,
          signal,
        });
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
}
