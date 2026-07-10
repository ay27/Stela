/**
 * Harness agent 循环：模型坐驾驶位，我们只提供「工具 + 循环 + 护栏 + trace」。
 *
 * 一轮迭代 = `callAgentTurn`（原生 function-calling）→ 有 `tool_calls` 就逐个
 * dispatch（[agent-tools.ts](./agent-tools.ts)）+ 流式推事件 → 结果回填
 * `role:"tool"` 消息 → 下一轮；无 `tool_calls` 则收尾。
 *
 * 改动类操作（改动 SQL / propose_edit）通过 `requestProposal` 把「等用户
 * 确认」变成一个 Promise：IPC 层收到用户 approve/reject 后调
 * `respondToProposal` resolve 它，循环才能继续。
 */

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
import {
  AGENT_TOOL_DEFS,
  dispatchTool,
  type AgentToolContext,
  type ProposalRequest,
} from "./agent-tools";
import { callAgentTurn, loadApiKey, type AgentChatMessage } from "./provider";

const log = getLogger("ai.agent");
const AGENT_ATTACHMENT_CHAR_BUDGET = 30_000;

type ProposalResolver = (approve: boolean) => void;

/** runId -> callId -> resolver，供 IPC 层的 respondToProposal 查找。 */
const activeProposals = new Map<string, Map<string, ProposalResolver>>();

/**
 * sessionId -> 该会话累积的对话消息（含 system/user/assistant/tool）。
 * 支撑多轮对话：同一 sessionId 的下一次 run 会在这份历史后面追加新的
 * user 消息继续对话，而不是每次都从只有 system+user 的空白开始。
 *
 * ponytail: 存在内存里，随 app 生命周期增长，没有上限/持久化；单机桌面
 * 应用会话数量小，重启即清空。上限=长时间不重启会积累多个旧会话占内存；
 * 升级路径=加个数上限的 LRU，或在前端"新建对话"时清掉旧的 sessionId。
 */
const sessions = new Map<string, AgentChatMessage[]>();

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

const TOOL_RESULT_LOG_CHARS = 500;
const TOOL_RESULT_SUMMARY_CHARS = 12_000;

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

  try {
    const settings = await settingsStore.loadAppSettings(vaultPath);
    if (settings.ai.providerMode === "disabled") {
      onEvent({ type: "error", runId, message: "AI provider is disabled. Enable it in Settings → AI." });
      return;
    }
    const apiKey = await loadApiKey(vaultPath, slug);
    const { connection, dialect } = await resolveConnection(vaultPath, slug, request.connectionName);

    const toolCtx: Omit<AgentToolContext, "requestProposal"> = {
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
    };

    const existing = request.sessionId ? sessions.get(request.sessionId) : undefined;
    const messages: AgentChatMessage[] =
      existing ?? [{ role: "system", content: buildSystemPrompt(request, connection, dialect) }];
    if (!existing && request.sessionId) sessions.set(request.sessionId, messages);
    messages.push({ role: "user", content: buildUserContent(request) });

    let finished = false;

    for (;;) {
      if (signal.aborted) {
        onEvent({ type: "cancelled", runId });
        finished = true;
        break;
      }

      const turn = await callAgentTurn({
        settings: settings.ai,
        apiKey,
        messages,
        tools: AGENT_TOOL_DEFS,
        signal,
      });

      if (turn.toolCalls.length === 0) {
        onEvent({ type: "final", runId, content: turn.content ?? "" });
        finished = true;
        break;
      }

      if (turn.content) {
        onEvent({ type: "assistant_message", runId, content: turn.content });
      }
      messages.push({ role: "assistant", content: turn.content ?? null, tool_calls: turn.toolCalls });

      for (const call of turn.toolCalls) {
        if (signal.aborted) {
          onEvent({ type: "cancelled", runId });
          finished = true;
          break;
        }
        let parsedArgs: unknown = {};
        try {
          parsedArgs = JSON.parse(call.function.arguments);
        } catch {
          // 让工具自己处理参数缺失/非法；这里只是给 timeline 一个可读的展示值。
        }
        onEvent({
          type: "tool_call",
          runId,
          call: { callId: call.id, name: call.function.name, arguments: parsedArgs },
        });

        const ctx: AgentToolContext = {
          ...toolCtx,
          requestProposal: makeRequestProposal(runId, call.id, onEvent, pending, signal),
        };
        const outcome = await dispatchTool(call.function.name, call.function.arguments, ctx);
        log.debug("tool result", {
          runId,
          tool: call.function.name,
          ok: outcome.ok,
          preview: outcome.text.slice(0, TOOL_RESULT_LOG_CHARS),
        });
        onEvent({
          type: "tool_result",
          runId,
          callId: call.id,
          ok: outcome.ok,
          summary: outcome.text.slice(0, TOOL_RESULT_SUMMARY_CHARS),
        });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: outcome.text,
        });
      }
      if (finished) break;
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
    activeProposals.delete(runId);
  }
}
