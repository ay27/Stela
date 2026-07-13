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
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { isContextOverflow, type AssistantMessage } from "@earendil-works/pi-ai";

import type {
  AgentEvent,
  AgentProposalResponse,
  AgentRunRequest,
  AiPromptLocale,
  ConnectionEntry,
} from "@shared/types";

import * as connectionsStore from "../connections-store";
import * as connectorRegistry from "../connectors/registry";
import { getLogger } from "../logger";
import * as settingsStore from "../settings-store";
import { createAgentTools, type ProposalRequest } from "./agent-tools";
import { createStelaTransport, loadApiKey } from "./provider";

const log = getLogger("ai.agent");
const AGENT_ATTACHMENT_CHAR_BUDGET = 30_000;
const TOOL_RESULT_SUMMARY_CHARS = 12_000;
const OVERFLOW_CONTINUE_PROMPT =
  "The previous request exceeded the model context window. Continue from the compacted history and finish the user's last request.";

type ProposalResolver = (approve: boolean) => void;

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

/** IPC 入口：用户在前端 approve/reject 一个 proposal 时调用。找不到（已超时/run 已结束）返回 false。 */
export function respondToProposal(response: AgentProposalResponse): boolean {
  const pending = activeProposals.get(response.runId);
  const resolver = pending?.get(response.callId);
  if (!resolver) return false;
  pending!.delete(response.callId);
  resolver(response.approve);
  return true;
}

function languageInstruction(locale: AiPromptLocale | undefined): string {
  return locale === "zh" ? "Respond in Simplified Chinese." : "Respond in English.";
}

function buildSystemPrompt(
  request: AgentRunRequest,
  connection: ConnectionEntry | null,
  dialect: string | null,
): string {
  return [
    "You are Stela's data analysis agent, running inside a Markdown+SQL notes app.",
    languageInstruction(request.locale),
    "You have tools to browse the vault, inspect data schemas, run SQL, and propose note edits.",
    connection
      ? `The active data connection is "${request.connectionName}" (kind: ${connection.kind}${dialect ? `, dialect: ${dialect}` : ""}).`
      : "No data connection is configured for the current note; SQL/schema tools will fail until one is set.",
    request.mentionedTables && request.mentionedTables.length > 0
      ? `The user explicitly mentioned these tables: ${request.mentionedTables.join(", ")}. Prefer get_table_schema for them before guessing schema.`
      : null,
    request.referencedNotes && request.referencedNotes.length > 0
      ? `The user explicitly referenced these notes: ${request.referencedNotes.join(", ")}. Use read_note on these paths before relying on their contents; do not guess note text.`
      : null,
    "When you don't know which table to query, use search_tables with business keywords before guessing table names.",
    "For data-analysis questions, follow this playbook: (1) identify candidate tables with mentioned tables, search_tables, and only then list_databases/list_tables; (2) inspect schemas before writing SQL; (3) if the user uses business terms such as pbr/coloring/status, map them to concrete columns by checking column names, DDL comments, vault notes, and small grouped samples; (4) run a small verification SQL first when field meaning is uncertain; (5) if results contradict the hypothesis, try the next plausible field and say what changed; (6) finish with the exact table, fields, SQL logic, and numbers used.",
    "Use search_vault/list_vault_files/read_note for business definitions in notes. read_note supports offset/maxChars for paging through large notes.",
    "Never assume schema or row values you haven't fetched with a tool.",
    "SQL row limits are enforced automatically; you don't need to add LIMIT yourself.",
    "Mutating SQL and note edits always require explicit user approval via the tool itself — don't tell the user you already did it until the tool result confirms it.",
    "When you have a final answer, respond with plain text (no further tool calls). Keep it concise and reference the concrete numbers/tables you found.",
  ]
    .filter(Boolean)
    .join("\n");
}

function truncateForAgentContext(text: string, remainingBudget: number): { text: string; remainingBudget: number } {
  if (remainingBudget <= 0) return { text: "", remainingBudget: 0 };
  if (text.length <= remainingBudget) return { text, remainingBudget: remainingBudget - text.length };
  const omitted = text.length - remainingBudget;
  return {
    text: `${text.slice(0, Math.max(0, remainingBudget - 80))}\n\n[truncated ${omitted} chars]`,
    remainingBudget: 0,
  };
}

function buildUserContent(request: AgentRunRequest): string {
  const parts = [request.prompt];
  if (request.referencedNotes && request.referencedNotes.length > 0) {
    parts.push(
      [
        "Referenced notes:",
        ...request.referencedNotes.map((notePath: string) => `- ${notePath}`),
        "Use read_note with these paths when their contents matter.",
      ].join("\n"),
    );
  }

  let remainingBudget = AGENT_ATTACHMENT_CHAR_BUDGET;
  for (const attachment of request.attachments ?? []) {
    const raw =
      attachment.kind === "runsql"
        ? `Attached RunSQL block: ${attachment.label}${attachment.sourcePath ? ` (${attachment.sourcePath})` : ""}\n\n\`\`\`sql\n${attachment.sql}\n\`\`\``
        : `Attached selection: ${attachment.label}${attachment.sourcePath ? ` (${attachment.sourcePath})` : ""}\n\n${attachment.text}`;
    const next = truncateForAgentContext(raw, remainingBudget);
    if (!next.text) break;
    parts.push(next.text);
    remainingBudget = next.remainingBudget;
  }
  return parts.join("\n\n");
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

function makeRequestProposal(
  runId: string,
  callId: string,
  onEvent: (event: AgentEvent) => void,
  pending: Map<string, ProposalResolver>,
  signal: AbortSignal,
): (proposal: ProposalRequest) => Promise<boolean> {
  return (proposal) => {
    onEvent({ type: "proposal", runId, callId, kind: proposal.kind, payload: proposal.payload });
    return new Promise<boolean>((resolve) => {
      const onAbort = () => {
        pending.delete(callId);
        resolve(false);
      };
      pending.set(callId, (approve) => {
        signal.removeEventListener("abort", onAbort);
        resolve(approve);
      });
      signal.addEventListener("abort", onAbort, { once: true });
    });
  };
}

function assistantText(message: AssistantMessage | AgentMessage): string {
  if (!("content" in message) || typeof message.content === "string") {
    return typeof message.content === "string" ? message.content : "";
  }
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
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

function getOrCreateSession(sessionId: string | undefined): Session {
  if (sessionId) {
    const existing = sessions.get(sessionId);
    if (existing) return existing;
    const created = new Session(new InMemorySessionStorage());
    sessions.set(sessionId, created);
    return created;
  }
  return new Session(new InMemorySessionStorage());
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
    const apiKey = await loadApiKey(vaultPath, slug);
    const { connection, dialect } = await resolveConnection(vaultPath, slug, request.connectionName);
    const { models, model } = createStelaTransport(settings.ai, apiKey);
    const contextWindow = model.contextWindow;
    const session = getOrCreateSession(request.sessionId ?? undefined);

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
      await harness.compact();
      onEvent({ type: "compaction", runId, phase: "completed" });
      await emitUsage(true);
    };

    harness = new AgentHarness({
      env: new NodeExecutionEnv({ cwd: vaultPath }),
      session,
      models,
      model,
      thinkingLevel: "off",
      systemPrompt: buildSystemPrompt(request, connection, dialect),
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
        },
        requestProposal: (toolCallId, proposal) =>
          makeRequestProposal(runId, toolCallId, onEvent, pending, signal)(proposal),
      }),
    });

    const unsubscribe = harness.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        const message = event.message as AssistantMessage;
        const hasTools = message.content.some((block) => block.type === "toolCall");
        const text = assistantText(message);
        if (hasTools && text) {
          onEvent({ type: "assistant_message", runId, content: text });
        }
        return;
      }
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

      onEvent({ type: "final", runId, content: assistantText(result) });
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
