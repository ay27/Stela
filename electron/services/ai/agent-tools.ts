/**
 * Agent 工具集：JSON Schema 定义 + dispatch 到现有 service 函数。
 *
 * 工具体本身几乎零新逻辑——真正的能力都来自已有 service（connector registry /
 * schema-context / search / vault-fs）。这里只做：参数校验、护栏接线（SQL
 * 只读放行/改动确认、编辑走 propose）、结果截断防止撑爆上下文。
 */

import { AppError } from "@shared/errors";
import type {
  AgentToolName,
  AiSettings,
  ConnectionEntry,
  ConnectorKindMeta,
  QueryResult,
} from "@shared/types";

import * as search from "../search";
import * as vaultFs from "../vault-fs";
import type { AgentToolDef } from "./provider";
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

const RESULT_CHAR_BUDGET = 8_000;

function truncate(text: string): string {
  return text.length <= RESULT_CHAR_BUDGET
    ? text
    : `${text.slice(0, RESULT_CHAR_BUDGET)}\n...[truncated ${text.length - RESULT_CHAR_BUDGET} chars]`;
}

function ok(value: unknown): ToolOutcome {
  return { ok: true, text: truncate(typeof value === "string" ? value : JSON.stringify(value, null, 2)) };
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
  payload: { notePath?: string; sql?: string; description: string };
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

export const AGENT_TOOL_DEFS: AgentToolDef[] = [
  {
    type: "function",
    function: {
      name: "list_databases",
      description: "List databases/schemas visible through the current data connection.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_tables",
      description: "List tables in a database through the current data connection.",
      parameters: {
        type: "object",
        properties: {
          database: { type: "string", description: "Database name; omit to use the connector default." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_tables",
      description:
        "Fuzzy-search for candidate tables by keywords (business terms, partial table names). Use this when you don't know the exact table name yet — it scores table names, columns, and documented DDL for matches.",
      parameters: {
        type: "object",
        properties: {
          keywords: {
            type: "array",
            items: { type: "string" },
            description: "Keywords to match against table/column names and DDL, e.g. [\"quarter\", \"revenue\", \"order\"].",
          },
        },
        required: ["keywords"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_table_schema",
      description: "Fetch column names/types and DDL (if available) for one or more tables.",
      parameters: {
        type: "object",
        properties: {
          tables: {
            type: "array",
            items: { type: "string" },
            description: "Table names, optionally qualified as db.table.",
          },
        },
        required: ["tables"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_sql",
      description:
        "Run a SQL statement through the current data connection. Read-only statements (SELECT/WITH/SHOW/DESCRIBE/EXPLAIN) run immediately; a row limit is enforced automatically. Mutating statements (INSERT/UPDATE/DELETE/DDL/...) are blocked unless the user has enabled mutations, and always require explicit approval.",
      parameters: {
        type: "object",
        properties: { sql: { type: "string" } },
        required: ["sql"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_vault",
      description: "Full-text search across the vault's Markdown notes.",
      parameters: {
        type: "object",
        properties: { keyword: { type: "string" } },
        required: ["keyword"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_note",
      description: "Read the full Markdown content of a note by vault-relative or absolute path.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_edit",
      description:
        "Propose replacing a note's full content. This never writes to disk directly — it shows the user a diff and waits for approval.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          newContent: { type: "string" },
          description: { type: "string", description: "One-line summary of what changed, shown to the user." },
        },
        required: ["path", "newContent"],
      },
    },
  },
];

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

async function runSearchTables(args: { keywords?: string[] }, ctx: AgentToolContext): Promise<ToolOutcome> {
  const connection = requireConnection(ctx);
  const keywords = (args.keywords ?? []).filter((k) => typeof k === "string" && k.trim().length > 0);
  if (keywords.length === 0) return fail("keywords must be a non-empty array of strings.");
  const targets = await searchTables({
    connectionName: ctx.connectionName!,
    connection,
    keywords,
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

async function runGetTableSchema(args: { tables?: string[] }, ctx: AgentToolContext): Promise<ToolOutcome> {
  const connection = requireConnection(ctx);
  const tables = (args.tables ?? []).filter((t) => typeof t === "string" && t.trim().length > 0);
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

async function runSearchVault(args: { keyword?: string }, ctx: AgentToolContext): Promise<ToolOutcome> {
  if (!args.keyword) return fail("keyword must be a non-empty string.");
  const hits = await search.searchVault(ctx.vaultPath, args.keyword, { maxHits: 50 });
  if (hits.length === 0) return fail(`No matches for "${args.keyword}".`);
  return ok(hits);
}

async function runReadNote(args: { path?: string }, ctx: AgentToolContext): Promise<ToolOutcome> {
  if (!args.path) return fail("path must be a non-empty string.");
  const target = await vaultFs.ensureWithinVault(ctx.vaultPath, args.path);
  const content = await vaultFs.readFile(target);
  return ok(content);
}

async function runProposeEdit(
  args: { path?: string; newContent?: string; description?: string },
  ctx: AgentToolContext,
): Promise<ToolOutcome> {
  if (!args.path || args.newContent === undefined) {
    return fail("path and newContent are required.");
  }
  const description = args.description?.trim() || `Replace contents of ${args.path}`;
  const approved = await ctx.requestProposal({
    kind: "edit_note",
    payload: { notePath: args.path, description },
  });
  if (!approved) return fail("The user rejected this edit. Do not retry it as-is.");
  const target = await vaultFs.ensureWithinVault(ctx.vaultPath, args.path);
  await vaultFs.writeFile(target, args.newContent);
  return ok(`Wrote ${args.newContent.length} chars to ${args.path}.`);
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
