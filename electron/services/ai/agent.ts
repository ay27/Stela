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
import { ExecutionPlanStore, formatExecutionPlan } from "./execution-plan";
import {
  createAgentTools,
  type AgentRunRecorder,
  type ProposalRequest,
} from "./agent-tools";
import { createTransportForProfile, getActiveProfile, loadApiKey } from "./provider";

const log = getLogger("ai.agent");
const TOOL_RESULT_SUMMARY_CHARS = 480;
const EXECUTION_PLAN_ENTRY = "execution_plan";
const OVERFLOW_CONTINUE_PROMPT =
  "The previous request exceeded the model context window. Continue from the compacted history and finish the user's last request.";
const SKILL_PROMPT_LIMIT = 8;
const SKILL_MAINTENANCE_ANSWER_CHARS = 2_400;
const SKILL_MAINTENANCE_PROMPT = `You are Stela's internal experience-maintenance agent.
Review the completed request and compact evidence summary below. Save nothing by default. Preserve only durable, specific data-analysis knowledge that is verified, applies beyond this request, and does not duplicate an existing Skill: SQL dialect constraints, metric definitions, business glossary mappings, data lineage, or analysis runbooks.

First search existing Skills when relevant. Use save_skill only when all three conditions hold: reusable scope, evidence in the completed work, and no existing equivalent. Do not copy the answer or its SQL into a Skill. Keep a saved Skill to its scope, rule, and minimal verification or exception. Use save_skill only to save a compact validated SKILL.md or archive an obsolete/conflicting Skill. A saved file must use this frontmatter shape:
---
name: lowercase-hyphenated-name
description: concise reusable purpose
category: sql-dialect | metric-definition | business-glossary | data-lineage | analysis-runbook
tags: [lowercase-tag, another-tag]
---

${AGENT_SKILL_LIMITS_PROMPT}

Do not save one-off answers, speculative claims, user-private data, credentials, SQL result rows, analysis narration, or instructions requiring tools Stela does not have. If there is no safe durable knowledge, make no tool call and reply with a one-sentence reason.`;

/**
 * `question` kind 需要把答案文本带回工具，所以 resolve 类型从 `boolean`
 * 放宽为 `boolean | string`：`false` = 拒绝，`true` = 同意，string = 答案。
 */
type ProposalResolver = (outcome: boolean | string) => void;

/** runId -> callId -> resolver，供 IPC 层的 respondToProposal 查找。 */
const activeProposals = new Map<string, Map<string, ProposalResolver>>();

/**
 * sessionId -> pi Session (InMemorySessionStorage).
 *
 * ponytail: 存在内存里，随 app 生命周期增长，没有上限/持久化；单机桌面
 * 应用会话数量小，重启即清空。上限=长时间不重启会积累多个旧会话占内存；
 * 升级路径=加个数上限的 LRU，或在前端"新建对话"时清掉旧的 sessionId。
 */
const sessions = new Map<string, Session>();
const planEntryWrites = new WeakMap<Session, Promise<void>>();

/** IPC 入口：用户在前端 approve/reject 一个 proposal 时调用。找不到（已超时/run 已结束）返回 false。 */
export function respondToProposal(response: AgentProposalResponse): boolean {
  const pending = activeProposals.get(response.runId);
  const resolver = pending?.get(response.callId);
  if (!resolver) return false;
  pending!.delete(response.callId);
  resolver(response.approve && response.answer !== undefined ? response.answer : response.approve);
  return true;
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

function buildSkillMaintenanceInput(request: AgentRunRequest, finalAnswer: string): string {
  const answer = finalAnswer.trim();
  const evidenceSummary = answer.length > SKILL_MAINTENANCE_ANSWER_CHARS
    ? `${answer.slice(0, SKILL_MAINTENANCE_ANSWER_CHARS)}\n\n[truncated: do not infer or save omitted details]`
    : answer;
  return [
    `Completed user request:\n${request.prompt}`,
    "Evidence summary (extract only reusable verified facts; never copy this text verbatim):",
    evidenceSummary || "No final-answer evidence was available.",
  ].join("\n\n");
}

function createSession(): Session {
  return new Session(new InMemorySessionStorage(), {
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
        const data = entry.data as { plan?: AgentPlanSnapshot | null } | undefined;
        return [{
          role: "user",
          content: `Current execution plan:\n${formatExecutionPlan(data?.plan ?? null)}`,
          timestamp: Date.now(),
        }];
      },
    },
  });
}

function appendPlanEntry(session: Session, runId: string, plan: AgentPlanSnapshot | null): Promise<void> {
  const pending = planEntryWrites.get(session) ?? Promise.resolve();
  const next = pending.then(() => session.appendCustomEntry(EXECUTION_PLAN_ENTRY, { runId, plan }));
  planEntryWrites.set(session, next.catch(() => {}));
  return next;
}

function getOrCreateSession(sessionId: string | undefined): Session {
  if (sessionId) {
    const existing = sessions.get(sessionId);
    if (existing) return existing;
    const created = createSession();
    sessions.set(sessionId, created);
    return created;
  }
  return createSession();
}

async function runSkillMaintenance(options: {
  vaultPath: string;
  request: AgentRunRequest;
  finalAnswer: string;
  models: Awaited<ReturnType<typeof createTransportForProfile>>["models"];
  model: Awaited<ReturnType<typeof createTransportForProfile>>["model"];
  skills: Awaited<ReturnType<typeof loadAgentSkills>>;
  connection: ConnectionEntry | null;
  aiSettings: Awaited<ReturnType<typeof settingsStore.loadAppSettings>>["ai"];
  onAbortHarness: (harness: AgentHarness) => void;
  onEvent: (event: AgentEvent) => void;
  signal: AbortSignal;
}): Promise<void> {
  const { vaultPath, request, finalAnswer, models, model, skills, connection, aiSettings, onAbortHarness, onEvent, signal } = options;
  const actions: AgentSkillMaintenanceRecord[] = [];
  const promptSkills = rankAgentSkills(skills.loaded, request.prompt, SKILL_PROMPT_LIMIT);
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
        aiSettings,
        connector: {
          listKinds: connectorRegistry.listKinds,
          listDatabases: connectorRegistry.listDatabases,
          listTables: connectorRegistry.listTables,
          execute: connectorRegistry.execute,
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
    const result = await maintenanceHarness.prompt(buildSkillMaintenanceInput(request, finalAnswer));
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
  const { vaultPath, slug, request, onEvent, signal } = options;
  const runId = request.runId;
  const pending = new Map<string, ProposalResolver>();
  activeProposals.set(runId, pending);
  onEvent({ type: "started", runId });

  let harness: AgentHarness | null = null;
  const normalSkillActions: AgentSkillMaintenanceRecord[] = [];
  const onAbort = () => {
    void harness?.abort();
  };
  signal.addEventListener("abort", onAbort);

  try {
    const settings = await settingsStore.loadAppSettings(vaultPath);
    if (settings.ai.providerMode === "disabled") {
      onEvent({ type: "error", runId, message: "AI provider is disabled. Enable it in Settings → AI." });
      return;
    }
    const profile = getActiveProfile(settings.ai, request.profileId);
    const apiKey = await loadApiKey(vaultPath, slug, profile.id);
    const { connection, dialect } = await resolveConnection(vaultPath, slug, request.connectionName);
    const skills = await loadAgentSkills(vaultPath);
    const promptSkills = rankAgentSkills(skills.loaded, request.prompt, SKILL_PROMPT_LIMIT);
    const { models, model } = createTransportForProfile(settings.ai, apiKey, profile.id);
    const contextWindow = model.contextWindow;
    const session = getOrCreateSession(request.sessionId ?? undefined);
    const plan = new ExecutionPlanStore(runId, (snapshot) => {
      onEvent({ type: "plan_updated", runId, plan: snapshot });
      void appendPlanEntry(session, runId, snapshot);
    });
    await appendPlanEntry(session, runId, null);

    const emitUsage = async (estimated: boolean) => {
      const context = await session.buildContext();
      const estimate = estimateContextTokens(context.messages);
      onEvent({
        type: "context_usage",
        runId,
        usedTokens: estimate.tokens,
        contextWindow,
        estimated,
      });
    };

    const compactOnce = async () => {
      if (!harness) return;
      onEvent({ type: "compaction", runId, phase: "started" });
      await harness.compact(
        "Preserve the current execution plan, completed evidence, the active step, and every blocked acceptance condition.",
      );
      onEvent({ type: "compaction", runId, phase: "completed" });
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
          makeRequestProposal(runId, toolCallId, onEvent, pending, signal)(proposal),
      }),
    });

    const unsubscribe = harness.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        onEvent({
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
        onEvent({
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
        onEvent({ type: "cancelled", runId });
        return;
      }

      if (isContextOverflow(result, contextWindow)) {
        try {
          await compactOnce();
          result = await harness.prompt(OVERFLOW_CONTINUE_PROMPT);
          await emitUsage(false);
        } catch (err) {
          if (signal.aborted) {
            onEvent({ type: "cancelled", runId });
            return;
          }
          onEvent({
            type: "error",
            runId,
            message: err instanceof Error ? err.message : String(err),
          });
          return;
        }

        if (signal.aborted || result.stopReason === "aborted") {
          onEvent({ type: "cancelled", runId });
          return;
        }
        if (isContextOverflow(result, contextWindow)) {
          onEvent({
            type: "error",
            runId,
            message: "Context still overflows after compaction.",
          });
          return;
        }
      }

      if (result.stopReason === "error") {
        onEvent({
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
      onEvent({ type: "final", runId, content: finalAnswer });
      if (normalSkillActions.length > 0) {
        onEvent({
          type: "skill_maintenance",
          runId,
          actions: normalSkillActions,
          summary: `Updated ${normalSkillActions.length} internal knowledge Skill${normalSkillActions.length === 1 ? "" : "s"}.`,
        });
      } else {
        await runSkillMaintenance({
          vaultPath,
          request,
          finalAnswer,
          models,
          model,
          skills,
          connection,
          aiSettings: settings.ai,
          onAbortHarness: (nextHarness) => {
            harness = nextHarness;
          },
          onEvent,
          signal,
        });
      }
    } finally {
      unsubscribe();
    }
  } catch (err) {
    const isAbort = signal.aborted || (err instanceof Error && err.name === "AbortError");
    if (isAbort) {
      onEvent({ type: "cancelled", runId });
    } else {
      log.error("agent run failed", { runId, err: err instanceof Error ? err.message : String(err) });
      onEvent({ type: "error", runId, message: err instanceof Error ? err.message : String(err) });
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    activeProposals.delete(runId);
  }
}
