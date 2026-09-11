import { extractSqlSymbols } from "./sql-symbols";
/**
 * Agent 工具集：JSON Schema 定义 + dispatch 到现有 service 函数。
 *
 * 工具体本身几乎零新逻辑——真正的能力都来自已有 service（connector registry /
 * schema-context / search / vault-fs）。这里只做：参数校验、护栏接线（SQL
 * 只读放行/改动确认、编辑走 propose）、结果截断防止撑爆上下文。
 */

import path from "node:path";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";

import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { z } from "zod";

import { AppError } from "@shared/errors";
import { parseAnalysisCanvas, type AnalysisCanvas } from "@shared/analysis-canvas";
import { extractSqlFacts } from "@shared/sql-facts";
import {
  asMongoAggregationPipeline,
  containsForbiddenMongoOperator,
} from "@shared/mongodb-query";
import {
  stelaChartSpecSchema,
  stringifyStelaChartSpec,
  validateStelaChartData,
} from "@shared/chart-spec";
import type {
  AgentToolName,
  AgentPlanSnapshot,
  AgentProposalKind,
  AgentProposalPayload,
  AiSchemaColumnContext,
  AiSettings,
  ColumnDef,
  ConnectionEntry,
  ConnectionMap,
  ConnectorKindMeta,
  DataQueryRequest,
  MaterializedQueryResult,
  PythonExecutionResult,
  QueryArtifactDescriptor,
  QueryArtifactRequest,
  QueryResult,
  RunRecord,
  SqlIndexFilter,
  SqlIndexHit,
  SqlIndexOperation,
} from "@shared/types";
import type { QueryArtifactTarget } from "../query-artifacts";

import { getLogger } from "../logger";
import * as analysisCanvasService from "../analysis-canvas";
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
  type AgentSkillOrigin,
  type LoadedAgentSkill,
} from "./agent-skills";
import type { AgentSkillFreshness } from "./skill-source-context";
import { DATA_ANALYSIS_TOOLS } from "./analysis-efficiency";

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
  executeUnbounded?(kind: string, config: unknown, sql: string): Promise<QueryResult>;
  executeQuery?(kind: string, config: unknown, query: DataQueryRequest): Promise<QueryResult>;
  materializeQuery?(
    kind: string,
    config: unknown,
    sql: string,
    request: QueryArtifactRequest,
  ): Promise<MaterializedQueryResult | null>;
  materializeDataQuery?(
    kind: string,
    config: unknown,
    query: DataQueryRequest,
    request: QueryArtifactRequest,
  ): Promise<MaterializedQueryResult | null>;
  /**
   * 可选：批量拿带 COMMENT 的列。caller 需要 ignore 它不存在的情形（runtime
   * 注入来自 registry.describeTables）。
   */
  describeTables?(
    kind: string,
    config: unknown,
    tables: Array<{ database: string | null; table: string }>,
  ): Promise<
    Array<{
      database: string | null;
      table: string;
      columns: Array<{ name: string; typeName: string; comment?: string | null }>;
      ddlSnippet: string | null;
    }>
  >;
}

export interface AgentQueryArtifactOps {
  createTarget(
    vaultPath: string,
    sessionId: string,
    runId: string,
    format: "parquet" | "jsonl",
  ): Promise<QueryArtifactTarget>;
  finalize(
    target: QueryArtifactTarget,
    result: MaterializedQueryResult,
    mode: "parquet-stream" | "jsonl-stream",
  ): Promise<QueryArtifactDescriptor>;
  writeBuffered(input: {
    vaultPath: string;
    sessionId: string;
    runId: string;
    columns: ColumnDef[];
    rows: unknown[][];
  }): Promise<QueryArtifactDescriptor | null>;
  resolve(
    vaultPath: string,
    sessionId: string,
    runId: string,
  ): Promise<QueryArtifactDescriptor | null>;
  discard(target: QueryArtifactTarget): Promise<void>;
}

export interface AgentPythonExecutorOps {
  reset?(vaultPath: string, sessionId: string): Promise<void>;
  execute(input: {
    vaultPath: string;
    sessionId: string;
    code: string;
    analysisContext?: import("../../shared/types").IAnalysisExecutionContext;
    runSemantic?: import("../../shared/semantic").SemanticRunner;
    artifacts: Record<string, QueryArtifactDescriptor>;
    /**
     * Serves `await query(connection, request)` from inside the sandbox. The
     * sandbox only ever sends a connection name plus a JSON-encoded
     * DataQueryRequest; resolution, sql-guard, and journaling happen here in the
     * main process.
     */
    runQuery?: (input: {
      connectionName: string;
      request: string;
    }) => Promise<QueryArtifactDescriptor>;
    signal?: AbortSignal;
  }): Promise<PythonExecutionResult>;
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
  queryLanguage?: "sql" | "mongodb";
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
/** DDL 解析护栏，不是展示上限：真实宽表 300+ 列，取整到 4096 只为挡住病态 DDL。 */
const SCHEMA_COLUMN_HARD_LIMIT = 4_096;
/** 给 get_table_schema 的列/DDL 用的预算，留出信封字段和 instruction 的余量。 */
const SCHEMA_RESULT_BUDGET = RESULT_CHAR_BUDGET - 2_000;
const SQL_PREVIEW_ROWS = 200;
const SQL_PREVIEW_MAX_BYTES = 24 * 1024;
const SQL_PREVIEW_CELL_MAX_BYTES = 4 * 1024;
/**
 * What the *model* sees, as opposed to what charts and the journal keep. A
 * truncated preview of 200 countable rows is exactly what makes a model treat a
 * partial result as the whole one, so a truncated result yields a handful of
 * rows under a different key and never a countable table.
 */
const MODEL_PREVIEW_MAX_BYTES = 5 * 1024;
const MODEL_SAMPLE_ROWS = 5;
const QUERY_ARTIFACT_MAX_BYTES = 1024 * 1024 * 1024;
const PYTHON_CODE_MAX_CHARS = 50_000;
const PYTHON_SOURCE_MAX_ITEMS = 8;
const PYTHON_QUERY_MAX_BYTES = 2 * 1024 * 1024 * 1024;
function truncate(text: string, maxChars = RESULT_CHAR_BUDGET): string {
  return text.length <= maxChars
    ? text
    : `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`;
}

function ok(value: unknown, maxChars = RESULT_CHAR_BUDGET, terminate = false): ToolOutcome {
  return { ok: true, text: truncate(typeof value === "string" ? value : JSON.stringify(value, null, 2), maxChars), terminate };
}

function fail(message: string): ToolOutcome {
  return { ok: false, text: message };
}

/**
 * zod 的 `error.message` 是整个 issue 数组的 JSON dump，模型读不动就只会原样重试。
 * 压成 `path: message`，并把判别联合的合法取值补上——那是重试里最常撞的一类。
 */
function describeZodError(error: unknown): string {
  if (!(error instanceof z.ZodError)) return error instanceof Error ? error.message : String(error);
  return error.issues.slice(0, 12).map((issue) => {
    const location = issue.path.join(".") || "(root)";
    const allowed = issue.code === "invalid_union_discriminator"
      ? ` Allowed values: ${issue.options.map((option) => String(option)).join(" | ")}.`
      : "";
    return `${location}: ${issue.message}${allowed}`;
  }).join("; ");
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= Math.max(0, maxBytes - 3)) low = middle;
    else high = middle - 1;
  }
  return `${value.slice(0, low)}…`;
}

function previewCell(value: unknown, maxBytes: number): unknown {
  if (typeof value === "string") return truncateUtf8(value, maxBytes);
  if (!value || typeof value !== "object") return value;
  try {
    const json = JSON.stringify(value);
    return Buffer.byteLength(json, "utf8") <= maxBytes ? value : truncateUtf8(json, maxBytes);
  } catch {
    return truncateUtf8(String(value), maxBytes);
  }
}

function boundedPreview(
  rows: unknown[][],
  rowCount: number,
  inferRowTruncation = true,
  maxRows = SQL_PREVIEW_ROWS,
  maxBytes = SQL_PREVIEW_MAX_BYTES,
): {
  rows: unknown[][];
  truncated: boolean;
  truncatedBy: Array<"rows" | "bytes">;
} {
  const bounded: unknown[][] = [];
  let used = 2;
  let bytesTruncated = false;
  for (const rawRow of rows.slice(0, maxRows)) {
    const remaining = Math.max(1, maxBytes - used);
    const perCell = Math.max(16, Math.min(SQL_PREVIEW_CELL_MAX_BYTES, Math.floor(remaining / Math.max(1, rawRow.length))));
    const row = rawRow.map((cell) => previewCell(cell, perCell));
    if (row.some((cell, index) => !Object.is(cell, rawRow[index]))) bytesTruncated = true;
    const rowBytes = Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
    if (used + rowBytes > maxBytes) {
      bytesTruncated = true;
      break;
    }
    bounded.push(row);
    used += rowBytes;
  }
  if (bounded.length < Math.min(rows.length, maxRows)) bytesTruncated = true;
  const rowTruncated = inferRowTruncation && rowCount > Math.min(rows.length, maxRows);
  return {
    rows: bounded,
    truncated: rowTruncated || bytesTruncated,
    truncatedBy: [...(rowTruncated ? ["rows" as const] : []), ...(bytesTruncated ? ["bytes" as const] : [])],
  };
}

export interface ToolOutcome {
  ok: boolean;
  text: string;
  terminate?: boolean;
}

export interface AgentAnalysisRunEvidence {
  kind: "query" | "python";
  connectionName?: string;
  tables: string[];
  columns: ColumnDef[];
  rowCount: number;
  truncated: boolean;
  incomplete?: boolean;
  sourceRunIds: string[];
  /** Bounded same-run values supplied only to the tool-free result reviewer. */
  summary?: unknown;
}

export interface ProposalRequest {
  kind: AgentProposalKind;
  payload: AgentProposalPayload;
}

export function proposalApprovalMode(
  autoApplyEdits: boolean,
  kind: AgentProposalKind,
): "manual" | "automatic" {
  return autoApplyEdits && (kind === "edit_note" || kind === "runsql_rewrite")
    ? "automatic"
    : "manual";
}

/**
 * 单次 run 的提问上限。硬限在工具侧而不是只写在 prompt 里——prompt 约束是建议，
 * 这里是保证：模型再怎么犹豫也不会把对话变成问答轰炸。
 */
const MAX_QUESTIONS_PER_RUN = 3;

/**
 * Canvas 的结构只存在于 [analysis-canvas.ts](../../shared/analysis-canvas.ts) 的 zod 里，
 * 工具参数只能声明成一个 JSON 字符串，所以 card 判别联合必须在 description 里讲清楚。
 */
const CANVAS_CARD_RULES =
  "Every card needs id and type. type gates the rest: markdown needs markdown; kpi needs sourceId and value; " +
  "chart needs sourceId and chart; table needs sourceId; flow needs nodes and edges. No other keys are accepted per type. " +
  "A chart card's chart.fields is an object keyed by field id, not the array that create_chart takes.";
/**
 * 工具执行上下文，由 [agent.ts](./agent.ts) 每次 run 构造一次。
 * `requestProposal` 把「等用户确认」抽象成一个 Promise：agent 循环负责发
 * proposal 事件、注册 resolver，用户 approve/reject 时 resolve 这个 Promise。
 */
export interface AgentToolContext {
  vaultPath: string;
  connectionName: string | null;
  connection: ConnectionEntry | null;
  connections?: ConnectionMap;
  connectionDialects?: Record<string, string | null>;
  maintenanceDialect?: string | null;
  maintenanceTables?: string[];
  maintenanceSourcePaths?: string[];
  maintenanceRefreshName?: string | null;
  maintenanceRelatedNotes?: { paths: Set<string>; reads: number };
  aiSettings: AiSettings;
  connector: AgentConnectorOps;
  queryArtifacts?: AgentQueryArtifactOps;
  pythonExecutor?: AgentPythonExecutorOps;
  pythonStateful?: boolean;
  analysisContext?: import("../../shared/types").IAnalysisExecutionContext;
  runSemantic?: import("../../shared/semantic").SemanticRunner;
  signal?: AbortSignal;
  sqlIndex: AgentSqlIndexOps;
  skills: LoadedAgentSkill[];
  /** Names owned by bundled read-only System Skills, including in maintenance-only contexts. */
  reservedSkillNames?: readonly string[];
  mode: "normal" | "maintenance" | "refresh";
  explicitSkillMaintenance?: boolean;
  skillEvidence?: { notePaths: Set<string>; tables: Set<string> };
  getSkillFreshness?: (skill: LoadedAgentSkill) => Promise<AgentSkillFreshness>;
  /** 排入后台 Skill 刷新队列，不阻塞当前工具调用。 */
  scheduleSkillRefresh?: (skill: LoadedAgentSkill) => void;
  onSkillMaintenance?: (record: AgentSkillMaintenanceRecord) => void;
  onSkillUsage?: (record: {
    type: "candidate" | "loaded";
    source: "prompt" | "search" | "load";
    origin: AgentSkillOrigin;
    name: string;
    category: string | null;
  }) => void;
  /** 本次 Agent 会话内 run_query 的真实结果，只供 create_chart 校验。 */
  conversationRunIds?: string[];
  chartRuns?: Map<string, { sql: string; columns: ColumnDef[]; rows: unknown[][] }>;
  /** Successful query/Python outputs created in this Agent run and eligible for final evidence. */
  analysisRuns?: Map<string, AgentAnalysisRunEvidence>;
  resolveChartRun?: (runId: string) => Promise<RunRecord | null>;
  /** Dedicated Canvas refresh runs may commit their target exactly once. */
  canvasRefresh?: { path: string; sourceId: string | null; committed: boolean };
  onCanvasUpdated?: (event: { path: string; title: string; action: "created" | "updated" }) => void;
  /**
   * 单次 run 的可变状态：`runId` / `notePath` 用于给执行历史生成
   * `agent:<runId>` 形式的 blockId；`questionsAsked` 由 `ask_user` 自增；
   * `toolFailureStreak` 由 `dispatchTool` 维护，记录每个工具名的连续失败次数。
   */
  run: {
    runId: string;
    sessionId?: string;
    notePath: string | null;
    questionsAsked: number;
    toolFailureStreak: Map<string, number>;
    analysis?: import("../../shared/analysis-contract").IAnalysisSnapshot;
  };
  plan?: ExecutionPlanStore;
  persistPlan?: (snapshot: AgentPlanSnapshot) => Promise<void>;
  /** Renderer-owned rewrite targets explicitly attached to this run. */
  rewriteTargets?: Map<string, { sql: string; sourcePath?: string }>;
  recordRun: AgentRunRecorder;
  requestProposal: (proposal: ProposalRequest) => Promise<boolean | string>;
}

/**
 * Build pi AgentTool wrappers around {@link dispatchTool}.
 *
 * Read-oriented tools use `executionMode: "parallel"` so one assistant turn can
 * fan out schema/vault/SQL lookups. Stateful plan, Canvas, chart, and edit
 * proposals stay sequential. `run_query` is parallel: sql-guard blocks
 * writes by default and mutations still wait on proposal. Pi rule: if any call
 * in a batch is sequential, the whole batch runs sequentially.
 */
export function createAgentTools(options: {
  ctx: Omit<AgentToolContext, "requestProposal">;
  requestProposal: (toolCallId: string, proposal: ProposalRequest) => Promise<boolean | string>;
}): AgentTool[] {
  const { ctx, requestProposal } = options;
  const tools: AgentTool[] = [
    ...(ctx.conversationRunIds ? [{
      name: "read_conversation_result", label: "Read saved result",
      description: "Read a saved SQL result from this conversation without executing SQL again. Saved rows may be capped; do not infer full-data totals from a preview.",
      parameters: Type.Object({ runId: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
      executionMode: "parallel" as const,
      execute: async (_id: string, raw: unknown) => {
        const params = raw as { runId: string; offset?: number; limit?: number };
        const { readConversationResult } = await import("../conversation");
        const result = await readConversationResult(ctx.vaultPath, ctx.conversationRunIds ?? [], params.runId, params.offset ?? 0, Math.min(100, params.limit ?? 50));
        if ((params.offset ?? 0) === 0) ctx.chartRuns?.set(params.runId, { sql: result.run.sql, columns: result.columns, rows: result.rows });
        const preview = boundedPreview(result.rows, result.total, false, 100, MODEL_PREVIEW_MAX_BYTES);
        ctx.analysisRuns?.set(params.runId, { kind: "query", connectionName: result.run.connectionName,
          tables: extractSqlSymbols(result.run.sql).tables, columns: result.columns, rowCount: result.total,
          truncated: true, incomplete: true, sourceRunIds: [],
          summary: { columns: result.columns, rowCount: result.total, rows: preview.rows, previewTruncated: true, previewTruncatedBy: ["saved-rows"] } });
        return { content: [{ type: "text" as const, text: JSON.stringify({ ...result, rows: preview.rows, pageTruncated: preview.truncated }) }], details: {} };
      },
    }] : []),
    {
      name: "list_catalog",
      label: "List catalog",
      description: "List databases or tables through a Stela connection.",
      parameters: Type.Object({
        level: Type.String({ enum: ["databases", "tables"] }),
        database: Type.Optional(Type.String({ description: "Database for level=tables; a sole database is selected automatically." })),
        connectionName: Type.Optional(Type.String({ description: "Connection; defaults to current." })),
      }),
      executionMode: "parallel",
      execute: (toolCallId, params) => runTool("list_catalog", toolCallId, params, ctx, requestProposal),
    },
    {
      name: "search_tables",
      label: "Search tables",
      description:
        "Find candidate tables when the exact table is unknown. It ranks table, column, and DDL-comment matches and reports Vault usage as supporting evidence, not proof.",
      parameters: Type.Object({
        keywords: Type.Array(Type.String(), {
          description: 'Keywords to match against table/column names and DDL, e.g. ["quarter", "revenue", "order"].',
        }),
        limit: Type.Optional(Type.Number({ description: "Optional max candidate tables to return. Defaults to 10." })),
        connectionName: Type.Optional(Type.String({ description: "Available Stela connection name; defaults to current." })),
      }),
      executionMode: "parallel",
      execute: (toolCallId, params) => runTool("search_tables", toolCallId, params, ctx, requestProposal),
    },
    {
      name: "get_table_schema",
      label: "Get table schema",
      description:
        "Fetch authoritative live columns and types. Optionally inspect selected column comments or non-column DDL clauses.",
      parameters: Type.Object({
        tables: Type.Array(Type.String(), {
          description: "Table names, optionally qualified as db.table.",
        }),
        columnNames: Type.Optional(Type.Array(Type.String(), {
          description: "Return these columns with comments and report missing names.",
        })),
        columnOffset: Type.Optional(Type.Number({
          description: "Resume at a previous nextColumnOffset.",
        })),
        includeDdl: Type.Optional(Type.Boolean({
          description: "Include truncated DDL for engine, partition, distribution, or key clauses.",
        })),
        connectionName: Type.Optional(Type.String({ description: "Available Stela connection name; defaults to current." })),
      }),
      executionMode: "parallel",
      execute: (toolCallId, params) => runTool("get_table_schema", toolCallId, params, ctx, requestProposal),
    },
    {
      name: "run_query",
      label: "Run query",
      description:
        "Run one SQL or MongoDB query. Results may be a bounded preview; aggregate in the query for exact results or use execute_python for complete rows. Writes require approval.",
      // Function providers require the top-level schema to be type=object.
      // SQL/Mongo field requirements are discriminated again in runQuery.
      parameters: Type.Object({
        language: Type.String({ enum: ["sql", "mongodb"] }),
        query: Type.Optional(Type.String({ description: "Required for SQL: one SQL statement." })),
        collection: Type.Optional(Type.String({ description: "Required for MongoDB: collection name." })),
        database: Type.Optional(Type.String({
          description: "Logical database. Required when the connection exposes more than one database.",
        })),
        operation: Type.Optional(Type.String({ enum: ["find", "aggregate"] })),
        filter: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "MongoDB find filter." })),
        projection: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])),
        pipeline: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()), {
          description: "MongoDB aggregation stages. Required when operation=aggregate.",
        })),
        limit: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
        connectionName: Type.Optional(Type.String({ description: "Available Stela connection name; defaults to current." })),
      }),
      executionMode: "parallel",
      execute: (toolCallId, params) => runTool("run_query", toolCallId, params, ctx, requestProposal),
    },
    {
      name: "execute_python",
      label: "Execute Python",
      description:
        (ctx.pythonStateful === false
          ? "Run fresh stateless Python: redeclare sources and variables every call. Use to_df(alias), pandas, duckdb; await query for dynamic reads. Assign result."
          : "Python workspace: omitted sources reuse; redeclaring refreshes aliases, not DataFrames. Aliases are not variables: to_df('t') gives pandas, tables['t'] a DuckDB relation. result is cleared before EVERY cell; retain other variables, assign result for output. await query for dynamic reads; reset clears state.") +
        (ctx.runSemantic
          ? " Batch classification/extraction/entity matching: await semantic.classify/extract/resolve inside Python. First load_skill name=semantic-analysis. No database needed; host authorizes and budgets calls. Retain batches for resume."
          : "") + " For material scope/grain/denominator risks, load_skill name=analysis-verification: analysis.contract retains sourced claims/checks. Skip trivial arithmetic." +
        (ctx.aiSettings.automaticAnalysisContractsEnabled ? " Automatic evidence is enabled: analysis.current exists without setup; use .claim(field, meaning, source='question' or existing alias/run ID, evidence=exact quote), .bind_population(df, id_column='id', source='alias', source_id_column='original_id'). Omit source_id_column when the ID column is unchanged. Bind source input columns, not derived result labels. After late binding use .observe(batch) to verify prior execution without new inference; inspect coverage.reason and operationCoverage. No implicit ID normalization or union of batches. Explicit analysis.contract(required=[...]) starts a revision; sources/checks do not certify business truth. Snapshots are automatic, no final gate." : "") +
        (ctx.aiSettings.semanticOptimizationEnabled ? " Exact selected-content deduplication and all-input cost preflight are enabled for classify/extract. Prefer SQL/rules first; unmatched text is unresolved, not negative. One bounded pilot may consume existing budget. Inspect summary.preflight, pilot, forecastTokens and stopReason; partial work never permits extrapolation." : ""),
      parameters: Type.Object({
        reset: Type.Optional(Type.Boolean()),
        sources: Type.Optional(Type.Array(Type.Union([
          Type.Object({
            alias: Type.String(),
            language: Type.Literal("sql"),
            query: Type.String(),
            database: Type.Optional(Type.String()),
            connectionName: Type.Optional(Type.String()),
          }, { additionalProperties: false }),
          Type.Object({
            alias: Type.String(),
            language: Type.Literal("mongodb"),
            collection: Type.String(),
            database: Type.Optional(Type.String()),
            operation: Type.Optional(Type.String({ enum: ["find", "aggregate"] })),
            filter: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
            projection: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])),
            pipeline: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()))),
            limit: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
            connectionName: Type.Optional(Type.String()),
          }, { additionalProperties: false }),
        ]), {
          maxItems: PYTHON_SOURCE_MAX_ITEMS,
        })),
        code: Type.String({
          maxLength: PYTHON_CODE_MAX_CHARS,
        }),
      }),
      executionMode: "sequential",
      execute: (toolCallId, params) => runTool("execute_python", toolCallId, params, ctx, requestProposal),
    },
    {
      name: "create_chart",
      label: "Create chart",
      description:
        "Create a chart from a successful SQL run_query. Before the first chart in a run, call load_skill with name=chart-authoring. Declare result columns as fields and reference their ids from layers.",
      parameters: Type.Object({
        runId: Type.String({ description: "Exact runId returned by a SQL run_query in this Agent run." }),
        title: Type.Optional(Type.String()),
        description: Type.Optional(Type.String()),
        preset: Type.String({ enum: ["trend", "ranking", "composition", "distribution", "correlation", "funnel", "retention", "comparison", "custom"] }),
        fields: Type.Array(Type.Object({
          id: Type.String({ description: "Stable short id referenced by layer encodings. Must match ^[A-Za-z_][A-Za-z0-9_-]{0,127}$." }),
          field: Type.String({ description: "Exact result column name." }),
          type: Type.String({ enum: ["nominal", "ordinal", "quantitative", "temporal", "boolean"] }),
          title: Type.Optional(Type.String()),
          temporalInput: Type.Optional(Type.String({ enum: ["iso", "epoch-ms", "epoch-seconds"] })),
          format: Type.Optional(Type.Object({
            kind: Type.String({ enum: ["auto", "text", "number", "compact", "percent", "currency", "date", "datetime", "duration", "boolean"] }),
            input: Type.Optional(Type.String()),
            currency: Type.Optional(Type.String()),
            style: Type.Optional(Type.String()),
            timeZone: Type.Optional(Type.String()),
            minimumFractionDigits: Type.Optional(Type.Number()),
            maximumFractionDigits: Type.Optional(Type.Number()),
            trueLabel: Type.Optional(Type.String()),
            falseLabel: Type.Optional(Type.String()),
            nullLabel: Type.Optional(Type.String()),
          }, { additionalProperties: false })),
        }, { additionalProperties: false }), { minItems: 1, maxItems: 32 }),
        layers: Type.Array(Type.Object({
          mark: Type.String({ enum: ["bar", "line", "area", "point", "arc", "rect", "rule", "histogram", "boxplot", "funnel"] }),
          encoding: Type.Object({
            x: Type.Optional(Type.String()), y: Type.Optional(Type.String()), color: Type.Optional(Type.String()),
            size: Type.Optional(Type.String()), theta: Type.Optional(Type.String()),
          }, {
            additionalProperties: false,
            description: "Only these five channels exist. Every value must be a field id declared in fields, never a column name, label, or nested object.",
          }),
          yAxis: Type.Optional(Type.String({ enum: ["left", "right"] })),
          stack: Type.Optional(Type.String({ enum: ["none", "normal", "percent"] })),
          bins: Type.Optional(Type.Number()),
        }, { additionalProperties: false }), { minItems: 1, maxItems: 2 }),
      }),
      executionMode: "sequential",
      execute: (toolCallId, params) => runTool("create_chart", toolCallId, params, ctx, requestProposal),
    },
    {
      name: "create_analysis_canvas",
      label: "Create analysis Canvas",
      description:
        "Create a structured .stela.canvas artifact for an explicitly requested Canvas/report/dashboard or a genuinely multi-view analysis. Simple answers stay in chat.",
      parameters: Type.Object({
        title: Type.String(),
        directory: Type.Optional(Type.String({ description: "Vault-relative directory. Defaults to the current note directory or vault root." })),
      }),
      executionMode: "sequential",
      execute: (toolCallId, params) => runTool("create_analysis_canvas", toolCallId, params, ctx, requestProposal),
    },
    {
      name: "read_analysis_canvas", label: "Read analysis Canvas",
      description: "Read and validate an existing .stela.canvas file before updating it.",
      parameters: Type.Object({ path: Type.String() }), executionMode: "parallel",
      execute: (toolCallId, params) => runTool("read_analysis_canvas", toolCallId, params, ctx, requestProposal),
    },
    {
      name: "update_analysis_canvas", label: "Update analysis Canvas",
      description: "Replace a Canvas with validated complete JSON. Keep existing semantic ids, bind each new or changed SQL source through sourceRuns, and omit Flow positions; Stela audits runs and preserves user-owned layout. Canvas refresh runs permit one final atomic update.",
      parameters: Type.Object({
        path: Type.String(), etag: Type.String(), content: Type.String({ description: `Complete version 1 .stela.canvas JSON. ${CANVAS_CARD_RULES}` }),
        sourceRuns: Type.Array(Type.Object({
          sourceId: Type.String({ description: "Canvas source id being created, changed, or refreshed." }),
          runId: Type.String({ description: "Successful SQL run_query id from this Agent run." }),
        })),
      }), executionMode: "sequential",
      execute: (toolCallId, params) => runTool("update_analysis_canvas", toolCallId, params, ctx, requestProposal),
    },
    {
      name: "search_vault",
      label: "Search vault",
      description:
        "Search Vault Markdown and return ranked notes with totalMatches/truncated. Pass related keywords together for one ranked search.",
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
        "Find exact table usage in the Vault SQL AST index when established joins, filters, write direction, or business conventions matter. Use table for either direction and readTable/writeTable only when direction matters.",
      parameters: Type.Object({
        table: Type.Optional(
          Type.String({ description: "Table used by the SQL in either a read or write role, as table or db.table." }),
        ),
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
      name: "plan",
      label: "Manage execution plan",
      description:
        "Create, update, or recover a progress plan for complex analyses. Skip routine lookups; plans never gate answers.",
      parameters: Type.Object({
        action: Type.String({ enum: ["create", "update", "get"] }),
        steps: Type.Optional(Type.Array(
          Type.Object({
            id: Type.String(),
            title: Type.String(),
            intent: Type.String(),
            acceptance: Type.String(),
          }),
        )),
        stepId: Type.Optional(Type.String()),
        status: Type.Optional(Type.String({ enum: ["completed", "blocked", "skipped"] })),
        evidence: Type.Optional(Type.String()),
        runId: Type.Optional(Type.String()),
      }),
      executionMode: "sequential",
      execute: (toolCallId, params) => runTool("plan", toolCallId, params, ctx, requestProposal),
    },
    {
      name: "load_skill",
      label: "Load Skill",
      description: "Load one exact Skill. System Skills are read-only Stela guidance; Vault Skills include freshness and verification status.",
      parameters: Type.Object({ name: Type.String({ description: "Exact Skill name from search_skills or the available Skills list." }) }),
      executionMode: "parallel",
      execute: (toolCallId, params) => runTool("load_skill", toolCallId, params, ctx, requestProposal),
    },
    {
      name: "search_skills",
      label: "Search Skills",
      description:
        "Browse or search reusable business, metric, lineage, or SQL-dialect metadata with freshness. Omit query to page by name; provide query for ranked matches. Routine calls omit stale rows; explicit knowledge maintenance includes them for repair.",
      parameters: Type.Object({
        query: Type.Optional(Type.String({ description: "Optional keywords. Omit to browse all active Skill metadata by name." })),
        offset: Type.Optional(Type.Number({ description: "Zero-based metadata offset. Defaults to 0." })),
        limit: Type.Optional(Type.Number({ description: "Page size. Search defaults to 8 (max 20); browse defaults to 20 (max 50)." })),
      }),
      executionMode: "parallel",
      execute: (toolCallId, params) => runTool("search_skills", toolCallId, params, ctx, requestProposal),
    },
    {
      name: "save_skill",
      label: "Save Skill",
      description:
        "Save one compact verified data-knowledge Skill or archive an obsolete one when explicitly requested. Never store result rows, snapshots, one-off SQL, or user notes.",
      parameters: Type.Object({
        action: Type.Optional(Type.String({ enum: ["save", "archive"] })),
        name: Type.String({ description: "Required lowercase Skill directory name, e.g. postgresql-demo-tasks." }),
        content: Type.Optional(
          Type.String({
            description:
              `Required for save: short SKILL.md with reusable scope, rule, and minimal verification. ${AGENT_SKILL_LIMITS_PROMPT} Example: ---\\nname: postgresql-demo-tasks\\ndescription: Reusable PostgreSQL demo_tasks business definitions.\\ncategory: business-glossary\\ntags: [postgresql, demo-tasks]\\n---\\n\\n# Task ownership\\n- Rule: owner is the responsible team.\\n- Verify: check demo_tasks.owner.`,
          }),
        ),
        reason: Type.String({ description: "Required short factual reason for saving or archiving." }),
        sourcePaths: Type.Optional(Type.Array(Type.String(), {
          description: "For explicit knowledge maintenance, up to three supporting Vault note paths actually read in this turn.",
          maxItems: 3,
        })),
        sourceTables: Type.Optional(Type.Array(Type.String(), {
          description: "For explicit knowledge maintenance, up to eight supporting tables actually inspected in this turn.",
          maxItems: 8,
        })),
      }),
      executionMode: "sequential",
      execute: (toolCallId, params) => runTool("save_skill", toolCallId, params, ctx, requestProposal),
    },
    {
      name: "propose_edit",
      label: "Propose edit",
      description:
        "Propose one RunSQL or note edit. Use targetId/sql for an attached RunSQL target, or path plus note replacement fields; never mix the two forms. Preserve trailing <detail> blocks unless explicitly asked.",
      parameters: Type.Object({
        targetId: Type.Optional(
          Type.String({ description: "Exact rewrite target id from the attached RunSQL block." }),
        ),
        sql: Type.Optional(
          Type.String({ description: "Complete replacement SQL for targetId, without Markdown fences." }),
        ),
        path: Type.Optional(Type.String({ description: "Vault note path for a note edit." })),
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
        `Ask one short material question after available evidence and cheap discriminating checks cannot resolve the answer. At most ${MAX_QUESTIONS_PER_RUN} questions per run.`,
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
  if (ctx.mode === "maintenance" || ctx.mode === "refresh") {
    return tools.filter((tool) => tool.name === "save_skill");
  }
  return tools.filter((tool) =>
    tool.name !== "execute_python" || Boolean(ctx.queryArtifacts && ctx.pythonExecutor),
  );
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
    details: {},
    ...(outcome.terminate ? { terminate: true } : {}),
  };
}

function resolveDialect(kind: string, ctx: AgentToolContext): string {
  return ctx.connector.listKinds().find((meta) => meta.kind === kind)?.dialect ?? kind;
}

function requireNamedConnection(
  ctx: AgentToolContext,
  requested?: unknown,
): { name: string; connection: ConnectionEntry } {
  const requestedName = typeof requested === "string" ? requested.trim() : "";
  const name = requestedName || ctx.connectionName || "";
  const connection = (name && ctx.connections?.[name]) ||
    (name === ctx.connectionName ? ctx.connection : null);
  if (!name || !connection) {
    throw new AppError(
      "no_connection",
      requestedName
        ? `Unknown data connection '${requestedName}'. Use one of the available connection names from the turn context.`
        : "No data connection is configured for the current note. Ask the user to set `connection_name` in frontmatter, or pass an available connectionName.",
    );
  }
  return { name, connection };
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

function recordSkillTableEvidence(ctx: AgentToolContext, tables: string[]): void {
  if (!ctx.explicitSkillMaintenance || !ctx.skillEvidence) return;
  for (const table of tables) {
    const normalized = table.trim().toLowerCase();
    if (/^[a-z0-9_]+(?:\.[a-z0-9_]+)?$/.test(normalized)) {
      ctx.skillEvidence.tables.add(normalized);
    }
  }
}

function vaultRelativePath(vaultPath: string, target: string): string {
  return path.relative(vaultPath, target).split(path.sep).join("/");
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

async function runListDatabases(
  args: { connectionName?: unknown },
  ctx: AgentToolContext,
): Promise<ToolOutcome> {
  const { name, connection } = requireNamedConnection(ctx, args.connectionName);
  const dbs = await ctx.connector.listDatabases(connection.kind, connection.config);
  return ok({ connectionName: name, databases: dbs });
}

async function runListTables(
  args: { database?: string; connectionName?: unknown },
  ctx: AgentToolContext,
): Promise<ToolOutcome> {
  const { name, connection } = requireNamedConnection(ctx, args.connectionName);
  let database = typeof args.database === "string" && args.database.trim() ? args.database.trim() : null;
  if (!database) {
    const databases = await ctx.connector.listDatabases(connection.kind, connection.config);
    if (databases.length === 1) database = databases[0] ?? null;
    else if (databases.length > 1) {
      return ok({
        accepted: false,
        reason: "database_required",
        connectionName: name,
        databases,
        instruction: "Call list_catalog again with level=tables and one exact database from this list.",
      });
    }
  }
  const tables = await ctx.connector.listTables(connection.kind, connection.config, database);
  return ok({ connectionName: name, database, tables });
}

async function runListCatalog(
  args: { level?: unknown; database?: string; connectionName?: unknown },
  ctx: AgentToolContext,
): Promise<ToolOutcome> {
  if (args.level === "databases") return await runListDatabases(args, ctx);
  if (args.level === "tables") return await runListTables(args, ctx);
  return fail("level must be databases or tables.");
}

async function runSearchTables(args: { keywords?: unknown; limit?: unknown; connectionName?: unknown }, ctx: AgentToolContext): Promise<ToolOutcome> {
  const { name, connection } = requireNamedConnection(ctx, args.connectionName);
  const keywords = stringList(args.keywords);
  if (keywords.length === 0) return fail("keywords must be a non-empty array of strings.");
  const limit = boundedInt(args.limit, 10, 1, 20);
  const targets = await searchTables({
    connectionName: name,
    connection,
    keywords,
    limit,
    preferLocalSchemaDir: false,
    deps: {
      listDatabases: ctx.connector.listDatabases,
      listTables: ctx.connector.listTables,
      execute: ctx.connector.execute,
      describeTables: ctx.connector.describeTables,
    },
  });
  if (targets.length === 0) {
    return fail("No matching tables found. Try list_catalog, or broaden the keywords.");
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

/**
 * 一条 `name:type` 行约 34 字符，`-- comment` 再翻倍到约 60。一张 329 列的宽表
 * 因此是 11K / 20K —— 注释和全列覆盖对宽表是二选一，不可能都要。
 */
function formatSchemaColumn(column: AiSchemaColumnContext, withComment: boolean): string {
  const typeName = column.typeName?.trim();
  const comment = withComment ? column.comment?.replace(/\s+/g, " ").trim() : undefined;
  return `${column.name}${typeName ? `:${typeName}` : ""}${comment ? ` -- ${comment}` : ""}`;
}

/**
 * 列清单是一个换行拼接的字符串，不是 JSON 数组：pretty-print 会给每列加 8 空格
 * 缩进 + 引号 + 逗号，12 字符的纯格式税，两张 329 列的表光这一项就 8K。这里只剩
 * 转义换行的 2 字符（+1 余量）。
 */
const SCHEMA_LINE_JSON_OVERHEAD = 3;

/**
 * 降级顺序是硬性的：先砍 comment，再砍列。缺 comment 模型知道自己缺什么，可以
 * 用 columnNames 点名再要一次；缺列会让它以为表就这么宽，然后拿残缺列清单去写
 * SQL —— 降精度可恢复，降覆盖会误导。
 */
function fitSchemaColumns(
  columns: AiSchemaColumnContext[],
  wantComments: boolean,
  charBudget: number,
): { lines: string[]; commentsOmitted: boolean } {
  const render = (withComment: boolean) => columns.map((column) => formatSchemaColumn(column, withComment));
  const width = (lines: string[]) =>
    lines.reduce((total, line) => total + line.length + SCHEMA_LINE_JSON_OVERHEAD, 0);

  // 有注释但没带上就要说出来，不管是预算不够还是本轮没点名列——否则模型不知道
  // 这张表还有中文语义可以要，只能自己去 information_schema 捞。
  const hasComments = columns.some((column) => column.comment?.trim());
  if (wantComments) {
    const withComments = render(true);
    if (width(withComments) <= charBudget) return { lines: withComments, commentsOmitted: false };
  }
  const bare = render(false);
  if (width(bare) <= charBudget) return { lines: bare, commentsOmitted: hasComments };

  const lines: string[] = [];
  let used = 0;
  for (const line of bare) {
    used += line.length + SCHEMA_LINE_JSON_OVERHEAD;
    if (used > charBudget) break;
    lines.push(line);
  }
  return { lines, commentsOmitted: hasComments };
}

async function runGetTableSchema(
  args: {
    tables?: unknown;
    columnNames?: unknown;
    columnOffset?: unknown;
    includeDdl?: unknown;
    connectionName?: unknown;
  },
  ctx: AgentToolContext,
): Promise<ToolOutcome> {
  const { name, connection } = requireNamedConnection(ctx, args.connectionName);
  const tables = stringList(args.tables);
  if (tables.length === 0) return fail("tables must be a non-empty array of table names.");
  const requestedColumns = stringList(args.columnNames);
  const columnOffset = boundedInt(args.columnOffset, 0, 0, 100_000);
  const includeDdl = args.includeDdl === true;
  const targets = await resolveNamedTableSchemas({
    tableNames: tables,
    connectionName: name,
    connection,
    matchReason: "agent get_table_schema",
    preferLocalSchemaDir: false,
    maxColumnsPerTable: SCHEMA_COLUMN_HARD_LIMIT,
    request: {
      context: {
        connector: { dialect: ctx.connectionDialects?.[name] ?? resolveDialect(connection.kind, ctx) },
      },
    },
    deps: {
      listDatabases: ctx.connector.listDatabases,
      listTables: ctx.connector.listTables,
      execute: ctx.connector.execute,
      describeTables: ctx.connector.describeTables,
    },
  });
  if (targets.length === 0) return fail(`No schema found for: ${tables.join(", ")}`);
  recordSkillTableEvidence(
    ctx,
    targets.map((target) => target.database ? `${target.database}.${target.table}` : target.table),
  );

  // 每张表拿等额配额，而不是先到先得：旧版让第一张宽表吃光 30K，第二张只剩一个
  // 残缺前缀，模型看不出是哪张表不全，于是绕道 information_schema 重查。
  const columnShare = Math.floor(SCHEMA_RESULT_BUDGET / targets.length);

  const columnPayload = targets.map((target) => {
    const all = target.columns ?? [];
    let selected = all;
    let missingRequestedColumns: string[] | undefined;
    if (requestedColumns.length > 0) {
      const byName = new Map(all.map((column) => [column.name.toLowerCase(), column]));
      selected = requestedColumns.flatMap((requested) => {
        const hit = byName.get(requested.toLowerCase());
        return hit ? [hit] : [];
      });
      const missing = requestedColumns.filter((requested) => !byName.has(requested.toLowerCase()));
      if (missing.length > 0) missingRequestedColumns = missing;
    }
    const windowed = selected.slice(columnOffset);
    // Comments only ride along when the model named the columns: it already knows
    // which ones it wants, so it is confirming meaning rather than counting shape.
    const { lines, commentsOmitted } = fitSchemaColumns(windowed, requestedColumns.length > 0, columnShare);
    const returned = columnOffset + lines.length;
    const complete = returned >= selected.length;
    const columns = lines.join("\n");
    return {
      table: target.database ? `${target.database}.${target.table}` : target.table,
      source: target.source,
      totalColumnCount: selected.length,
      returnedColumnCount: lines.length,
      columnsComplete: complete,
      ...(complete ? {} : { nextColumnOffset: returned }),
      ...(commentsOmitted ? { commentsOmitted: true } : {}),
      columns,
      ...(missingRequestedColumns ? { missingRequestedColumns } : {}),
      ddlSnippet: target.ddlSnippet,
    };
  });

  // DDL 最后拿剩下的额度，绝不预留：它和 columns 同源于一次 SHOW CREATE，是冗余
  // 的，为它挤掉列覆盖会让模型以为表就这么宽。
  const columnsUsed = columnPayload.reduce((total, table) => total + table.columns.length, 0);
  const ddlShare = includeDdl
    ? Math.floor(Math.max(0, SCHEMA_RESULT_BUDGET - columnsUsed) / columnPayload.length)
    : 0;
  const payload = columnPayload.map(({ ddlSnippet, ...table }) =>
    ddlShare > 0 && ddlSnippet ? { ...table, ddlSnippet: truncate(ddlSnippet, ddlShare) } : table,
  );

  const incomplete = payload.filter((table) => !table.columnsComplete);
  return ok({
    format: "columns is one `name:type` per line; ` -- text` after a type is that column's comment",
    tables: payload,
    ...(payload.some((table) => table.commentsOmitted)
      ? { note: "These tables have column comments, omitted here so the full column list fits. Pass columnNames to get comments for the columns you care about." }
      : {}),
    ...(incomplete.length > 0
      ? {
          instruction:
            `Column lists are incomplete for: ${incomplete.map((table) => table.table).join(", ")}. ` +
            "Call again with columnNames for the columns you actually need, or with columnOffset=nextColumnOffset to page. " +
            "Do not treat a partial list as the table's full width.",
        }
      : {}),
  });
}

function normalizeDataQuery(args: Record<string, unknown>): DataQueryRequest | string {
  if (args.language !== undefined && args.language !== "sql" && args.language !== "mongodb") {
    return `unsupported query language: ${String(args.language)}`;
  }
  const language = args.language === "mongodb" ? "mongodb" : "sql";
  if (language === "sql") {
    const query = typeof args.query === "string" ? args.query : typeof args.sql === "string" ? args.sql : "";
    if (!query.trim()) return "query must be a non-empty SQL string.";
    return {
      language,
      query,
      ...(typeof args.database === "string" && args.database.trim()
        ? { database: args.database.trim() }
        : {}),
    };
  }
  const collection = typeof args.collection === "string" ? args.collection.trim() : "";
  if (!collection) return "collection must be a non-empty string.";
  const operation = args.operation === undefined ? "find" : args.operation;
  if (operation !== "find" && operation !== "aggregate") {
    return `unsupported MongoDB operation: ${String(operation)}`;
  }
  let limit: number | null = 200;
  if (args.limit === null) limit = null;
  else if (typeof args.limit === "number" && Number.isFinite(args.limit)) {
    limit = Math.min(1_000_000, Math.max(1, Math.floor(args.limit)));
  } else if (args.limit !== undefined) {
    return "limit must be a finite number or null.";
  }
  const database = typeof args.database === "string" && args.database.trim()
    ? { database: args.database.trim() }
    : {};
  if (operation === "aggregate") {
    if (args.filter !== undefined || args.projection !== undefined) {
      return "MongoDB aggregate requests cannot include find filter or projection fields.";
    }
    const pipeline = asMongoAggregationPipeline(args.pipeline);
    if (typeof pipeline === "string") return pipeline;
    return { language, operation, collection, pipeline, limit, ...database };
  }
  if (args.pipeline !== undefined) return "MongoDB find requests cannot include pipeline.";
  const filter = args.filter === undefined ? {} : args.filter;
  const projection = args.projection === undefined ? null : args.projection;
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) {
    return "filter must be an object.";
  }
  if (projection !== null && (typeof projection !== "object" || Array.isArray(projection))) {
    return "projection must be an object or null.";
  }
  if (containsForbiddenMongoOperator(filter) || containsForbiddenMongoOperator(projection)) {
    return "MongoDB server-side JavaScript operators are not allowed.";
  }
  return {
    language,
    ...(args.operation === undefined ? {} : { operation }),
    collection,
    filter: filter as Record<string, unknown>,
    projection: projection as Record<string, unknown> | null,
    limit,
    ...database,
  };
}

interface DataQueryOutcome {
  runId: string;
  connectionName: string;
  result: QueryResult;
  artifact: QueryArtifactDescriptor | null;
  /** Full result size, which may exceed the bounded preview in `result.rows`. */
  rowCount: number;
  previewTruncatedBy: Array<"rows" | "bytes">;
}

/**
 * Execute one structured query end to end: sql-guard, materialize to a session
 * artifact when the connector supports it, bound the preview, journal the run.
 *
 * Shared by the `run_query` tool and the sandbox `query()` RPC so both paths get
 * the same guard, the same artifact, and the same audit record. `allowMutations`
 * is an explicit argument rather than read from settings because the sandbox
 * path must stay read-only regardless of what the user enabled for the Agent.
 */
async function executeDataQuery(
  ctx: AgentToolContext,
  input: {
    requestedConnection?: unknown;
    query: DataQueryRequest;
    allowMutations: boolean;
  },
): Promise<DataQueryOutcome | { failure: string }> {
  const { name: connectionName, connection } = requireNamedConnection(ctx, input.requestedConnection);
  const query = input.query;
  const connectorMeta = ctx.connector.listKinds().find((item) => item.kind === connection.kind);
  const languages = connectorMeta?.queryLanguages ?? ["sql"];
  if (!languages.includes(query.language)) {
    return { failure: `Connection '${connectionName}' does not support ${query.language} queries.` };
  }
  if (query.language === "mongodb") {
    const operation = query.operation ?? "find";
    const operations = connectorMeta?.mongoOperations ?? ["find"];
    if (!operations.includes(operation)) {
      return { failure: `Connection '${connectionName}' does not support MongoDB ${operation} queries.` };
    }
  }
  const classified = query.language === "sql"
    ? classifySql(query.query, input.allowMutations)
    : null;
  if (classified?.classification === "multi-statement") {
    return { failure: classified.blockedReason ?? "Multiple statements are not allowed." };
  }
  if (classified?.classification === "mutation") {
    if (!input.allowMutations) {
      return { failure: classified.blockedReason ?? "Mutating statements are blocked by default." };
    }
    const approved = await ctx.requestProposal({
      kind: "mutation_sql",
      payload: {
        sql: query.query,
        description: `Run ${classified.keyword ?? "mutation"} statement on connection '${connectionName}'`,
      },
    });
    if (!approved) return { failure: "The user rejected this SQL statement. Do not retry it as-is." };
  }

  const auditText = query.language === "sql" ? query.query : JSON.stringify(query);
  const runId = `${ctx.run.runId}-query-${randomUUID()}`;
  const startedAt = Date.now();
  let result: QueryResult | null = null;
  let artifact: QueryArtifactDescriptor | null = null;
  let totalRowCount: number | undefined;
  let connectorPreviewTruncatedBy: Array<"rows" | "bytes"> = [];
  try {
    if (
      classified?.classification !== "mutation" &&
      ctx.queryArtifacts &&
      (ctx.connector.materializeDataQuery || (query.language === "sql" && ctx.connector.materializeQuery)) &&
      ctx.run.sessionId
    ) {
      const format = connectorMeta?.queryArtifactFormats?.includes("parquet")
        ? "parquet"
        : connectorMeta?.queryArtifactFormats?.includes("jsonl")
          ? "jsonl"
          : null;
      if (format) {
        const target = await ctx.queryArtifacts.createTarget(
          ctx.vaultPath,
          ctx.run.sessionId,
          runId,
          format,
        );
        try {
          const artifactRequest = {
              format,
              outputPath: target.tempPath,
              previewRows: SQL_PREVIEW_ROWS,
              previewMaxBytes: SQL_PREVIEW_MAX_BYTES,
              maxBytes: QUERY_ARTIFACT_MAX_BYTES,
            };
          const materialized = ctx.connector.materializeDataQuery
            ? await ctx.connector.materializeDataQuery(connection.kind, connection.config, query, artifactRequest)
            : await ctx.connector.materializeQuery!(connection.kind, connection.config, query.language === "sql" ? query.query : "", artifactRequest);
          if (materialized) {
            artifact = await ctx.queryArtifacts.finalize(
              target,
              materialized,
              format === "parquet" ? "parquet-stream" : "jsonl-stream",
            );
            totalRowCount = materialized.rowCount;
            connectorPreviewTruncatedBy = materialized.previewTruncatedBy ?? [];
            result = {
              kind: "query",
              columns: materialized.columns,
              rows: materialized.previewRows,
              elapsedMs: materialized.elapsedMs,
            };
          } else {
            await ctx.queryArtifacts.discard(target);
          }
        } catch (err) {
          await ctx.queryArtifacts.discard(target).catch(() => {});
          throw err;
        }
      }
    }

    if (!result) {
      if (ctx.connector.executeQuery) {
        result = await ctx.connector.executeQuery(connection.kind, connection.config, query);
      } else if (query.language === "sql") {
        result = await (ctx.connector.executeUnbounded ?? ctx.connector.execute)(
          connection.kind,
          connection.config,
          query.query,
        );
      } else {
        return { failure: `Connection '${connectionName}' cannot execute structured MongoDB queries.` };
      }
      if (result.kind === "query") {
        totalRowCount = result.rows.length;
        if (ctx.queryArtifacts && ctx.run.sessionId) {
          try {
            artifact = await ctx.queryArtifacts.writeBuffered({
              vaultPath: ctx.vaultPath,
              sessionId: ctx.run.sessionId,
              runId,
              columns: result.columns,
              rows: result.rows,
            });
          } catch (artifactError) {
            log.warn("agent query artifact write failed", {
              runId,
              err: artifactError instanceof Error ? artifactError.message : String(artifactError),
            });
          }
        }
      }
    }
  } catch (err) {
    await recordAgentRun(ctx, auditText, startedAt, null, err, {
      runId,
      connectionName,
      queryLanguage: query.language,
    });
    throw err;
  }
  let previewTruncatedBy: Array<"rows" | "bytes"> = [];
  if (result.kind === "query") {
    const preview = boundedPreview(
      result.rows,
      totalRowCount ?? result.rows.length,
      connectorPreviewTruncatedBy.length === 0,
    );
    result = { ...result, rows: preview.rows };
    previewTruncatedBy = [...new Set([...connectorPreviewTruncatedBy, ...preview.truncatedBy])];
  }
  await recordAgentRun(ctx, auditText, startedAt, result, null, {
    runId,
    connectionName,
    rowCount: totalRowCount,
    queryLanguage: query.language,
  });
  return {
    runId,
    connectionName,
    result,
    artifact,
    rowCount: totalRowCount ?? (result.kind === "query" ? result.rows.length : 0),
    previewTruncatedBy,
  };
}

async function runQuery(
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<ToolOutcome> {
  const normalized = normalizeDataQuery(args);
  if (typeof normalized === "string") return fail(normalized);
  const query = normalized;
  const executed = await executeDataQuery(ctx, {
    requestedConnection: args.connectionName,
    query,
    allowMutations: ctx.aiSettings.agentAllowMutations,
  });
  if ("failure" in executed) return fail(executed.failure);
  const { runId, connectionName, result, previewTruncatedBy } = executed;
  const auditText = query.language === "sql" ? query.query : JSON.stringify(query);
  const evidenceTables = query.language === "sql"
    ? extractSqlFacts(query.query).flatMap((facts) => [
      ...facts.readTables,
      ...facts.writeTables,
    ]).map((table) => table.db ? `${table.db}.${table.table}` : table.table)
    : [query.database ? `${query.database}.${query.collection}` : query.collection];
  recordSkillTableEvidence(ctx, evidenceTables);
  if (result.kind === "query" && query.language === "sql") {
    ctx.chartRuns?.set(runId, {
      sql: auditText,
      columns: result.columns,
      rows: result.rows.slice(0, SQL_PREVIEW_ROWS),
    });
  }
  if (result.kind === "mutation") {
    return ok({ runId, connectionName, language: query.language, result: formatQueryResult(result) });
  }
  const rowCount = executed.rowCount;
  const previewTruncated = previewTruncatedBy.length > 0;
  ctx.analysisRuns?.set(runId, {
    kind: "query",
    connectionName,
    tables: evidenceTables,
    columns: result.columns,
    rowCount,
    truncated: previewTruncated,
    incomplete: query.language === "mongodb" && query.limit !== null && rowCount === query.limit,
    sourceRunIds: [],
    summary: {
      columns: result.columns,
      rowCount,
      rows: result.rows,
      previewTruncated,
      previewTruncatedBy,
    },
  });
  // A truncated result is handed back as `sampleRows`, never as `rows`: the model
  // cannot count what is not presented as the result.
  const modelPreview = boundedPreview(
    result.rows,
    rowCount,
    false,
    previewTruncated ? MODEL_SAMPLE_ROWS : SQL_PREVIEW_ROWS,
    MODEL_PREVIEW_MAX_BYTES,
  );
  const truncated = previewTruncated || modelPreview.truncated;
  return ok({
    runId,
    connectionName,
    language: query.language,
    result: {
      kind: "query",
      columns: result.columns,
      rowCount,
      ...(truncated ? { sampleRows: modelPreview.rows } : { rows: modelPreview.rows }),
      previewTruncated: truncated,
      previewTruncatedBy: truncated
        ? [...new Set([...previewTruncatedBy, ...modelPreview.truncatedBy])]
        : [],
      elapsedMs: result.elapsedMs,
    },
    ...(truncated
      ? {
          instruction:
            `Only ${modelPreview.rows.length} sample rows are shown; rowCount is the true size. ` +
            "Do not count or aggregate these samples. Aggregate in the source query, or declare it in " +
            "execute_python.sources and compute over the complete aliased input.",
        }
      : {}),
  });
}

function pythonFailureGuidance(error: string, sourceAliases: readonly string[] = []): string | null {
  if (/unknown_database|missing_database_route|unknown data connection|collection must be a non-empty string/i.test(error)) {
    return (
      "Python guidance: prefer execute_python.sources for queries known before execution. " +
      "Give every source an alias, language, and the required database/query or database/collection fields."
    );
  }
  if (/coroutine.*has no attribute ['\"]df|has no attribute ['\"]df.*coroutine/i.test(error)) {
    return (
      "Python guidance: query() is async. Prefer to_df(alias) for a declared source; " +
      "for a dynamic query use `(await query(connection_name, request)).df()`."
    );
  }
  if (/DuckDBPyRelation|__getitem__\(\): incompatible function arguments|not subscriptable/i.test(error)) {
    return (
      "Python guidance: query() and tables[alias] return DuckDB relations, not row lists. " +
      "Convert with `.df()` or use `to_df(alias)` before pandas-style indexing."
    );
  }
  const missingName = /name ['\"]([^'\"]+)['\"] is not defined/i.exec(error)?.[1];
  if (missingName && sourceAliases.includes(missingName)) {
    const alias = JSON.stringify(missingName);
    return `Python guidance: ${alias} is a registered source alias, not a Python variable. ` +
      `Use to_df(${alias}) for pandas or tables[${alias}] for a DuckDB relation. ` +
      "The source is present; do not reset or reload it to fix this NameError.";
  }
  if (missingName === "result") {
    return "Python guidance: result is the per-cell output slot, cleared before every cell. " +
      "Keep reusable values under another variable name and assign result again. This alone does not indicate workspace loss.";
  }
  if (missingName) {
    return (
      "Python guidance: inspect the workspace snapshot. Define missing variables; " +
      "reload sources only if the workspace was lost or fresh data is required."
    );
  }
  return null;
}

async function runExecutePython(
  args: { code?: unknown; sources?: unknown; reset?: unknown },
  ctx: AgentToolContext,
): Promise<ToolOutcome> {
  if (!ctx.pythonExecutor || !ctx.queryArtifacts || !ctx.run.sessionId) {
    return fail("Python execution is unavailable in this Agent session.");
  }
  const code = typeof args.code === "string" ? args.code.trim() : "";
  if (!code) return fail("code must be a non-empty string.");
  if (code.length > PYTHON_CODE_MAX_CHARS) {
    return fail(`code exceeds ${PYTHON_CODE_MAX_CHARS} characters.`);
  }
  if (args.reset !== undefined && typeof args.reset !== "boolean") return fail("reset must be boolean");
  const rawSources = args.sources === undefined ? [] : args.sources;
  if (!Array.isArray(rawSources)) return fail("sources must be an array when provided.");
  if (rawSources.length > PYTHON_SOURCE_MAX_ITEMS) {
    return fail(`sources supports at most ${PYTHON_SOURCE_MAX_ITEMS} queries per execution.`);
  }
  const aliases = new Set<string>();
  const sources: Array<{
    alias: string;
    connectionName?: string;
    query: DataQueryRequest;
  }> = [];
  for (let index = 0; index < rawSources.length; index += 1) {
    const raw = rawSources[index];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return fail(`sources[${index}] must be an object.`);
    }
    const source = raw as Record<string, unknown>;
    const alias = typeof source.alias === "string" ? source.alias.trim() : "";
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(alias)) {
      return fail(`sources[${index}].alias must be a Python identifier of at most 64 characters.`);
    }
    if (aliases.has(alias)) return fail(`sources[${index}].alias '${alias}' is duplicated.`);
    aliases.add(alias);
    if (source.language !== "sql" && source.language !== "mongodb") {
      return fail(`sources[${index}].language must be sql or mongodb.`);
    }
    const allowedFields = source.language === "sql"
      ? new Set(["alias", "language", "query", "database", "connectionName"])
      : new Set([
          "alias",
          "language",
          "collection",
          "database",
          "operation",
          "filter",
          "projection",
          "pipeline",
          "limit",
          "connectionName",
        ]);
    const unexpectedFields = Object.keys(source).filter((key) => !allowedFields.has(key));
    if (unexpectedFields.length > 0) {
      const suffix = source.language === "sql" && unexpectedFields.includes("limit")
        ? " Put LIMIT inside the SQL query; nothing was executed."
        : " Nothing was executed.";
      return fail(
        `sources[${index}] (${alias}): ${source.language} source does not accept ` +
          `${unexpectedFields.map((key) => `'${key}'`).join(", ")}.${suffix}`,
      );
    }
    // `normalizeDataQuery`'s 200-row default exists for the `run_query` preview. A Python source
    // is handed the complete artifact, so an omitted limit means complete, not 200.
    const normalized = normalizeDataQuery({ ...source, limit: source.limit ?? null });
    if (typeof normalized === "string") return fail(`sources[${index}] (${alias}): ${normalized}`);
    sources.push({
      alias,
      ...(typeof source.connectionName === "string" && source.connectionName.trim()
        ? { connectionName: source.connectionName.trim() }
        : {}),
      query: normalized,
    });
  }

  const sourceRunIds: string[] = [];
  if (args.reset === true) {
    if (!ctx.pythonExecutor.reset) return fail("Workspace reset is unavailable");
    await ctx.pythonExecutor.reset(ctx.vaultPath, ctx.run.sessionId);
  }
  const artifacts: Record<string, QueryArtifactDescriptor> = {};
  const limitedAtCap: string[] = [];
  let sourceBytes = 0;
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index]!;
    let executed: DataQueryOutcome | { failure: string };
    try {
      executed = await executeDataQuery(ctx, {
        requestedConnection: source.connectionName,
        query: source.query,
        allowMutations: false,
      });
    } catch (error) {
      return fail(
        `sources[${index}] (${source.alias}) failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if ("failure" in executed) return fail(`sources[${index}] (${source.alias}) failed: ${executed.failure}`);
    if (!executed.artifact) {
      return fail(
        `sources[${index}] (${source.alias}) could not provide a complete Python input. ` +
          "Aggregate or filter the query, or use a connector that supports complete query materialization.",
      );
    }
    sourceBytes += executed.artifact.byteSize;
    if (sourceBytes > PYTHON_QUERY_MAX_BYTES) {
      return fail(
        `sources exceed the ${Math.round(PYTHON_QUERY_MAX_BYTES / (1024 * 1024 * 1024))} GiB ` +
          "data budget for one execute_python call; aggregate or select fewer columns.",
      );
    }
    artifacts[source.alias] = executed.artifact;
    sourceRunIds.push(executed.runId);
    // A source that returns exactly as many rows as it asked for is almost certainly cut off,
    // and nothing else says so: the sandbox only sees the row count it was handed.
    if (source.query.language === "mongodb" && source.query.limit !== null
      && executed.artifact.rowCount === source.query.limit) {
      limitedAtCap.push(`${source.alias} (limit ${source.query.limit})`);
      artifacts[source.alias] = { ...executed.artifact, incomplete: true };
    }
    if (source.query.language === "sql") {
      recordSkillTableEvidence(
        ctx,
        extractSqlFacts(source.query.query)
          .flatMap((facts) => facts.readTables)
          .map((table) => (table.db ? `${table.db}.${table.table}` : table.table)),
      );
    }
  }
  const result = await ctx.pythonExecutor.execute({
    vaultPath: ctx.vaultPath,
    sessionId: ctx.run.sessionId,
    code,
    runSemantic: ctx.runSemantic,
    analysisContext: { runId: ctx.run.runId, question: ctx.analysisContext?.question ?? "",
      semanticOptimization: ctx.aiSettings.semanticOptimizationEnabled === true,
      invalidateEvidence: ctx.run.analysis !== undefined && ctx.run.analysis.status !== "observed",
      automaticContracts: ctx.aiSettings.automaticAnalysisContractsEnabled === true },
    artifacts,
    runQuery: async ({ connectionName, request }) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(request);
      } catch {
        throw new Error("query() received a request that is not valid JSON.");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("query() takes a SQL string or a MongoDB request object.");
      }
      // Same normalizer the run_query tool uses, so both paths reject the same
      // malformed and forbidden requests.
      const spec = parsed as Record<string, unknown>;
      const query = normalizeDataQuery({ ...spec, limit: spec.limit ?? null });
      if (typeof query === "string") throw new Error(query);
      const executed = await executeDataQuery(ctx, {
        requestedConnection: connectionName,
        query,
        // Sandbox code is never allowed to mutate, whatever the user enabled for
        // the Agent: a mutation must go through the UI proposal on run_query.
        allowMutations: false,
      });
      if ("failure" in executed) throw new Error(executed.failure);
      if (!executed.artifact) {
        throw new Error(
          "This result is too large to hand to Python. Aggregate or filter it in the query first.",
        );
      }
      sourceRunIds.push(executed.runId);
      if (query.language === "sql") {
        recordSkillTableEvidence(
          ctx,
          extractSqlFacts(query.query)
            .flatMap((facts) => facts.readTables)
            .map((table) => (table.db ? `${table.db}.${table.table}` : table.table)),
        );
      }
      return { ...executed.artifact, incomplete: query.language === "mongodb" && query.limit !== null && executed.artifact.rowCount === query.limit };
    },
    signal: ctx.signal,
  });
  if (result.analysis && ctx.aiSettings.automaticAnalysisContractsEnabled) ctx.run.analysis = result.analysis;
  if (!result.ok) {
    const error = result.error ?? "Python execution failed.";
    const guidance = pythonFailureGuidance(error, result.workspace?.sources.map((source) => source.alias));
    return { ok: false, text: JSON.stringify({ error: error.slice(0, 16000),
      workspace: result.workspace ? { ...result.workspace, variables: result.workspace.variables.slice(0, 10),
        sources: result.workspace.sources.slice(0, 10), refreshedAliases: result.workspace.refreshedAliases.slice(0, 10) } : undefined,
      workspacePreviewTruncated: Boolean(result.workspace && (result.workspace.variables.length > 10 || result.workspace.sources.length > 10)),
      stdout: result.stdout.slice(-4000), guidance }) };
  }
  const runId = `${ctx.run.runId}-python-${randomUUID()}`;
  for (const source of result.workspace?.sources ?? []) {
    if (!sourceRunIds.includes(source.version)) sourceRunIds.push(source.version);
    if (source.incomplete && !limitedAtCap.some((s) => s.startsWith(source.alias + " "))) limitedAtCap.push(`${source.alias} (retained limited snapshot)`);
  }
  const value = result.value;
  ctx.analysisRuns?.set(runId, {
    kind: "python",
    tables: [],
    columns: value.kind === "table" ? value.columns : [],
    rowCount: value.kind === "table" ? value.rowCount : value.kind === "scalar" ? 1 : 0,
    truncated: value.kind === "table" && value.truncated,
    sourceRunIds,
    summary: value,
  });
  const response = {
    runId,
    workspace: result.workspace,
    stdoutTruncated: result.stdoutTruncated,
    ...(limitedAtCap.length > 0
      ? {
          incompleteSources:
            `${limitedAtCap.join(", ")} returned exactly the requested limit, so the source is ` +
            "probably cut off. Do not treat it as the complete set: omit limit for the complete " +
            "result, or aggregate inside the source query.",
        }
      : {}),
    ...(value.kind === "none"
      ? {
          instruction:
            "No structured result was assigned. Reuse the workspace and assign result in the next cell.",
        }
      : {}),
    stdout: result.stdout,
    result: value,
    elapsedMs: result.elapsedMs,
  };
  // Never slice serialized JSON: prioritize the result and state over stdout.
  if (JSON.stringify(response).length > RESULT_CHAR_BUDGET) {
    response.stdout = response.stdout.slice(-1000);
    response.stdoutTruncated = true;
  }
  if (response.result.kind === "table") {
    while (response.result.rows.length && JSON.stringify(response).length > RESULT_CHAR_BUDGET) {
      response.result.rows.pop();
      response.result.truncated = true;
    }
  }
  if (JSON.stringify(response).length > RESULT_CHAR_BUDGET) {
    response.result = { kind: "none" };
    Object.assign(response, { instruction: "Result exceeds response budget. Retained in workspace; aggregate or select fewer fields." });
  }
  if (response.workspace && JSON.stringify(response).length > RESULT_CHAR_BUDGET) {
    response.workspace = { ...response.workspace, variables: response.workspace.variables.slice(0, 10),
      sources: response.workspace.sources.slice(0, 10), refreshedAliases: response.workspace.refreshedAliases.slice(0, 10) };
    Object.assign(response, { workspacePreviewTruncated: true });
  }
  return { ok: true, text: JSON.stringify(response) };
}

function runCreateChart(args: Record<string, unknown>, ctx: AgentToolContext): ToolOutcome {
  const runId = typeof args.runId === "string" ? args.runId : "";
  const run = ctx.chartRuns?.get(runId);
  if (!run) return fail("runId must refer to a successful SQL run_query from this Agent run.");
  const { runId: _discardRunId, fields: rawFields, ...chartArgs } = args;
  void _discardRunId;
  const fieldEntries = (Array.isArray(rawFields) ? rawFields : []).flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const { id, ...definition } = raw as Record<string, unknown>;
    return typeof id === "string" ? [[id, definition]] : [];
  });
  if (new Set(fieldEntries.map(([id]) => id)).size !== fieldEntries.length) return fail("Chart semantic field ids must be unique.");
  const fields = Object.fromEntries(fieldEntries);
  const candidate = {
    ...chartArgs,
    fields,
    version: 2,
    source: { kind: "run", runId },
  };
  const parsed = stelaChartSpecSchema.safeParse(candidate);
  if (!parsed.success) {
    return fail(describeZodError(parsed.error));
  }
  validateStelaChartData(parsed.data, run.columns, run.rows);
  const source = stringifyStelaChartSpec(parsed.data);
  return ok({
    chart: parsed.data,
    markdown: `\`\`\`stela-chart\n${source}\n\`\`\``,
    instruction: "Include this exact fenced block in the final answer, followed by a concise evidence line.",
  });
}

async function runCreateAnalysisCanvas(args: Record<string, unknown>, ctx: AgentToolContext): Promise<ToolOutcome> {
  if (ctx.canvasRefresh) return fail("A Canvas refresh run cannot create another Canvas.");
  if (typeof args.title !== "string" || !args.title.trim()) return fail("title must be a non-empty string.");
  const directory = typeof args.directory === "string" && args.directory.trim()
    ? resolveVaultTarget(ctx.vaultPath, args.directory)
    : ctx.run.notePath ? path.dirname(ctx.run.notePath) : ctx.vaultPath;
  const file = await analysisCanvasService.createAnalysisCanvas(
    ctx.vaultPath,
    directory,
    args.title.trim(),
    ctx.run.sessionId ?? null,
  );
  const canvas = parseAnalysisCanvas(file.content);
  ctx.onCanvasUpdated?.({ path: vaultRelativePath(ctx.vaultPath, file.path), title: canvas.title, action: "created" });
  return ok({ path: file.path, etag: file.etag, content: file.content, instruction: "Populate this Canvas incrementally with update_analysis_canvas after verified SQL run_query results." });
}

async function runReadAnalysisCanvas(args: Record<string, unknown>, ctx: AgentToolContext): Promise<ToolOutcome> {
  if (typeof args.path !== "string" || !args.path.trim()) return fail("path must be a non-empty string.");
  return ok(await analysisCanvasService.readAnalysisCanvas(ctx.vaultPath, resolveVaultTarget(ctx.vaultPath, args.path)));
}

async function runUpdateAnalysisCanvas(args: Record<string, unknown>, ctx: AgentToolContext): Promise<ToolOutcome> {
  if (typeof args.path !== "string" || typeof args.etag !== "string" || typeof args.content !== "string") return fail("path, etag, and content are required.");
  const target = resolveVaultTarget(ctx.vaultPath, args.path);
  if (ctx.canvasRefresh) {
    const refreshTarget = resolveVaultTarget(ctx.vaultPath, ctx.canvasRefresh.path);
    if (path.resolve(target) !== path.resolve(refreshTarget)) {
      return fail("This Canvas refresh run may update only its requested Canvas.");
    }
    if (ctx.canvasRefresh.committed) {
      return fail("This Canvas refresh has already committed its one atomic update.");
    }
  }
  const currentFile = await analysisCanvasService.readAnalysisCanvas(ctx.vaultPath, target);
  const current = parseAnalysisCanvas(currentFile.content);
  let desired: AnalysisCanvas;
  try { desired = parseAnalysisCanvas(args.content); } catch (error) { return fail(`Invalid Canvas JSON: ${describeZodError(error)}`); }
  if (
    desired.id !== current.id ||
    desired.createdAt !== current.createdAt ||
    desired.createdBySessionId !== current.createdBySessionId
  ) {
    return fail("Canvas id, createdAt, and createdBySessionId are immutable.");
  }
  const rawBindings = Array.isArray(args.sourceRuns) ? args.sourceRuns : [];
  const bindings = new Map<string, string>();
  for (const raw of rawBindings) {
    if (!raw || typeof raw !== "object") return fail("sourceRuns entries must be objects.");
    const item = raw as Record<string, unknown>;
    if (typeof item.sourceId !== "string" || typeof item.runId !== "string") return fail("Each sourceRuns entry needs sourceId and runId.");
    bindings.set(item.sourceId, item.runId);
  }
  if (ctx.canvasRefresh) {
    const targetSourceIds = ctx.canvasRefresh.sourceId
      ? [ctx.canvasRefresh.sourceId]
      : current.sources.map((source) => source.id);
    for (const sourceId of targetSourceIds) {
      if (!current.sources.some((source) => source.id === sourceId)) {
        return fail(`Atomic Canvas refresh target source does not exist: ${sourceId}`);
      }
      if (!desired.sources.some((source) => source.id === sourceId)) {
        return fail(`Atomic Canvas refresh must preserve target source ${sourceId}.`);
      }
      if (!bindings.has(sourceId)) {
        return fail(`Atomic Canvas refresh requires a successful run binding for target source ${sourceId}.`);
      }
    }
  }
  const sources = [] as AnalysisCanvas["sources"];
  for (const source of desired.sources) {
    const boundRunId = bindings.get(source.id);
    if (boundRunId) {
      const currentRun = ctx.chartRuns?.get(boundRunId);
      if (!currentRun) {
        return fail(`runId ${boundRunId} must come from a successful query in this Agent run.`);
      }
      const run = await ctx.resolveChartRun?.(boundRunId);
      if (!run || run.status !== "ok") return fail(`runId ${boundRunId} is not an audited successful run.`);
      const sqlIssue = analysisCanvasService.analysisCanvasSqlIssue(currentRun.sql);
      if (sqlIssue) return fail(`Canvas source ${source.id} is not refreshable: ${sqlIssue}`);
      sources.push({ ...source, connectionName: run.connectionName, sql: currentRun.sql, lastRunId: run.runId, lastRunAt: run.startedAt, lastError: null });
      continue;
    }
    const existing = current.sources.find((item) => item.id === source.id);
    if (!existing) return fail(`New source ${source.id} must be bound through sourceRuns.`);
    if (source.sql !== existing.sql || source.connectionName !== existing.connectionName) return fail(`Changed source ${source.id} must be rebound through sourceRuns.`);
    const sqlIssue = analysisCanvasService.analysisCanvasSqlIssue(existing.sql);
    if (sqlIssue) return fail(`Canvas source ${source.id} is not refreshable: ${sqlIssue}`);
    sources.push({ ...source, sql: existing.sql, connectionName: existing.connectionName, lastRunId: existing.lastRunId, lastRunAt: existing.lastRunAt, lastError: existing.lastError });
  }
  const sections = desired.sections.map((section) => ({
    ...section,
    cards: section.cards.map((card) => {
      if (card.type !== "flow") return card;
      const existing = current.sections.flatMap((item) => item.cards).find((item) => item.id === card.id && item.type === "flow");
      const prior = existing?.type === "flow" ? new Map(existing.nodes.map((node) => [node.id, node.position])) : new Map<string, undefined>();
      return {
        ...card,
        direction: existing?.type === "flow" ? existing.direction : card.direction,
        nodes: card.nodes.map((node) => ({ ...node, position: prior.get(node.id) })),
      };
    }),
  }));
  const nextDesired = { ...desired, sources, sections };
  const updated = await analysisCanvasService.updateAnalysisCanvas(ctx.vaultPath, target, args.etag, () => nextDesired);
  if (ctx.canvasRefresh) ctx.canvasRefresh.committed = true;
  ctx.onCanvasUpdated?.({ path: vaultRelativePath(ctx.vaultPath, updated.path), title: desired.title, action: "updated" });
  return ok({ path: updated.path, etag: updated.etag, status: desired.status, sections: desired.sections.length, cards: desired.sections.reduce((sum, section) => sum + section.cards.length, 0) });
}

/** 记录失败不应影响 agent 继续工作——落盘异常只记日志。 */
async function recordAgentRun(
  ctx: AgentToolContext,
  sql: string,
  startedAt: number,
  result: QueryResult | null,
  err: unknown,
  options: {
    runId?: string;
    connectionName?: string;
    rowCount?: number;
    queryLanguage?: "sql" | "mongodb";
  } = {},
): Promise<string | null> {
  const elapsedMs = result?.elapsedMs ?? Date.now() - startedAt;
  const isQuery = result?.kind === "query";
  const runId = options.runId ?? `${ctx.run.runId}-sql-${randomUUID()}`;
  try {
    await ctx.recordRun({
      // 一次 agent run 可能跑多条 SQL，runId 必须唯一；blockId 保持同一个
      // `agent:<agentRunId>`，这样一次对话里的所有执行归到同一"块"下。
      runId,
      blockId: `agent:${ctx.run.runId}`,
      sql,
      queryLanguage: options.queryLanguage ?? "sql",
      status: result ? "ok" : "err",
      message: result ? null : err instanceof Error ? err.message : String(err),
      startedAt,
      elapsedMs,
      rowCount: options.rowCount ?? (isQuery ? result.rows.length : (result?.affectedRows ?? 0)),
      connectionName: options.connectionName ?? ctx.connectionName ?? "",
      notePath: ctx.run.notePath,
      columns: isQuery ? result.columns : [],
      rows: isQuery ? result.rows : [],
    });
    return runId;
  } catch (recordErr) {
    log.warn("agent query history write failed", {
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
  args: { table?: unknown; readTable?: unknown; writeTable?: unknown; operations?: unknown; limit?: unknown },
  ctx: AgentToolContext,
): Promise<ToolOutcome> {
  const table = typeof args.table === "string" ? args.table.trim() : "";
  const readTable = typeof args.readTable === "string" ? args.readTable.trim() : "";
  const writeTable = typeof args.writeTable === "string" ? args.writeTable.trim() : "";
  const operations = stringList(args.operations)
    .map((op) => op.toLowerCase())
    .filter((op): op is SqlIndexOperation => SQL_INDEX_OPERATIONS.has(op as SqlIndexOperation));
  if (table && (readTable || writeTable)) {
    return fail("table cannot be combined with readTable or writeTable; use one query direction.");
  }
  if (!table && !readTable && !writeTable && operations.length === 0) {
    return fail("Provide at least one of table, readTable, writeTable or operations.");
  }
  if (ctx.mode === "maintenance") {
    const requestedTables = [table, readTable, writeTable].filter(Boolean);
    if (requestedTables.length !== 1 || !ctx.maintenanceTables?.includes(requestedTables[0]!)) {
      return fail("Automatic maintenance may search SQL usage only for tables in this run's evidence.");
    }
  }
  const limit = boundedInt(args.limit, 60, 1, 300);

  const common = { ...(operations.length > 0 ? { operations } : {}), maxHits: limit };
  const hits = table
    ? Array.from(
      new Map(
        (await Promise.all([
          ctx.sqlIndex.query({ ...common, readTable: table }),
          ctx.sqlIndex.query({ ...common, writeTable: table }),
        ])).flat().map((hit) => [`${hit.path}:${hit.blockIndex}`, hit]),
      ).values(),
    )
    : await ctx.sqlIndex.query({
      ...common,
      ...(readTable ? { readTable } : {}),
      ...(writeTable ? { writeTable } : {}),
    });
  if (hits.length === 0) {
    const scope = table ? `uses '${table}'` : readTable ? `reads '${readTable}'` : writeTable ? `writes '${writeTable}'` : "matches the filter";
    return fail(
      `No indexed SQL block ${scope}. The table name may be spelled differently, ` +
        "or it may only be mentioned in prose — try search_vault, or ask the user which table they mean.",
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

  const notes = await Promise.all([...byNote.values()]
    .map(async (entry) => {
      const updatedAt = await fs.stat(path.join(ctx.vaultPath, entry.path))
        .then((stat) => stat.mtime.toISOString())
        .catch(() => null);
      return {
        path: entry.path,
        blocks: entry.blocks,
        lastRunDate: entry.lastRunDate,
        updatedAt,
        operations: [...entry.operations],
        firstLine: entry.firstLine,
      };
    }));
  notes
    .sort(
      (a, b) =>
        (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") ||
        (b.lastRunDate ?? "").localeCompare(a.lastRunDate ?? "") ||
        b.blocks - a.blocks ||
        a.path.localeCompare(b.path),
    );
  if (ctx.mode === "maintenance") {
    for (const note of notes) ctx.maintenanceRelatedNotes?.paths.add(note.path);
  }

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
  const canonicalVaultPath = await vaultFs.ensureWithinVault(ctx.vaultPath, ctx.vaultPath);
  const relativePath = path.relative(canonicalVaultPath, target);
  if (
    ctx.mode === "maintenance" &&
    (!ctx.maintenanceRelatedNotes?.paths.has(relativePath) || ctx.maintenanceRelatedNotes.reads >= 3)
  ) {
    return fail("Automatic maintenance may read at most three notes returned by its SQL-usage search.");
  }
  const content = await vaultFs.readFile(target);
  if (ctx.explicitSkillMaintenance && ctx.skillEvidence) {
    ctx.skillEvidence.notePaths.add(relativePath.split(path.sep).join("/"));
  }
  const offset = boundedInt(args.offset, 0, 0, content.length);
  const fullRead = args.maxChars === 0 && ctx.mode !== "maintenance";
  const maxChars = fullRead
    ? content.length - offset
    : boundedInt(args.maxChars, ctx.mode === "maintenance" ? 12_000 : 50_000, 1, ctx.mode === "maintenance" ? 12_000 : 120_000);
  const slice = fullRead ? content.slice(offset) : content.slice(offset, offset + maxChars);
  if (ctx.mode === "maintenance") ctx.maintenanceRelatedNotes!.reads++;
  return ok({
    path: relativePath,
    offset,
    charsReturned: slice.length,
    totalChars: content.length,
    nextOffset: offset + slice.length < content.length ? offset + slice.length : null,
    content: slice,
  }, fullRead ? Number.POSITIVE_INFINITY : maxChars + 2_000);
}

async function runLoadSkill(args: { name?: unknown }, ctx: AgentToolContext): Promise<ToolOutcome> {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  const skill = ctx.skills.find((item) => item.metadata.name === name);
  if (!skill) return fail(`No installed Skill named '${name}'. Use only names in the available Skills list.`);
  const freshness = ctx.getSkillFreshness ? await ctx.getSkillFreshness(skill) : "fresh";
  if (freshness === "stale" && !ctx.explicitSkillMaintenance) {
    // ADR-0073 把 stale Skill 排除在 routine 发现之外，所以这里不再内联刷新：
    // 那是一次完整的 maintenance LLM 调用，实测阻塞 10-57s 且近三成仍然失败。
    ctx.scheduleSkillRefresh?.(skill);
    return fail(
      `stale_skill_unavailable: '${name}' no longer matches its source documents. A background refresh was scheduled; ` +
        "do not call load_skill for it again in this run. Use live schema and note retrieval instead.",
    );
  }
  ctx.onSkillUsage?.({
    type: "loaded",
    source: "load",
    origin: skill.metadata.origin,
    name: skill.metadata.name,
    category: skill.metadata.category,
  });
  const content = skill.skill.content;
  const truncated = content.length > MAX_AGENT_SKILL_CHARS;
  return ok({
    name: skill.metadata.name,
    source: skill.metadata.origin,
    freshness,
    usableForFacts: skill.metadata.origin === "vault" && freshness === "fresh",
    ...(freshness === "stale"
      ? { warning: "Stale Skill body is inspection-only. Verify every retained rule against live evidence before saving." }
      : freshness === "untracked"
        ? { warning: "Untracked Skill has no source hashes. Treat it as guidance and verify material facts before use." }
        : {}),
    content: truncated ? `${content.slice(0, MAX_AGENT_SKILL_CHARS)}\n\n[truncated: compact this Skill before updating it]` : content,
    truncated,
  }, MAX_AGENT_SKILL_CHARS + 100);
}

async function runSearchSkills(
  args: { query?: unknown; offset?: unknown; limit?: unknown },
  ctx: AgentToolContext,
): Promise<ToolOutcome> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const browsing = query.length === 0;
  const limit = boundedInt(args.limit, browsing ? 20 : 8, 1, browsing ? 50 : 20);
  const searchable = ctx.skills.filter((skill) => skill.metadata.origin === "vault");
  const ranked = browsing
    ? [...searchable].sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))
    : rankAgentSkills(searchable, query, searchable.length);
  const offset = boundedInt(args.offset, 0, 0, ranked.length);
  const page = ranked.slice(offset, offset + limit);
  const checked = await Promise.all(page.map(async (skill) => ({
    skill,
    freshness: ctx.getSkillFreshness ? await ctx.getSkillFreshness(skill) : "fresh" as const,
  })));
  const visible = ctx.explicitSkillMaintenance
    ? checked
    : checked.filter((item) => item.freshness !== "stale");
  const skills = visible.map(({ skill: { metadata }, freshness }) => ({
    name: metadata.name,
    description: metadata.description,
    category: metadata.category,
    tags: metadata.tags,
    freshness,
  }));
  if (!browsing) {
    for (const skill of skills) {
      ctx.onSkillUsage?.({
        type: "candidate",
        source: "search",
        origin: "vault",
        name: skill.name,
        category: skill.category,
      });
    }
  }
  const consumed = offset + page.length;
  const nextOffset = consumed < ranked.length ? consumed : null;
  return ok({
    skills,
    totalSkills: searchable.length,
    totalMatches: ranked.length,
    nextOffset,
    truncated: nextOffset !== null,
    omittedStale: checked.length - visible.length,
  });
}

async function runSaveSkill(
  args: {
    action?: unknown;
    name?: unknown;
    content?: unknown;
    reason?: unknown;
    sourcePaths?: unknown;
    sourceTables?: unknown;
  },
  ctx: AgentToolContext,
): Promise<ToolOutcome> {
  const action = args.action ?? "save";
  const name = typeof args.name === "string" ? args.name : "";
  const systemNames = Array.from(new Set([
    ...(ctx.reservedSkillNames ?? []),
    ...ctx.skills
      .filter((skill) => skill.metadata.origin === "system")
      .map((skill) => skill.metadata.name),
  ]));
  const reason = typeof args.reason === "string" && args.reason.trim()
    ? args.reason
    : "Updated internal data knowledge.";
  if (ctx.mode === "refresh" && ctx.maintenanceRefreshName !== name) {
    return fail(`Refresh may update only '${ctx.maintenanceRefreshName ?? "the selected Skill"}'.`);
  }
  const requestedSourcePaths = stringList(args.sourcePaths).slice(0, 3);
  const requestedSourceTables = stringList(args.sourceTables).map((table) => table.toLowerCase()).slice(0, 8);
  if (ctx.explicitSkillMaintenance) {
    const unknownPath = requestedSourcePaths.find((sourcePath) => !ctx.skillEvidence?.notePaths.has(sourcePath));
    if (unknownPath) {
      return fail(`sourcePaths may contain only Vault notes read in this maintenance turn: '${unknownPath}' was not read.`);
    }
    const unknownTable = requestedSourceTables.find((table) => !ctx.skillEvidence?.tables.has(table));
    if (unknownTable) {
      return fail(`sourceTables may contain only tables inspected in this maintenance turn: '${unknownTable}' was not inspected.`);
    }
  } else if (requestedSourcePaths.length > 0 || requestedSourceTables.length > 0) {
    return fail("sourcePaths and sourceTables are available only during explicit knowledge maintenance.");
  }
  const record =
    action === "save"
      ? typeof args.content === "string"
        ? await saveAgentSkill(ctx.vaultPath, name, args.content, reason, {
          overwrite: ctx.mode !== "maintenance",
          dialect: ctx.mode === "maintenance" || ctx.mode === "refresh" ? ctx.maintenanceDialect : null,
          automatic: ctx.mode === "maintenance",
          templateDriven: ctx.mode === "maintenance" || ctx.mode === "refresh",
          sourcePaths: ctx.explicitSkillMaintenance
            ? requestedSourcePaths
            : ctx.maintenanceSourcePaths,
          sourceTables: ctx.explicitSkillMaintenance
            ? requestedSourceTables
            : ctx.maintenanceTables,
          reservedNames: systemNames,
        })
        : null
      : action === "archive"
        ? ctx.mode === "maintenance"
          ? null
          : await archiveAgentSkill(ctx.vaultPath, name, reason, { reservedNames: systemNames })
        : null;
  if (!record) {
    return fail(
      ctx.mode === "maintenance" && action === "archive"
        ? "Automatic maintenance cannot archive existing Skills."
        : "save requires content; action must be save or archive.",
    );
  }
  const refreshed = await loadAgentSkills(ctx.vaultPath);
  const system = ctx.skills.filter((skill) => skill.metadata.origin === "system");
  const reserved = new Set(system.map((skill) => skill.metadata.name));
  ctx.skills.splice(
    0,
    ctx.skills.length,
    ...system,
    ...refreshed.vault.filter((skill) => !reserved.has(skill.metadata.name)),
  );
  ctx.onSkillMaintenance?.(record);
  return ok(record, RESULT_CHAR_BUDGET, ctx.mode === "maintenance" || ctx.mode === "refresh");
}

/**
 * 归一化 CRLF 与行尾空白，同时逐字符保留原文下标。
 * 保留映射而不是按长度回推，否则归一化删掉的空白会让替换切片错位。
 */
function normalizeForMatch(text: string): { normalized: string; origin: number[] } {
  let normalized = "";
  const origin: number[] = [];
  let cursor = 0;
  for (;;) {
    const newline = text.indexOf("\n", cursor);
    const lineEnd = newline < 0 ? text.length : newline;
    let trimmed = lineEnd;
    while (trimmed > cursor && (text[trimmed - 1] === " " || text[trimmed - 1] === "\t" || text[trimmed - 1] === "\r")) {
      trimmed -= 1;
    }
    for (let i = cursor; i < trimmed; i += 1) {
      normalized += text[i];
      origin.push(i);
    }
    if (newline < 0) return { normalized, origin };
    normalized += "\n";
    origin.push(newline);
    cursor = newline + 1;
  }
}

const PROPOSAL_PREVIEW_CONTEXT_LINES = 12;
const PROPOSAL_PREVIEW_CHAR_CAP = 6_000;

/**
 * 审批卡片必须能看见实际改动区。旧版发整篇前 6,000 字符：一次 51,714 字符的写入
 * 改的是第三个 runsql 块，用户在卡片里只看到 frontmatter 和前两个块，点了同意才
 * 发现改错了。
 *
 * 这里按行对齐掐掉首尾未变部分，只留命中区加上下文。省略标记的行数对两侧恒等
 * （prefix / suffix 是共有的），所以渲染端的 line diff 会把它们判成 equal 而不是
 * 凭空多出一对增删行。
 *
 * ponytail: 只处理单个连续命中区——多处分散修改会被合并成一个大窗口。要精确到
 * 每处再上真 diff hunk（renderer 的 buildDiffSegments 已经做了这件事）。
 */
function boundedEditPreview(
  oldContent: string,
  newContent: string,
): { oldContent: string; newContent: string } {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const start = Math.max(0, prefix - PROPOSAL_PREVIEW_CONTEXT_LINES);
  const window = (lines: string[]): string => {
    const end = Math.min(lines.length, lines.length - suffix + PROPOSAL_PREVIEW_CONTEXT_LINES);
    return [
      ...(start > 0 ? [`…[${start} unchanged lines above]`] : []),
      ...lines.slice(start, end),
      ...(end < lines.length ? [`…[${lines.length - end} unchanged lines below]`] : []),
    ].join("\n");
  };
  return {
    oldContent: truncate(window(oldLines), PROPOSAL_PREVIEW_CHAR_CAP),
    newContent: truncate(window(newLines), PROPOSAL_PREVIEW_CHAR_CAP),
  };
}

/**
 * 精确匹配失败时退回空白容错匹配：模型常从分页或截断的 read_note 复制片段，
 * 差异集中在 CRLF 与行尾空白，而不是内容本身。唯一性要求两种模式下都保留。
 */
function locateOldText(content: string, oldText: string): { start: number; end: number } | { error: string } {
  const ambiguous = "oldText appears more than once. Provide a larger unique oldText snippet.";
  const exact = content.indexOf(oldText);
  if (exact >= 0) {
    if (content.indexOf(oldText, exact + oldText.length) >= 0) return { error: ambiguous };
    return { start: exact, end: exact + oldText.length };
  }
  const haystack = normalizeForMatch(content);
  const needle = normalizeForMatch(oldText).normalized;
  const loose = needle ? haystack.normalized.indexOf(needle) : -1;
  if (loose < 0) {
    const anchor = oldText.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
    const hint = anchor
      ? `Its first non-blank line (${JSON.stringify(truncate(anchor, 120))}) appears ${content.split(anchor).length - 1} time(s) in the note.`
      : "oldText contains no non-blank line.";
    return {
      error: `oldText was not found in the note, even ignoring line-ending and trailing-whitespace differences. ${hint} Re-read the exact region with read_note and copy oldText verbatim instead of retrying the same snippet.`,
    };
  }
  if (haystack.normalized.indexOf(needle, loose + needle.length) >= 0) return { error: ambiguous };
  return { start: haystack.origin[loose], end: haystack.origin[loose + needle.length - 1] + 1 };
}

async function runProposeEdit(
  args: {
    targetId?: unknown;
    sql?: unknown;
    path?: unknown;
    newContent?: unknown;
    oldText?: unknown;
    newText?: unknown;
    description?: unknown;
  },
  ctx: AgentToolContext,
): Promise<ToolOutcome> {
  const hasRunsqlParams = args.targetId !== undefined || args.sql !== undefined;
  const hasNoteParams = args.path !== undefined || args.newContent !== undefined ||
    args.oldText !== undefined || args.newText !== undefined;
  if (hasRunsqlParams) {
    if (hasNoteParams) {
      return fail("Choose one edit target: pass targetId/sql for RunSQL, or note edit parameters, not both.");
    }
    return runProposeRunsqlEdit(args, ctx);
  }
  if (typeof args.path !== "string" || !args.path.trim()) {
    return fail("For a note edit, path must be a non-empty string. For RunSQL, pass targetId and sql.");
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
    const located = locateOldText(oldContent, args.oldText as string);
    if ("error" in located) return fail(located.error);
    nextContent = oldContent.slice(0, located.start) + (args.newText as string) + oldContent.slice(located.end);
  }
  const approved = await ctx.requestProposal({
    kind: "edit_note",
    payload: {
      notePath: args.path,
      description,
      ...boundedEditPreview(oldContent, nextContent),
    },
  });
  if (!approved) return fail("The user rejected this edit. Do not retry it as-is.");
  await vaultFs.writeFile(target, nextContent);
  const readBack = await vaultFs.readFile(target);
  if (readBack !== nextContent) {
    return fail(`Write-back check failed for ${args.path}: the file on disk does not match what was written.`);
  }
  notifyFileChanged(target);
  // 只说「字节写对了」。旧文案 "Wrote and verified" 会让模型（和用户）以为内容的
  // 正确性也被校验过，而这里只做了一次读回比对。
  return ok({
    message: `Wrote ${nextContent.length} chars to ${args.path}; re-read matches the bytes written. Content correctness is not checked.`,
    path: args.path,
    bytesWrittenMatch: true,
  });
}

async function runProposeRunsqlEdit(
  args: { targetId?: unknown; sql?: unknown; description?: unknown },
  ctx: AgentToolContext,
): Promise<ToolOutcome> {
  const targetId = typeof args.targetId === "string" ? args.targetId.trim() : "";
  const sql = typeof args.sql === "string" ? args.sql.trim() : "";
  if (!targetId) return fail("targetId must be a non-empty string.");
  if (!sql) return fail("sql must be a non-empty string.");
  const target = ctx.rewriteTargets?.get(targetId);
  if (!target) {
    const attached = [...(ctx.rewriteTargets?.keys() ?? [])];
    return fail(
      `This RunSQL target was not explicitly attached to the current request. ${
        attached.length
          ? `Attached targetIds: ${attached.join(", ")}. Resource catalog ids are not rewrite target ids.`
          : "No RunSQL target is attached at all: edit the note with path plus oldText/newText, or ask the user to attach the RunSQL block first."
      }`,
    );
  }
  if (sql === target.sql.trim()) return fail("The proposed SQL is unchanged.");
  const description = typeof args.description === "string" && args.description.trim()
    ? args.description.trim()
    : "Review the proposed RunSQL rewrite.";
  const approved = await ctx.requestProposal({
    kind: "runsql_rewrite",
    payload: {
      targetId,
      ...(target.sourcePath ? { notePath: target.sourcePath } : {}),
      description,
      oldContent: truncate(target.sql, 12_000),
      newContent: truncate(sql, 12_000),
      sql,
    },
  });
  if (!approved) return fail("The user rejected this RunSQL rewrite. Do not retry it as-is.");
  return ok({ targetId, approved: true, message: "The renderer applied the approved RunSQL rewrite." });
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

async function runCreatePlan(
  args: { steps?: unknown },
  ctx: AgentToolContext,
): Promise<ToolOutcome> {
  if (!ctx.plan) return fail("Execution plans are unavailable for this run.");
  const existing = ctx.plan.get();
  if (existing) {
    return ok({
      created: false,
      plan: existing,
      instruction: "A plan already exists. Use plan with action=update to record progress on it.",
    });
  }
  if (!Array.isArray(args.steps)) return fail("steps must be an array.");
  const snapshot = ctx.plan.create(args.steps as CreatePlanStep[]);
  await ctx.persistPlan?.(snapshot);
  return ok({ created: true, plan: snapshot });
}

async function runUpdatePlan(
  args: { stepId?: unknown; status?: unknown; evidence?: unknown; runId?: unknown },
  ctx: AgentToolContext,
): Promise<ToolOutcome> {
  if (!ctx.plan) return fail("Execution plans are unavailable for this run.");
  if (typeof args.stepId !== "string") return fail("stepId must be a string.");
  if (args.status !== "completed" && args.status !== "blocked" && args.status !== "skipped") {
    return fail("status must be completed, blocked, or skipped.");
  }
  const { snapshot, note } = ctx.plan.update({
    stepId: args.stepId,
    status: args.status,
    ...(typeof args.evidence === "string" ? { evidence: args.evidence } : {}),
    ...(typeof args.runId === "string" ? { runId: args.runId } : {}),
  });
  await ctx.persistPlan?.(snapshot);
  return ok(note ? { plan: snapshot, note } : snapshot);
}

function runGetPlan(ctx: AgentToolContext): ToolOutcome {
  if (!ctx.plan) return fail("Execution plans are unavailable for this run.");
  const snapshot = ctx.plan.get();
  return snapshot ? ok(snapshot) : ok({ plan: null, instruction: ctx.plan.formatForContext() });
}

async function runPlan(
  args: {
    action?: unknown;
    steps?: unknown;
    stepId?: unknown;
    status?: unknown;
    evidence?: unknown;
    runId?: unknown;
  },
  ctx: AgentToolContext,
): Promise<ToolOutcome> {
  if (args.action === "create") return await runCreatePlan(args, ctx);
  if (args.action === "update") return await runUpdatePlan(args, ctx);
  if (args.action === "get") return runGetPlan(ctx);
  return fail("action must be create, update, or get.");
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

/**
 * 同名工具连续失败的熔断阈值。遥测里出现过一个 run 内 `propose_edit` 连错 9 次、
 * `update_analysis_canvas` 连错 4 次，每次失败都要付一整轮模型往返。
 * 按 ADR-0017 整个 run 仍然只由用户取消，所以这里只拦住那一个工具；
 * ADR-0069 的探索类工具不在范围内，它们的失败是分析过程本身。
 */
const MAX_CONSECUTIVE_TOOL_FAILURES = 3;
/** `run_sql` 是 `run_query` 的别名，熔断豁免范围要和 ADR-0069 的探索类工具一致。 */
const UNBREAKABLE_TOOLS = new Set([
  ...DATA_ANALYSIS_TOOLS,
  "run_sql",
  "list_databases",
  "list_tables",
]);

/** 工具异常不该崩循环——统一在这里捕获并转成 role:tool 的 error 文本，回喂模型自愈。 */
export async function dispatchTool(
  name: string,
  rawArguments: string,
  ctx: AgentToolContext,
): Promise<ToolOutcome> {
  const exempt = UNBREAKABLE_TOOLS.has(name);
  const streak = ctx.run.toolFailureStreak;
  if (!exempt && (streak.get(name) ?? 0) >= MAX_CONSECUTIVE_TOOL_FAILURES) {
    return fail(
      `${name} has failed ${MAX_CONSECUTIVE_TOOL_FAILURES} times in a row in this run and is now blocked. ` +
        "Stop calling it: reach the goal another way, or answer the user with the evidence you already have and state what is missing.",
    );
  }
  const dataTool = exempt;
  if (dataTool && ctx.aiSettings.automaticAnalysisContractsEnabled && !ctx.run.analysis) {
    ctx.run.analysis = { runId: ctx.run.runId, version: 0, generation: "host", status: "observed",
      missingClaims: ["population", "metric", "granularity"], failedChecks: [], claims: [], checks: [], sources: [],
      coverage: { state: "unknown", total: null, processed: 0, unresolved: 0, unprocessed: 0, source: null, reason: "no_operation" }, previousVersions: 0, truncated: false };
  }
  const outcome = await dispatchToolCall(name, rawArguments, ctx);
  if (dataTool && ctx.aiSettings.automaticAnalysisContractsEnabled && ctx.run.analysis) {
    const snapshot = ctx.run.analysis;
    if (!outcome.ok && name === "execute_python") {
      snapshot.status = /workspace_lost/i.test(outcome.text) ? "lost" : "partial_mutation_possible";
      snapshot.coverage.state = "unknown";
      snapshot.coverage.reason = snapshot.status === "lost" ? "workspace_lost" : "execution_failed";
    }
    const facts = [...(ctx.analysisRuns?.entries() ?? [])].filter(([, v]) => v.kind === "query")
      .map(([ref, v]) => ({ ref, rowCount: v.rowCount, incomplete: v.incomplete === true, previewTruncated: v.truncated }));
    const sources = new Map([...snapshot.sources, ...facts].map((s) => [s.ref, s]));
    snapshot.sources = [...sources.values()].slice(-16);
    snapshot.truncated ||= sources.size > 16;
    let body: Record<string, unknown>;
    try { const parsed: unknown = JSON.parse(outcome.text); body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { result: parsed }; }
    catch { body = outcome.ok ? { resultPreview: outcome.text, truncated: true } : { error: outcome.text }; }
    outcome.text = JSON.stringify({ ...body, analysis: snapshot });
  }
  if (!exempt) {
    if (outcome.ok) streak.delete(name);
    else streak.set(name, (streak.get(name) ?? 0) + 1);
  }
  return outcome;
}

async function dispatchToolCall(
  name: string,
  rawArguments: string,
  ctx: AgentToolContext,
): Promise<ToolOutcome> {
  const args = parseArgs(rawArguments);
  try {
    switch (name as AgentToolName) {
      case "list_catalog":
        return await runListCatalog(args, ctx);
      /** @deprecated Old session trace compatibility. */
      case "list_databases":
        return await runListDatabases(args, ctx);
      /** @deprecated Old session trace compatibility. */
      case "list_tables":
        return await runListTables(args, ctx);
      case "search_tables":
        return await runSearchTables(args, ctx);
      case "get_table_schema":
        return await runGetTableSchema(args, ctx);
      case "run_query":
      case "run_sql":
        return await runQuery(args, ctx);
      case "execute_python":
        return await runExecutePython(args, ctx);
      case "create_chart":
        return runCreateChart(args, ctx);
      case "create_analysis_canvas":
        return await runCreateAnalysisCanvas(args, ctx);
      case "read_analysis_canvas":
        return await runReadAnalysisCanvas(args, ctx);
      case "update_analysis_canvas":
        return await runUpdateAnalysisCanvas(args, ctx);
      case "search_vault":
        return await runSearchVault(args, ctx);
      case "search_sql_usage":
        return await runSearchSqlUsage(args, ctx);
      case "list_vault_files":
        return await runListVaultFiles(args, ctx);
      case "read_note":
        return await runReadNote(args, ctx);
      case "plan":
        return await runPlan(args, ctx);
      /** @deprecated Old session trace compatibility. */
      case "create_plan":
        return await runCreatePlan(args, ctx);
      /** @deprecated Old session trace compatibility. */
      case "update_plan":
        return await runUpdatePlan(args, ctx);
      /** @deprecated Old session trace compatibility. */
      case "get_plan":
        return runGetPlan(ctx);
      case "load_skill":
        return await runLoadSkill(args, ctx);
      case "search_skills":
        return await runSearchSkills(args, ctx);
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
