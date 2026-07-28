/**
 * Agent 工具集：JSON Schema 定义 + dispatch 到现有 service 函数。
 *
 * 工具体本身几乎零新逻辑——真正的能力都来自已有 service（connector registry /
 * schema-context / search / vault-fs）。这里只做：参数校验、护栏接线（SQL
 * 只读放行/改动确认、编辑走 propose）、结果截断防止撑爆上下文。
 */

import path from "node:path";
import { randomUUID } from "node:crypto";

import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import { AppError } from "@shared/errors";
import type {
  AgentToolName,
  AgentProposalKind,
  AgentProposalPayload,
  AiSettings,
  ColumnDef,
  ConnectionEntry,
  ConnectorKindMeta,
  QueryResult,
  SqlIndexFilter,
  SqlIndexHit,
  SqlIndexOperation,
} from "@shared/types";

import { getLogger } from "../logger";
import * as search from "../search";
import * as vaultFs from "../vault-fs";
import { notifyFileChanged } from "../vault-watcher";
import { ExecutionPlanStore, type CreatePlanStep } from "./execution-plan";
import { resolveNamedTableSchemas, searchTables } from "./schema-context";
import { classifySql } from "./sql-guard";
import {
  AGENT_SKILL_LIMITS_PROMPT,
  archiveAgentSkill,
  loadAgentSkills,
  MAX_AGENT_SKILL_CHARS,
  rankAgentSkills,
  saveAgentSkill,
  type AgentSkillMaintenanceRecord,
  type LoadedAgentSkill,
} from "./agent-skills";

/**
 * Connector registry 的最小依赖面。用注入而不是静态 `import registry.ts`——
 * registry 会拉进 `electron.app`（bundled-plugins.ts），静态引入会让这个纯逻辑
 * 文件没法在 plain Node（`tsx` 自测）里加载。真实调用见 [agent.ts](./agent.ts)
 * 用真正的 `connectorRegistry.*` 构造 `AgentToolContext.connector`。
 */
export interface AgentConnectorOps {
  listKinds(): ConnectorKindMeta[];
  listDatabases(kind: string, config: unknown): Promise<string[]>;
  listTables(kind: string, config: unknown, db?: string | null): Promise<string[]>;
  execute(kind: string, config: unknown, sql: string): Promise<QueryResult>;
}

/**
 * SQL 事实索引的最小依赖面。同样用注入而不是静态 import——`sql-index.ts` 会拉进
 * connector registry（进而 `electron.app`），静态引入会让本文件在 plain Node 下加载失败。
 */
export interface AgentSqlIndexOps {
  query(filter: SqlIndexFilter): Promise<SqlIndexHit[]>;
}

/**
 * 把一次 agent SQL 执行落进执行历史。同样注入——写侧要 `deviceProfile`（electron `app`）。
 *
 * 存在的理由：agent 跑的 SQL 此前完全不入库，Run History 里看不到、Git 同步不到，
 * 用户无从复核 agent 到底查了什么。这是数据丢失，不是优化。
 */
export type AgentRunRecorder = (run: {
  runId: string;
  blockId: string;
  sql: string;
  status: "ok" | "err";
  message: string | null;
  startedAt: number;
  elapsedMs: number;
  rowCount: number;
  connectionName: string;
  notePath: string | null;
  columns: ColumnDef[];
  rows: unknown[][];
}) => Promise<void>;

const log = getLogger("ai.agent-tools");
const RESULT_CHAR_BUDGET = 30_000;

function truncate(text: string, maxChars = RESULT_CHAR_BUDGET): string {
  return text.length <= maxChars
    ? text
    : `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`;
}

function ok(value: unknown, maxChars = RESULT_CHAR_BUDGET): ToolOutcome {
  return { ok: true, text: truncate(typeof value === "string" ? value : JSON.stringify(value, null, 2), maxChars) };
}

function fail(message: string): ToolOutcome {
  return { ok: false, text: message };
}

export interface ToolOutcome {
  ok: boolean;
  text: string;
}

export interface ProposalRequest {
  kind: AgentProposalKind;
  payload: AgentProposalPayload;
}

/**
 * 单次 run 的提问上限。硬限在工具侧而不是只写在 prompt 里——prompt 约束是建议，
 * 这里是保证：模型再怎么犹豫也不会把对话变成问答轰炸。
 */
const MAX_QUESTIONS_PER_RUN = 3;

/**
 * 工具执行上下文，由 [agent.ts](./agent.ts) 每次 run 构造一次。
 * `requestProposal` 把「等用户确认」抽象成一个 Promise：agent 循环负责发
 * proposal 事件、注册 resolver，用户 approve/reject 时 resolve 这个 Promise。
 */
export interface AgentToolContext {
  vaultPath: string;
  connectionName: string | null;
  connection: ConnectionEntry | null;
  aiSettings: AiSettings;
  connector: AgentConnectorOps;
  sqlIndex: AgentSqlIndexOps;
  skills: LoadedAgentSkill[];
  mode: "normal" | "maintenance";
  onSkillMaintenance?: (record: AgentSkillMaintenanceRecord) => void;
  /**
   * 单次 run 的可变状态：`runId` / `notePath` 用于给执行历史生成
   * `agent:<runId>` 形式的 blockId；`questionsAsked` 由 `ask_user` 自增。
   */
  run: { runId: string; notePath: string | null; questionsAsked: number };
  plan?: ExecutionPlanStore;
  recordRun: AgentRunRecorder;
  requestProposal: (proposal: ProposalRequest) => Promise<boolean | string>;
}

/**
 * Build pi AgentTool wrappers around {@link dispatchTool}.
 *
 * Tools use `executionMode: "parallel"` so one assistant turn can fan out
 * schema/vault/SQL lookups. `propose_edit` stays sequential (ordered note
 * proposal UX). `run_sql` is parallel: sql-guard blocks writes by default and
 * mutations still wait on proposal. Pi rule: if any call in a batch is
 * sequential, the whole batch runs sequentially.
 */
export function createAgentTools(options: {
  ctx: Omit<AgentToolContext, "requestProposal">;
  requestProposal: (toolCallId: string, proposal: ProposalRequest) => Promise<boolean | string>;
}): AgentTool[] {
  const { ctx, requestProposal } = options;
  const tools: AgentTool[] = [
    {
      name: "list_databases",
      label: "List databases",
      description: "List databases/schemas visible through the current data connection.",
      parameters: Type.Object({}),
      executionMode: "parallel",
      execute: (toolCallId) => runTool("list_databases", toolCallId, {}, ctx, requestProposal),
    },
    {
      name: "list_tables",
      label: "List tables",
      description: "List tables in a database through the current data connection.",
      parameters: Type.Object({
        database: Type.Optional(Type.String({ description: "Database name; omit to use the connector default." })),
      }),
      executionMode: "parallel",
      execute: (toolCallId, params) => runTool("list_tables", toolCallId, params, ctx, requestProposal),
    },
    {
      name: "search_tables",
      label: "Search tables",
      description:
        "Fuzzy-search for candidate tables by keywords (business terms, partial table names). Use this when you don't know the exact table name yet — it scores table names, column names, and Chinese/English DDL column comments. Each candidate also reports vaultUsage (how many notes and SQL blocks actually query it, and the last run date): prefer tables that are actually used over ones that merely look similar, and if the top candidates all have zero usage, say so rather than guessing.",
      parameters: Type.Object({
        keywords: Type.Array(Type.String(), {
          description: 'Keywords to match against table/column names and DDL, e.g. ["quarter", "revenue", "order"].',
        }),
        limit: Type.Optional(Type.Number({ description: "Optional max candidate tables to return. Defaults to 10." })),
      }),
      executionMode: "parallel",
      execute: (toolCallId, params) => runTool("search_tables", toolCallId, params, ctx, requestProposal),
    },
    {
      name: "get_table_schema",
      label: "Get table schema",
      description: "Fetch column names/types and DDL (if available) for one or more tables.",
      parameters: Type.Object({
        tables: Type.Array(Type.String(), {
          description: "Table names, optionally qualified as db.table.",
        }),
      }),
      executionMode: "parallel",
      execute: (toolCallId, params) => runTool("get_table_schema", toolCallId, params, ctx, requestProposal),
    },
    {
      name: "run_sql",
      label: "Run SQL",
      description:
        "Run a SQL statement through the current data connection. Read-only statements (SELECT/WITH/SHOW/DESCRIBE/EXPLAIN) run immediately; Stela caps saved/displayed result rows without rewriting SQL. Mutating statements (INSERT/UPDATE/DELETE/DDL/...) are blocked unless the user has enabled mutations, and always require explicit approval.",
      parameters: Type.Object({
        sql: Type.String(),
      }),
      executionMode: "parallel",
      execute: (toolCallId, params) => runTool("run_sql", toolCallId, params, ctx, requestProposal),
    },
    {
      name: "search_vault",
      label: "Search vault",
      description:
        "Full-text search across the vault's Markdown notes, returning ranked notes (not raw lines). Every keyword is scored in one pass and notes matching more of them rank higher, so pass all your keywords at once. The result reports totalMatches/truncated so you can tell whether you saw everything.",
      parameters: Type.Object({
        keyword: Type.Optional(Type.String({ description: "Single keyword for compatibility." })),
        keywords: Type.Optional(
          Type.Array(Type.String(), {
            description: "Preferred: all business terms or identifiers to score together.",
          }),
        ),
        maxNotes: Type.Optional(Type.Number({ description: "Max notes to return. Defaults to 40." })),
      }),
      executionMode: "parallel",
      execute: (toolCallId, params) => runTool("search_vault", toolCallId, params, ctx, requestProposal),
    },
    {
      name: "search_sql_usage",
      label: "Search SQL usage",
      description:
        "Find which notes actually read or write a given table, from Stela's SQL AST index. This is an exact structural lookup — prefer it over search_vault when you already know a table name and want the notes that query it, or to learn how a table is normally joined and filtered.",
      parameters: Type.Object({
        readTable: Type.Optional(
          Type.String({ description: "Table read by the SQL, as table or db.table." }),
        ),
        writeTable: Type.Optional(
          Type.String({ description: "Table written by the SQL, as table or db.table." }),
        ),
        operations: Type.Optional(
          Type.Array(Type.String(), {
            description:
              'Restrict to these SQL operations: select / insert / replace / update / delete / upsert / ddl / other.',
          }),
        ),
        limit: Type.Optional(Type.Number({ description: "Max SQL blocks to inspect. Defaults to 60." })),
      }),
      executionMode: "parallel",
      execute: (toolCallId, params) => runTool("search_sql_usage", toolCallId, params, ctx, requestProposal),
    },
    {
      name: "list_vault_files",
      label: "List vault files",
      description:
        "List Markdown files in the vault by relative path. Use this before read_note when you need to discover likely notes/files.",
      parameters: Type.Object({
        maxFiles: Type.Optional(Type.Number({ description: "Max files to return. Defaults to 200." })),
      }),
      executionMode: "parallel",
      execute: (toolCallId, params) => runTool("list_vault_files", toolCallId, params, ctx, requestProposal),
    },
    {
      name: "read_note",
      label: "Read note",
      description:
        "Read Markdown content of a note by vault-relative or absolute path. For large files, use offset/maxChars to page through the file.",
      parameters: Type.Object({
        path: Type.String(),
        offset: Type.Optional(Type.Number({ description: "Character offset to start reading from. Defaults to 0." })),
        maxChars: Type.Optional(
          Type.Number({
            description:
              "Maximum characters to return. Defaults to 50000, max 120000. Use 0 only when you truly need the full note.",
          }),
        ),
      }),
      executionMode: "parallel",
      execute: (toolCallId, params) => runTool("read_note", toolCallId, params, ctx, requestProposal),
    },
    {
      name: "create_plan",
      label: "Create execution plan",
      description:
        "Create a concise linear execution plan before starting a multi-step analysis. Use 2-8 steps, each with a stable id, intent, and observable acceptance condition.",
      parameters: Type.Object({
        steps: Type.Array(
          Type.Object({
            id: Type.String(),
            title: Type.String(),
            intent: Type.String(),
            acceptance: Type.String(),
          }),
        ),
      }),
      executionMode: "sequential",
      execute: (toolCallId, params) => runTool("create_plan", toolCallId, params, ctx, requestProposal),
    },
    {
      name: "update_plan",
      label: "Update execution plan",
      description:
        "Complete, block, or skip the current execution-plan step. Completed steps require concise evidence; include runId when the evidence is a Stela SQL run.",
      parameters: Type.Object({
        stepId: Type.String(),
        status: Type.Union([Type.Literal("completed"), Type.Literal("blocked"), Type.Literal("skipped")]),
        evidence: Type.Optional(Type.String()),
        runId: Type.Optional(Type.String()),
      }),
      executionMode: "sequential",
      execute: (toolCallId, params) => runTool("update_plan", toolCallId, params, ctx, requestProposal),
    },
    {
      name: "get_plan",
      label: "Get execution plan",
      description: "Read the current execution plan before choosing the next analysis action.",
      parameters: Type.Object({}),
      executionMode: "sequential",
      execute: (toolCallId) => runTool("get_plan", toolCallId, {}, ctx, requestProposal),
    },
    {
      name: "load_skill",
      label: "Load Skill",
      description: "Load the concise reusable guidance for one available Agent Skill by its exact name.",
      parameters: Type.Object({ name: Type.String({ description: "Exact Skill name from search_skills or the available Skills list." }) }),
      executionMode: "parallel",
      execute: (toolCallId, params) => runTool("load_skill", toolCallId, params, ctx, requestProposal),
    },
    {
      name: "search_skills",
      label: "Search Skills",
      description:
        "Search the internal data-knowledge Skill library by business terms, tables, metrics, or SQL dialect. Returns concise metadata only; use load_skill with an exact name to read instructions.",
      parameters: Type.Object({
        query: Type.String({ description: "Keywords describing the knowledge you need." }),
        limit: Type.Optional(Type.Number({ description: "Max candidates to return. Defaults to 8." })),
      }),
      executionMode: "parallel",
      execute: (toolCallId, params) => runTool("search_skills", toolCallId, params, ctx, requestProposal),
    },
    {
      name: "save_skill",
      label: "Save Skill",
      description:
        `Save a compact validated data-knowledge SKILL.md or archive an obsolete Skill. Save only reusable, verified rules with their scope and minimal check; never copy an analysis, result rows, or one-off SQL. ${AGENT_SKILL_LIMITS_PROMPT} For a save, call once with name, content, and reason; action defaults to save. content must include YAML frontmatter with description, category, and inline tags. For archive, set action to archive and omit content. Never use it for user notes or arbitrary files.`,
      parameters: Type.Object({
        action: Type.Optional(Type.Union([Type.Literal("save"), Type.Literal("archive")])),
        name: Type.String({ description: "Required lowercase Skill directory name, e.g. postgresql-demo-tasks." }),
        content: Type.Optional(
          Type.String({
            description:
              `Required for save: short SKILL.md with reusable scope, rule, and minimal verification. ${AGENT_SKILL_LIMITS_PROMPT} Example: ---\\nname: postgresql-demo-tasks\\ndescription: Reusable PostgreSQL demo_tasks business definitions.\\ncategory: business-glossary\\ntags: [postgresql, demo-tasks]\\n---\\n\\n# Task ownership\\n- Rule: owner is the responsible team.\\n- Verify: check demo_tasks.owner.`,
          }),
        ),
        reason: Type.String({ description: "Required short factual reason for saving or archiving." }),
      }),
      executionMode: "sequential",
      execute: (toolCallId, params) => runTool("save_skill", toolCallId, params, ctx, requestProposal),
    },
    {
      name: "propose_edit",
      label: "Propose edit",
      description:
        "Propose editing a note. Use newContent to replace the whole file, or oldText/newText for one exact local replacement in long files. This never writes to disk directly — it shows the user a diff and waits for approval. Executable SQL in notes must use ```runsql``` fences (not ```sql```). Do not invent, delete, or rewrite trailing <detail> blocks unless the user explicitly asks.",
      parameters: Type.Object({
        path: Type.String(),
        newContent: Type.Optional(
          Type.String({ description: "Full replacement content. Prefer oldText/newText for long notes." }),
        ),
        oldText: Type.Optional(Type.String({ description: "Exact text to replace once in the existing note." })),
        newText: Type.Optional(Type.String({ description: "Replacement text for oldText." })),
        description: Type.Optional(
          Type.String({ description: "One-line summary of what changed, shown to the user." }),
        ),
      }),
      executionMode: "sequential",
      execute: (toolCallId, params) => runTool("propose_edit", toolCallId, params, ctx, requestProposal),
    },
    {
      name: "ask_user",
      label: "Ask the user",
      description:
        `Ask the user one short question and wait for the answer. Use this instead of guessing when a business term maps to several plausible columns, when a metric definition is ambiguous, or when the vault gives contradictory definitions. First exhaust what you can check yourself (schemas, DDL comments, notes, a small GROUP BY sample); only ask what data cannot answer. At most ${MAX_QUESTIONS_PER_RUN} questions per run — spend them on the one thing that would change your answer.`,
      parameters: Type.Object({
        question: Type.String({ description: "One specific question, in the user's language." }),
        options: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "Candidate answers to offer as buttons, e.g. the concrete columns you are choosing between. The user can still type a free-form answer.",
          }),
        ),
        context: Type.Optional(
          Type.String({ description: "One line on what you already checked and why you are stuck." }),
        ),
      }),
      executionMode: "sequential",
      execute: (toolCallId, params) => runTool("ask_user", toolCallId, params, ctx, requestProposal),
    },
  ];
  if (ctx.mode === "maintenance") {
    return tools.filter((tool) => tool.name === "load_skill" || tool.name === "search_skills" || tool.name === "save_skill");
  }
  return tools;
}

async function runTool(
  name: string,
  toolCallId: string,
  params: unknown,
  baseCtx: Omit<AgentToolContext, "requestProposal">,
  requestProposal: (toolCallId: string, proposal: ProposalRequest) => Promise<boolean | string>,
) {
  const outcome = await dispatchTool(name, JSON.stringify(params ?? {}), {
    ...baseCtx,
    requestProposal: (proposal) => requestProposal(toolCallId, proposal),
  });
  if (!outcome.ok) {
    throw new Error(outcome.text);
  }
  return {
    content: [{ type: "text" as const, text: outcome.text }],
    details: { summary: outcome.text },
  };
}

function resolveDialect(kind: string, ctx: AgentToolContext): string {
  return ctx.connector.listKinds().find((meta) => meta.kind === kind)?.dialect ?? kind;
}

function requireConnection(ctx: AgentToolContext): ConnectionEntry {
  if (!ctx.connectionName || !ctx.connection) {
    throw new AppError(
      "no_connection",
      "No data connection is configured for the current note. Ask the user to set `connection_name` in frontmatter, or answer from vault notes only.",
    );
  }
  return ctx.connection;
}

function stringList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return raw.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.floor(value)))
    : fallback;
}

function resolveVaultTarget(vaultPath: string, target: string): string {
  return path.isAbsolute(target) ? target : path.join(vaultPath, target);
}

function formatQueryResult(result: QueryResult): unknown {
  if (result.kind === "mutation") {
    return { kind: "mutation", affectedRows: result.affectedRows, elapsedMs: result.elapsedMs };
  }
  return {
    kind: "query",
    columns: result.columns,
    rowCount: result.rows.length,
    rows: result.rows.slice(0, 200),
    elapsedMs: result.elapsedMs,
  };
}

async function runListDatabases(ctx: AgentToolContext): Promise<ToolOutcome> {
  const connection = requireConnection(ctx);
  const dbs = await ctx.connector.listDatabases(connection.kind, connection.config);
  return ok(dbs);
}

async function runListTables(args: { database?: string }, ctx: AgentToolContext): Promise<ToolOutcome> {
  const connection = requireConnection(ctx);
  const tables = await ctx.connector.listTables(connection.kind, connection.config, args.database ?? null);
  return ok(tables);
}

async function runSearchTables(args: { keywords?: unknown; limit?: unknown }, ctx: AgentToolContext): Promise<ToolOutcome> {
  const connection = requireConnection(ctx);
  const keywords = stringList(args.keywords);
  if (keywords.length === 0) return fail("keywords must be a non-empty array of strings.");
  const limit = boundedInt(args.limit, 10, 1, 20);
  const targets = await searchTables({
    connectionName: ctx.connectionName!,
    connection,
    keywords,
    limit,
  });
  if (targets.length === 0) {
    return fail("No matching tables found. Try list_databases/list_tables, or broaden the keywords.");
  }
  const usage = await Promise.all(
    targets.map((target) => tableUsage(ctx, target.table)),
  );
  return ok(
    targets.map((t, i) => ({
      database: t.database,
      table: t.table,
      matchReason: t.matchReason,
      score: t.score,
      // 关键词分只说明「名字/注释像」，用不用过才说明「这张表是不是活的」。
      // 刻意不折进 score：M1/M2 的 gold 正是由 runsql 块派生的，把它做成
      // 打分信号就等于用答案给自己加分（见 ADR-0026 的评测铁律）。
      vaultUsage: usage[i],
      columns: t.columns?.slice(0, 30),
    })),
  );
}

/** 该表在 vault 的 runsql 块里被读写过多少次、最近一次执行是什么时候。 */
async function tableUsage(
  ctx: AgentToolContext,
  table: string | null | undefined,
): Promise<{ notes: number; blocks: number; lastRunDate: string | null } | null> {
  if (!table) return null;
  try {
    const [reads, writes] = await Promise.all([
      ctx.sqlIndex.query({ readTable: table, maxHits: 100 }),
      ctx.sqlIndex.query({ writeTable: table, maxHits: 100 }),
    ]);
    const hits = [...reads, ...writes];
    if (hits.length === 0) return { notes: 0, blocks: 0, lastRunDate: null };
    const notes = new Set(hits.map((hit) => hit.relPath));
    const lastRunDate = hits.reduce<string | null>(
      (best, hit) => (hit.runDate && (!best || hit.runDate > best) ? hit.runDate : best),
      null,
    );
    return { notes: notes.size, blocks: hits.length, lastRunDate };
  } catch {
    return null;
  }
}

async function runGetTableSchema(args: { tables?: unknown }, ctx: AgentToolContext): Promise<ToolOutcome> {
  const connection = requireConnection(ctx);
  const tables = stringList(args.tables);
  if (tables.length === 0) return fail("tables must be a non-empty array of table names.");
  const targets = await resolveNamedTableSchemas({
    tableNames: tables,
    connectionName: ctx.connectionName!,
    connection,
    matchReason: "agent get_table_schema",
    request: {
      action: "explain-table",
      context: {
        source: "schema",
        connectionName: ctx.connectionName,
        connector: { kind: connection.kind, displayName: connection.kind, dialect: resolveDialect(connection.kind, ctx) },
      },
    },
  });
  if (targets.length === 0) return fail(`No schema found for: ${tables.join(", ")}`);
  return ok(
    targets.map((t) => ({
      database: t.database,
      table: t.table,
      columns: t.columns,
      ddlSnippet: t.ddlSnippet,
      source: t.source,
    })),
  );
}

async function runSql(args: { sql?: string }, ctx: AgentToolContext): Promise<ToolOutcome> {
  const connection = requireConnection(ctx);
  const sql = args.sql;
  if (!sql || !sql.trim()) return fail("sql must be a non-empty string.");
  const classified = classifySql(sql, ctx.aiSettings.agentAllowMutations);
  if (classified.classification === "multi-statement") {
    return fail(classified.blockedReason ?? "Multiple statements are not allowed.");
  }
  if (classified.classification === "mutation") {
    if (!ctx.aiSettings.agentAllowMutations) {
      return fail(classified.blockedReason ?? "Mutating statements are blocked by default.");
    }
    const approved = await ctx.requestProposal({
      kind: "mutation_sql",
      payload: { sql, description: `Run ${classified.keyword ?? "mutation"} statement` },
    });
    if (!approved) return fail("The user rejected this SQL statement. Do not retry it as-is.");
  }
  // 行数上限已在 registry.execute 内核心层统一注入，这里不重复处理。
  const startedAt = Date.now();
  let result: QueryResult;
  try {
    result = await ctx.connector.execute(connection.kind, connection.config, sql);
  } catch (err) {
    await recordAgentRun(ctx, sql, startedAt, null, err);
    throw err;
  }
  const runId = await recordAgentRun(ctx, sql, startedAt, result, null);
  return ok({ runId, result: formatQueryResult(result) });
}

/** 记录失败不应影响 agent 继续工作——落盘异常只记日志。 */
async function recordAgentRun(
  ctx: AgentToolContext,
  sql: string,
  startedAt: number,
  result: QueryResult | null,
  err: unknown,
): Promise<string | null> {
  const elapsedMs = result?.elapsedMs ?? Date.now() - startedAt;
  const isQuery = result?.kind === "query";
  const runId = `${ctx.run.runId}-sql-${randomUUID()}`;
  try {
    await ctx.recordRun({
      // 一次 agent run 可能跑多条 SQL，runId 必须唯一；blockId 保持同一个
      // `agent:<agentRunId>`，这样一次对话里的所有执行归到同一"块"下。
      runId,
      blockId: `agent:${ctx.run.runId}`,
      sql,
      status: result ? "ok" : "err",
      message: result ? null : err instanceof Error ? err.message : String(err),
      startedAt,
      elapsedMs,
      rowCount: isQuery ? result.rows.length : (result?.affectedRows ?? 0),
      connectionName: ctx.connectionName ?? "",
      notePath: ctx.run.notePath,
      columns: isQuery ? result.columns : [],
      rows: isQuery ? result.rows : [],
    });
    return runId;
  } catch (recordErr) {
    log.warn("agent run_sql history write failed", {
      err: recordErr instanceof Error ? recordErr.message : String(recordErr),
    });
    return null;
  }
}

async function runSearchVault(
  args: { keyword?: unknown; keywords?: unknown; maxHits?: unknown; maxNotes?: unknown },
  ctx: AgentToolContext,
): Promise<ToolOutcome> {
  const keywords = Array.from(
    new Set(
      [...(typeof args.keyword === "string" ? [args.keyword] : []), ...stringList(args.keywords)]
        .map((keyword) => keyword.trim())
        .filter(Boolean),
    ),
  );
  if (keywords.length === 0) return fail("keyword or keywords must contain at least one non-empty string.");
  // maxHits 是旧参数名，模型仍会传；两者都接受，语义统一成「返回多少篇笔记」。
  const maxNotes = boundedInt(args.maxNotes ?? args.maxHits, 40, 1, 200);
  const result = await search.searchVaultNotes(ctx.vaultPath, keywords, { maxNotes });
  if (result.notes.length === 0) {
    return fail(
      `No notes match ${keywords.map((keyword) => `"${keyword}"`).join(", ")} ` +
        `(scanned ${result.scannedNotes} notes). Try fewer or broader keywords, use search_sql_usage ` +
        `if you already know a table name, or ask the user which wording they use.`,
    );
  }
  return ok({
    notes: result.notes,
    totalMatches: result.totalMatchedNotes,
    returned: result.returned,
    truncated: result.truncated,
    scannedNotes: result.scannedNotes,
  });
}

const SQL_INDEX_OPERATIONS = new Set<SqlIndexOperation>([
  "select",
  "insert",
  "replace",
  "update",
  "delete",
  "upsert",
  "ddl",
  "other",
]);

/**
 * 「哪些笔记查过表 X」由 AST 倒排精确回答，不再靠正文 substring 猜。
 * 结果按笔记聚合：agent 关心的是「去读哪几篇」，不是「哪一行」。
 */
async function runSearchSqlUsage(
  args: { readTable?: unknown; writeTable?: unknown; operations?: unknown; limit?: unknown },
  ctx: AgentToolContext,
): Promise<ToolOutcome> {
  const readTable = typeof args.readTable === "string" ? args.readTable.trim() : "";
  const writeTable = typeof args.writeTable === "string" ? args.writeTable.trim() : "";
  const operations = stringList(args.operations)
    .map((op) => op.toLowerCase())
    .filter((op): op is SqlIndexOperation => SQL_INDEX_OPERATIONS.has(op as SqlIndexOperation));
  if (!readTable && !writeTable && operations.length === 0) {
    return fail("Provide at least one of readTable, writeTable or operations.");
  }
  const limit = boundedInt(args.limit, 60, 1, 300);

  const hits = await ctx.sqlIndex.query({
    ...(readTable ? { readTable } : {}),
    ...(writeTable ? { writeTable } : {}),
    ...(operations.length > 0 ? { operations } : {}),
    maxHits: limit,
  });
  if (hits.length === 0) {
    return fail(
      "No indexed SQL block reads or writes that table. The table name may be spelled differently, " +
        "or it is only mentioned in prose — try search_vault, or ask the user which table they mean.",
    );
  }

  const byNote = new Map<
    string,
    { path: string; blocks: number; lastRunDate: string | null; operations: Set<string>; firstLine: number }
  >();
  for (const hit of hits) {
    const existing = byNote.get(hit.relPath);
    const entry =
      existing ??
      { path: hit.relPath, blocks: 0, lastRunDate: null, operations: new Set<string>(), firstLine: hit.line };
    entry.blocks++;
    if (hit.runDate && (!entry.lastRunDate || hit.runDate > entry.lastRunDate)) {
      entry.lastRunDate = hit.runDate;
    }
    for (const op of hit.operations) entry.operations.add(op);
    entry.firstLine = Math.min(entry.firstLine, hit.line);
    byNote.set(hit.relPath, entry);
  }

  const notes = [...byNote.values()]
    .sort(
      (a, b) =>
        (b.lastRunDate ?? "").localeCompare(a.lastRunDate ?? "") ||
        b.blocks - a.blocks ||
        a.path.localeCompare(b.path),
    )
    .map((entry) => ({
      path: entry.path,
      blocks: entry.blocks,
      lastRunDate: entry.lastRunDate,
      operations: [...entry.operations],
      firstLine: entry.firstLine,
    }));

  return ok({
    notes,
    matchedBlocks: hits.length,
    truncated: hits.length >= limit,
    sampleSql: hits.slice(0, 3).map((hit) => ({ path: hit.relPath, line: hit.line, sql: hit.snippet })),
  });
}

async function runListVaultFiles(args: { maxFiles?: unknown }, ctx: AgentToolContext): Promise<ToolOutcome> {
  const maxFiles = boundedInt(args.maxFiles, 200, 1, 1_000);
  const files = await search.listVaultFiles(ctx.vaultPath, [".md"]);
  return ok({
    files: files.slice(0, maxFiles).map((file) => path.relative(ctx.vaultPath, file)),
    totalFiles: files.length,
    truncated: files.length > maxFiles,
  });
}

async function runReadNote(args: { path?: unknown; offset?: unknown; maxChars?: unknown }, ctx: AgentToolContext): Promise<ToolOutcome> {
  if (typeof args.path !== "string" || !args.path.trim()) return fail("path must be a non-empty string.");
  const target = await vaultFs.ensureWithinVault(ctx.vaultPath, resolveVaultTarget(ctx.vaultPath, args.path));
  const content = await vaultFs.readFile(target);
  const offset = boundedInt(args.offset, 0, 0, content.length);
  const fullRead = args.maxChars === 0;
  const maxChars = fullRead ? content.length - offset : boundedInt(args.maxChars, 50_000, 1, 120_000);
  const slice = fullRead ? content.slice(offset) : content.slice(offset, offset + maxChars);
  return ok({
    path: path.relative(ctx.vaultPath, target),
    offset,
    charsReturned: slice.length,
    totalChars: content.length,
    nextOffset: offset + slice.length < content.length ? offset + slice.length : null,
    content: slice,
  }, fullRead ? Number.POSITIVE_INFINITY : maxChars + 2_000);
}

function runLoadSkill(args: { name?: unknown }, ctx: AgentToolContext): ToolOutcome {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  const skill = ctx.skills.find((item) => item.metadata.name === name);
  if (!skill) return fail(`No installed Skill named '${name}'. Use only names in the available Skills list.`);
  const content = skill.skill.content;
  const truncated = content.length > MAX_AGENT_SKILL_CHARS;
  return ok({
    name: skill.metadata.name,
    content: truncated ? `${content.slice(0, MAX_AGENT_SKILL_CHARS)}\n\n[truncated: compact this Skill before updating it]` : content,
    truncated,
  }, MAX_AGENT_SKILL_CHARS + 100);
}

function runSearchSkills(args: { query?: unknown; limit?: unknown }, ctx: AgentToolContext): ToolOutcome {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return fail("query must be a non-empty string.");
  const limit = boundedInt(args.limit, 8, 1, 20);
  const skills = rankAgentSkills(ctx.skills, query, limit).map(({ metadata }) => ({
    name: metadata.name,
    description: metadata.description,
    category: metadata.category,
    tags: metadata.tags,
  }));
  return ok({ skills, totalSkills: ctx.skills.length, truncated: skills.length < ctx.skills.length });
}

async function runSaveSkill(
  args: { action?: unknown; name?: unknown; content?: unknown; reason?: unknown },
  ctx: AgentToolContext,
): Promise<ToolOutcome> {
  const action = args.action ?? "save";
  const name = typeof args.name === "string" ? args.name : "";
  const reason = typeof args.reason === "string" && args.reason.trim()
    ? args.reason
    : "Updated internal data knowledge.";
  const record =
    action === "save"
      ? typeof args.content === "string"
        ? await saveAgentSkill(ctx.vaultPath, name, args.content, reason)
        : null
      : action === "archive"
        ? await archiveAgentSkill(ctx.vaultPath, name, reason)
        : null;
  if (!record) return fail("save requires content; action must be save or archive.");
  const refreshed = await loadAgentSkills(ctx.vaultPath);
  ctx.skills.splice(0, ctx.skills.length, ...refreshed.loaded);
  ctx.onSkillMaintenance?.(record);
  return ok(record);
}

async function runProposeEdit(
  args: { path?: unknown; newContent?: unknown; oldText?: unknown; newText?: unknown; description?: unknown },
  ctx: AgentToolContext,
): Promise<ToolOutcome> {
  if (typeof args.path !== "string" || !args.path.trim()) {
    return fail("path must be a non-empty string.");
  }
  if (args.newContent !== undefined && typeof args.newContent !== "string") {
    return fail("newContent must be a string when provided.");
  }
  if (
    args.newContent === undefined &&
    (typeof args.oldText !== "string" || typeof args.newText !== "string")
  ) {
    return fail("Provide either newContent, or oldText and newText for a local replacement.");
  }
  const description = typeof args.description === "string" && args.description.trim()
    ? args.description.trim()
    : `Replace contents of ${args.path}`;
  const target = await vaultFs.ensureWithinVault(ctx.vaultPath, resolveVaultTarget(ctx.vaultPath, args.path));
  const oldContent = await vaultFs.readFile(target);
  let nextContent = args.newContent;
  if (nextContent === undefined) {
    const oldText = args.oldText as string;
    const first = oldContent.indexOf(oldText);
    if (first < 0) return fail("oldText was not found in the note.");
    if (oldContent.indexOf(oldText, first + oldText.length) >= 0) {
      return fail("oldText appears more than once. Provide a larger unique oldText snippet.");
    }
    nextContent = oldContent.slice(0, first) + (args.newText as string) + oldContent.slice(first + oldText.length);
  }
  const approved = await ctx.requestProposal({
    kind: "edit_note",
    payload: {
      notePath: args.path,
      description,
      oldContent: truncate(oldContent, 6_000),
      newContent: truncate(nextContent, 6_000),
    },
  });
  if (!approved) return fail("The user rejected this edit. Do not retry it as-is.");
  await vaultFs.writeFile(target, nextContent);
  const verified = await vaultFs.readFile(target);
  if (verified !== nextContent) {
    return fail(`Write verification failed for ${args.path}.`);
  }
  notifyFileChanged(target);
  return ok({
    message: `Wrote and verified ${nextContent.length} chars.`,
    path: args.path,
    verified: true,
  });
}

async function runAskUser(
  args: { question?: unknown; options?: unknown; context?: unknown },
  ctx: AgentToolContext,
): Promise<ToolOutcome> {
  const question = typeof args.question === "string" ? args.question.trim() : "";
  if (!question) return fail("question must be a non-empty string.");
  if (ctx.run.questionsAsked >= MAX_QUESTIONS_PER_RUN) {
    return fail(
      `You have already asked ${MAX_QUESTIONS_PER_RUN} questions in this run. ` +
        "Pick the most defensible interpretation, state it explicitly as an assumption in your answer, and finish.",
    );
  }
  ctx.run.questionsAsked++;

  const options = stringList(args.options).slice(0, 6);
  const context = typeof args.context === "string" ? args.context.trim() : "";
  const outcome = await ctx.requestProposal({
    kind: "question",
    payload: {
      description: context || question,
      question,
      ...(options.length > 0 ? { options } : {}),
    },
  });
  if (typeof outcome === "string" && outcome.trim()) {
    return ok({ question, answer: outcome.trim() });
  }
  return fail(
    "The user did not answer. Choose the most defensible interpretation, state it as an explicit assumption, and continue.",
  );
}

function runCreatePlan(args: { steps?: unknown }, ctx: AgentToolContext): ToolOutcome {
  if (!ctx.plan) return fail("Execution plans are unavailable for this run.");
  if (!Array.isArray(args.steps)) return fail("steps must be an array.");
  return ok(ctx.plan.create(args.steps as CreatePlanStep[]));
}

function runUpdatePlan(
  args: { stepId?: unknown; status?: unknown; evidence?: unknown; runId?: unknown },
  ctx: AgentToolContext,
): ToolOutcome {
  if (!ctx.plan) return fail("Execution plans are unavailable for this run.");
  if (typeof args.stepId !== "string") return fail("stepId must be a string.");
  if (args.status !== "completed" && args.status !== "blocked" && args.status !== "skipped") {
    return fail("status must be completed, blocked, or skipped.");
  }
  return ok(
    ctx.plan.update({
      stepId: args.stepId,
      status: args.status,
      ...(typeof args.evidence === "string" ? { evidence: args.evidence } : {}),
      ...(typeof args.runId === "string" ? { runId: args.runId } : {}),
    }),
  );
}

function runGetPlan(ctx: AgentToolContext): ToolOutcome {
  if (!ctx.plan) return fail("Execution plans are unavailable for this run.");
  const snapshot = ctx.plan.get();
  return snapshot ? ok(snapshot) : ok({ plan: null, instruction: ctx.plan.formatForContext() });
}

/** 把模型返回的 JSON 字符串参数安全 parse 成对象；失败时返回 `{}` 让工具自己报参数缺失。 */
function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 工具异常不该崩循环——统一在这里捕获并转成 role:tool 的 error 文本，回喂模型自愈。 */
export async function dispatchTool(
  name: string,
  rawArguments: string,
  ctx: AgentToolContext,
): Promise<ToolOutcome> {
  const args = parseArgs(rawArguments);
  try {
    switch (name as AgentToolName) {
      case "list_databases":
        return await runListDatabases(ctx);
      case "list_tables":
        return await runListTables(args, ctx);
      case "search_tables":
        return await runSearchTables(args, ctx);
      case "get_table_schema":
        return await runGetTableSchema(args, ctx);
      case "run_sql":
        return await runSql(args, ctx);
      case "search_vault":
        return await runSearchVault(args, ctx);
      case "search_sql_usage":
        return await runSearchSqlUsage(args, ctx);
      case "list_vault_files":
        return await runListVaultFiles(args, ctx);
      case "read_note":
        return await runReadNote(args, ctx);
      case "create_plan":
        return runCreatePlan(args, ctx);
      case "update_plan":
        return runUpdatePlan(args, ctx);
      case "get_plan":
        return runGetPlan(ctx);
      case "load_skill":
        return runLoadSkill(args, ctx);
      case "search_skills":
        return runSearchSkills(args, ctx);
      case "save_skill":
        return await runSaveSkill(args, ctx);
      case "propose_edit":
        return await runProposeEdit(args, ctx);
      case "ask_user":
        return await runAskUser(args, ctx);
      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
