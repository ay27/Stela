/**
 * Agent 的 system / user 消息构造。
 *
 * 单独成文件的理由和 agent-tools.ts 一样：`agent.ts` 静态引入了 connector
 * registry 与 result-store（进而 `electron.app`），plain Node 下加载不了。
 * 把提示词摘出来，评测脚本就能复用**产品同一份提示**而不是抄一份副本。
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";

import type { AgentRunRequest, AiPromptLocale, ConnectionEntry } from "@shared/types";

const AGENT_ATTACHMENT_CHAR_BUDGET = 30_000;

function languageInstruction(locale: AiPromptLocale | undefined): string {
  return locale === "zh" ? "Respond in Simplified Chinese." : "Respond in English.";
}

export function buildSystemPrompt(
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
    "Once you know a table name, use search_sql_usage instead of search_vault to find which notes actually query it and how it is normally joined and filtered — it is an exact AST lookup rather than a text match.",
    "Retrieval results report totalMatches/truncated. If truncated, narrow the keywords rather than assuming you saw everything; if there are zero matches, say so and ask the user instead of inventing a table or column.",
    "Never assume schema or row values you haven't fetched with a tool.",
    "SQL row limits are enforced automatically; you don't need to add LIMIT yourself.",
    "In vault Markdown, executable SQL blocks MUST use fenced ```runsql``` — ```sql``` is a plain code fence and will not become a RunSQL node.",
    "A runsql fence will be followed by an HTML <detail> block: that is the latest successful-run summary plus result-ref-id, written by the execution pipeline. When proposing edits, do not invent, delete, or rewrite <detail> unless the user explicitly asks; preserve existing detail text as-is.",
    "Mutating SQL and note edits always require explicit user approval via the tool itself — don't tell the user you already did it until the tool result confirms it.",
    "Ask, don't guess: if a business term could map to several columns, or a metric definition is ambiguous or contradictory across notes, use ask_user. But exhaust cheap self-checks first — if one GROUP BY / COUNT DISTINCT sample would settle it, run that instead of asking. Never ask for something a tool can tell you.",
    "When the user explicitly asks to remember, create, update, or retire reusable data knowledge (a metric definition, business term mapping, SQL dialect constraint, table lineage, or analytical runbook), use save_skill directly. For a save, send one complete call with name, content, and reason; content must include name, description, category, and inline tags frontmatter. action defaults to save; use action: archive only to retire an existing Skill. Do not narrate tool-parameter constraints to the user or try propose_edit for this; propose_edit remains for user notes only.",
    "When you have a final answer, respond with plain text (no further tool calls) and structure it as: conclusion; evidence (exact tables, columns and SQL logic used); key numbers; **the assumptions you made**; anything still uncertain. The assumptions section is mandatory — if you resolved an ambiguity yourself, say which interpretation you picked and why.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** 助手消息里的纯文本部分（丢掉 thinking 与 toolCall 块）。 */
export function assistantText(message: AssistantMessage | AgentMessage): string {
  if (!("content" in message)) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  return content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function truncateForAgentContext(
  text: string,
  remainingBudget: number,
): { text: string; remainingBudget: number } {
  if (remainingBudget <= 0) return { text: "", remainingBudget: 0 };
  if (text.length <= remainingBudget) return { text, remainingBudget: remainingBudget - text.length };
  const omitted = text.length - remainingBudget;
  return {
    text: `${text.slice(0, Math.max(0, remainingBudget - 80))}\n\n[truncated ${omitted} chars]`,
    remainingBudget: 0,
  };
}

export function buildUserContent(request: AgentRunRequest): string {
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
