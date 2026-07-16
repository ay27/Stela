/**
 * Agent 工具集：JSON Schema 定义 + dispatch 到现有 service 函数。
 *
 * 工具体本身几乎零新逻辑——真正的能力都来自已有 service（connector registry /
 * schema-context / search / vault-fs）。这里只做：参数校验、护栏接线（SQL
 * 只读放行/改动确认、编辑走 propose）、结果截断防止撑爆上下文。
 */

import path from "node:path";

import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import { AppError } from "@shared/errors";
import type {
  AgentToolName,
  AgentProposalPayload,
  AiSettings,
  ConnectionEntry,
  ConnectorKindMeta,
  QueryResult,
  SearchHit,
} from "@shared/types";

import * as search from "../search";
import * as vaultFs from "../vault-fs";
import { notifyFileChanged } from "../vault-watcher";
import { resolveNamedTableSchemas, searchTables } from "./schema-context";
import { classifySql } from "./sql-guard";

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
  kind: "edit_note" | "mutation_sql";
  payload: AgentProposalPayload;
}

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
  requestProposal: (proposal: ProposalRequest) => Promise<boolean>;
}

/**
 * Build sequential pi AgentTool wrappers around {@link dispatchTool}.
 * Proposal gating stays inside dispatch; harness receives thrown errors as isError results.
 */
export function createAgentTools(options: {
  ctx: Omit<AgentToolContext, "requestProposal">;
  requestProposal: (toolCallId: string, proposal: ProposalRequest) => Promise<boolean>;
}): AgentTool[] {
  const { ctx, requestProposal } = options;
  return [
    {
      name: "list_databases",
      label: "List databases",
      description: "List databases/schemas visible through the current data connection.",
      parameters: Type.Object({}),
      executionMode: "sequential",
      execute: (toolCallId) => runTool("list_databases", toolCallId, {}, ctx, requestProposal),
    },
    {
      name: "list_tables",
      label: "List tables",
      description: "List tables in a database through the current data connection.",
      parameters: Type.Object({
        database: Type.Optional(Type.String({ description: "Database name; omit to use the connector default." })),
      }),
      executionMode: "sequential",
      execute: (toolCallId, params) => runTool("list_tables", toolCallId, params, ctx, requestProposal),
    },
    {
      name: "search_tables",
      label: "Search tables",
      description:
        "Fuzzy-search for candidate tables by keywords (business terms, partial table names). Use this when you don't know the exact table name yet — it scores table names, columns, and documented DDL for matches.",
      parameters: Type.Object({
        keywords: Type.Array(Type.String(), {
          description: 'Keywords to match against table/column names and DDL, e.g. ["quarter", "revenue", "order"].',
        }),
        limit: Type.Optional(Type.Number({ description: "Optional max candidate tables to return. Defaults to 10." })),
      }),
      executionMode: "sequential",
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
      executionMode: "sequential",
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
      executionMode: "sequential",
      execute: (toolCallId, params) => runTool("run_sql", toolCallId, params, ctx, requestProposal),
    },
    {
      name: "search_vault",
      label: "Search vault",
      description:
        "Full-text search across the vault's Markdown notes. Accepts one keyword or several keywords; several keywords are searched independently and merged.",
      parameters: Type.Object({
        keyword: Type.Optional(Type.String({ description: "Single keyword for compatibility." })),
        keywords: Type.Optional(
          Type.Array(Type.String(), {
            description: "Preferred: several business terms or identifiers to search independently.",
          }),
        ),
        maxHits: Type.Optional(Type.Number({ description: "Max total hits to return. Defaults to 100." })),
      }),
      executionMode: "sequential",
      execute: (toolCallId, params) => runTool("search_vault", toolCallId, params, ctx, requestProposal),
    },
    {
      name: "list_vault_files",
      label: "List vault files",
      description:
        "List Markdown files in the vault by relative path. Use this before read_note when you need to discover likely notes/files.",
      parameters: Type.Object({
        maxFiles: Type.Optional(Type.Number({ description: "Max files to return. Defaults to 200." })),
      }),
      executionMode: "sequential",
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
      executionMode: "sequential",
      execute: (toolCallId, params) => runTool("read_note", toolCallId, params, ctx, requestProposal),
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
  ];
}

async function runTool(
  name: string,
  toolCallId: string,
  params: unknown,
  baseCtx: Omit<AgentToolContext, "requestProposal">,
  requestProposal: (toolCallId: string, proposal: ProposalRequest) => Promise<boolean>,
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
  return ok(
    targets.map((t) => ({
      database: t.database,
      table: t.table,
      matchReason: t.matchReason,
      score: t.score,
      columns: t.columns?.slice(0, 30),
    })),
  );
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
  const result = await ctx.connector.execute(connection.kind, connection.config, sql);
  return ok(formatQueryResult(result));
}

async function runSearchVault(args: { keyword?: unknown; keywords?: unknown; maxHits?: unknown }, ctx: AgentToolContext): Promise<ToolOutcome> {
  const keywords = [
    ...(typeof args.keyword === "string" ? [args.keyword] : []),
    ...stringList(args.keywords),
  ].map((keyword) => keyword.trim()).filter(Boolean);
  const uniqueKeywords = Array.from(new Set(keywords));
  if (uniqueKeywords.length === 0) return fail("keyword or keywords must contain at least one non-empty string.");
  const maxHits = boundedInt(args.maxHits, 100, 1, 300);
  const perKeyword = Math.max(1, Math.ceil(maxHits / uniqueKeywords.length));
  const merged = new Map<string, SearchHit & { keyword: string }>();
  for (const keyword of uniqueKeywords) {
    const hits = await search.searchVault(ctx.vaultPath, keyword, { maxHits: perKeyword });
    for (const hit of hits) {
      const key = `${hit.path}:${hit.line}:${hit.column}:${keyword}`;
      merged.set(key, { ...hit, path: path.relative(ctx.vaultPath, hit.path), keyword });
      if (merged.size >= maxHits) break;
    }
    if (merged.size >= maxHits) break;
  }
  const hits = Array.from(merged.values());
  if (hits.length === 0) return fail(`No matches for ${uniqueKeywords.map((keyword) => `"${keyword}"`).join(", ")}.`);
  return ok(hits);
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
      case "list_vault_files":
        return await runListVaultFiles(args, ctx);
      case "read_note":
        return await runReadNote(args, ctx);
      case "propose_edit":
        return await runProposeEdit(args, ctx);
      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
