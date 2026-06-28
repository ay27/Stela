/**
 * MCP 工具集（只读）。
 *
 * 暴露给外部 LLM（Claude Desktop / Cursor 等）的工具：
 *   - search_notes        — 语义检索 vault（dense + BM25 + RRF）
 *   - read_note           — 读 markdown 全文
 *   - read_block          — 读某个 runsql block（含 SQL + result first row）
 *   - list_runs           — 列出 .stela.sqlite 里的 runs（带 SQL / status / row_count）
 *   - query_result_page   — 分页读 result_rows
 *   - read_result_schema  — 读 result_schemas
 *   - get_backlinks       — 读某文件的反向链接
 *
 * 设计原则：
 *   - **只读**：不暴露 write / move / delete
 *   - **vault 锁死**：所有路径输入走 `ensureWithinVault`
 *   - **zod schema 全覆盖**：MCP 协议层 + 业务输入双校验
 *   - **错误归一化**：业务层抛 AppError，包装成 MCP error code
 *
 * 这个文件**同时被 main 进程与 MCP child process 引用**：
 *   - main 端：仅 schema 用（生成 config snippet + UI 显示工具列表）
 *   - child 端：runtime 真正执行
 *
 * 因此**不**导入 main-only 的 vault-context；vaultPath 通过参数注入。
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { z } from "zod";

import { AppError } from "@shared/errors";

const stringPath = z.string().min(1).max(8192);

export const TOOL_SCHEMAS = {
  search_notes: {
    description:
      "Hybrid 语义检索当前 vault：dense vector + BM25 + RRF。返回相关 chunk 列表（含文件路径 / heading / snippet / score）。query 可以是任何自然语言。",
    inputSchema: z.object({
      query: z.string().min(1).max(2000),
      topK: z.number().int().min(1).max(50).optional(),
      mode: z.enum(["hybrid", "dense", "keyword"]).optional(),
    }),
  },
  read_note: {
    description:
      "读取 vault 内某个 markdown 笔记的完整内容（含 frontmatter）。path 必须落在 vault 内。",
    inputSchema: z.object({
      path: stringPath,
    }),
  },
  read_block: {
    description:
      "读取 vault 内某个 runsql block 的 SQL + 元信息（含 first row sample / row count / elapsed）。",
    inputSchema: z.object({
      path: stringPath,
      blockId: z.string().min(1).max(256),
    }),
  },
  list_runs: {
    description:
      "列出当前 vault 的 .stela.sqlite 中保存的所有 SQL run（最近优先）。可选过滤：connectionName / blockId / 限制条数。",
    inputSchema: z.object({
      connectionName: z.string().optional(),
      blockId: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
  },
  query_result_page: {
    description:
      "分页读取某个 run 的结果行（result_rows）。row_json 已解码为数组。",
    inputSchema: z.object({
      runId: z.string().min(1).max(256),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(500).default(50),
    }),
  },
  read_result_schema: {
    description: "读取某个 run 的列定义（result_schemas.columns_json 解析）。",
    inputSchema: z.object({
      runId: z.string().min(1).max(256),
    }),
  },
  get_backlinks: {
    description:
      "读取指向某个 vault 文件的反向链接（[[target]] 引用源 + line / column / snippet）。target 接受 vault 根相对 POSIX 路径，带或不带扩展名都可以。",
    inputSchema: z.object({
      target: z.string().min(1).max(2048),
    }),
  },
} as const;

export type ToolName = keyof typeof TOOL_SCHEMAS;

export interface ToolContext {
  vaultPath: string;
}

// ---------- 实现：search_notes ----------
//
// child process 内部直接复用 retriever。child 启动时调 `bootstrapChild(vaultPath)`
// 完成 indexer + embedder 初始化；这里假定已就绪。

import * as knowledge from "../knowledge";

export async function tool_search_notes(
  ctx: ToolContext,
  args: z.infer<(typeof TOOL_SCHEMAS)["search_notes"]["inputSchema"]>,
): Promise<unknown> {
  void ctx; // active vault 由 child runtime 全局保持
  const hits = await knowledge.search(args.query, {
    topK: args.topK,
    mode: args.mode,
  });
  return {
    query: args.query,
    mode: args.mode ?? "hybrid",
    hits: hits.map((h) => ({
      relPath: h.relPath,
      title: h.title,
      heading: h.headingText,
      sourceKind: h.sourceKind,
      blockId: h.blockId,
      snippet: h.snippet,
      score: round(h.score),
      distance: h.distance === null ? null : round(h.distance),
      bm25: h.bm25 === null ? null : round(h.bm25),
    })),
  };
}

// ---------- 实现：read_note ----------

export async function tool_read_note(
  ctx: ToolContext,
  args: z.infer<(typeof TOOL_SCHEMAS)["read_note"]["inputSchema"]>,
): Promise<unknown> {
  const abs = await resolveInVault(ctx.vaultPath, args.path);
  const stat = await fs.stat(abs);
  if (!stat.isFile()) {
    throw new AppError("not_a_file", `not a regular file: ${abs}`);
  }
  if (stat.size > 4 * 1024 * 1024) {
    throw new AppError(
      "file_too_large",
      `file too large for MCP read: ${stat.size}B`,
    );
  }
  const content = await fs.readFile(abs, "utf-8");
  return {
    relPath: relativeOf(ctx.vaultPath, abs),
    size: stat.size,
    mtime: stat.mtimeMs,
    content,
  };
}

// ---------- 实现：read_block ----------

import { extractRunsqlBlocks } from "../knowledge/chunker";

export async function tool_read_block(
  ctx: ToolContext,
  args: z.infer<(typeof TOOL_SCHEMAS)["read_block"]["inputSchema"]>,
): Promise<unknown> {
  const abs = await resolveInVault(ctx.vaultPath, args.path);
  const content = await fs.readFile(abs, "utf-8");
  const blocks = extractRunsqlBlocks(content);
  const hit = blocks.find((b) => b.blockId === args.blockId);
  if (!hit) {
    throw new AppError("block_not_found", `block ${args.blockId} not found in ${abs}`);
  }
  return {
    relPath: relativeOf(ctx.vaultPath, abs),
    blockId: hit.blockId,
    sql: hit.sql,
    context: hit.markdownContext,
    detail: hit.detail,
  };
}

// ---------- 实现：result-store 系列 ----------

let resultDb: { db: Database.Database; dbPath: string } | null = null;

function getResultDb(ctx: ToolContext): Database.Database {
  const dbPath = path.join(ctx.vaultPath, ".stela.sqlite");
  if (resultDb && resultDb.dbPath === dbPath) return resultDb.db;
  if (resultDb) {
    try {
      resultDb.db.close();
    } catch {
      /* noop */
    }
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: false });
  resultDb = { db, dbPath };
  return db;
}

export async function tool_list_runs(
  ctx: ToolContext,
  args: z.infer<(typeof TOOL_SCHEMAS)["list_runs"]["inputSchema"]>,
): Promise<unknown> {
  const db = getResultDb(ctx);
  const filters: string[] = [];
  const params: unknown[] = [];
  if (args.connectionName) {
    filters.push("connection_name = ?");
    params.push(args.connectionName);
  }
  if (args.blockId) {
    filters.push("block_id = ?");
    params.push(args.blockId);
  }
  const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  const limit = args.limit ?? 50;
  const rows = db
    .prepare(
      `SELECT run_id, block_id, sql, status, message, started_at, elapsed_ms, row_count, connection_name, note_path
       FROM runs ${where}
       ORDER BY started_at DESC
       LIMIT ?`,
    )
    .all(...params, limit);
  return { rows };
}

export async function tool_query_result_page(
  ctx: ToolContext,
  args: z.infer<(typeof TOOL_SCHEMAS)["query_result_page"]["inputSchema"]>,
): Promise<unknown> {
  const db = getResultDb(ctx);
  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM result_rows WHERE run_id = ?`)
    .get(args.runId) as { n: number } | undefined;
  const rows = db
    .prepare(
      `SELECT row_json FROM result_rows
       WHERE run_id = ?
       ORDER BY row_index ASC
       LIMIT ? OFFSET ?`,
    )
    .all(args.runId, args.limit, args.offset) as Array<{ row_json: string }>;
  return {
    runId: args.runId,
    offset: args.offset,
    limit: args.limit,
    total: total?.n ?? 0,
    rows: rows.map((r) => {
      try {
        return JSON.parse(r.row_json) as unknown[];
      } catch {
        return null;
      }
    }),
  };
}

export async function tool_read_result_schema(
  ctx: ToolContext,
  args: z.infer<(typeof TOOL_SCHEMAS)["read_result_schema"]["inputSchema"]>,
): Promise<unknown> {
  const db = getResultDb(ctx);
  const row = db
    .prepare(`SELECT columns_json FROM result_schemas WHERE run_id = ?`)
    .get(args.runId) as { columns_json: string } | undefined;
  if (!row) {
    return { runId: args.runId, columns: [] };
  }
  let cols: unknown[] = [];
  try {
    cols = JSON.parse(row.columns_json) as unknown[];
  } catch {
    cols = [];
  }
  return { runId: args.runId, columns: cols };
}

// ---------- 实现：get_backlinks ----------
//
// 注意：child process 与 main 是两个进程，main 进程的 vault-index in-memory 倒排表
// 在 child 里拿不到。child 走"读 vault 文件 + 自己扫一遍"会很慢；v0.4 简化方案：
// child 启动期开一个轻量索引（同 vault-index 但不广播），直接 import 复用其纯函数。
//
// 为了避免环路依赖与重复扫描，这里**仅扫描发起 backlink 查询的目标所在目录**作为
// scope（限制扇出）。完整的 vault-wide backlinks 等 v0.5 加 MCP daemon 模式时再补。

export async function tool_get_backlinks(
  ctx: ToolContext,
  args: z.infer<(typeof TOOL_SCHEMAS)["get_backlinks"]["inputSchema"]>,
): Promise<unknown> {
  void ctx;
  // 目前未实现 vault-wide backlinks（child 进程无 in-memory 索引）。
  // 返回结构化空数组 + reason，让 LLM 自适应；UI 上的 Settings 会标记本工具为 stub。
  return {
    target: args.target,
    sources: [],
    note: "backlinks scanning from MCP child not implemented yet; use search_notes with the target name as a query for an approximate alternative.",
  };
}

// ---------- 工具调度 ----------

export type ToolHandler<K extends ToolName> = (
  ctx: ToolContext,
  args: z.infer<(typeof TOOL_SCHEMAS)[K]["inputSchema"]>,
) => Promise<unknown>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TOOL_HANDLERS: Record<ToolName, ToolHandler<any>> = {
  search_notes: tool_search_notes,
  read_note: tool_read_note,
  read_block: tool_read_block,
  list_runs: tool_list_runs,
  query_result_page: tool_query_result_page,
  read_result_schema: tool_read_result_schema,
  get_backlinks: tool_get_backlinks,
};

export function listToolNames(): ToolName[] {
  return Object.keys(TOOL_SCHEMAS) as ToolName[];
}

// ---------- helpers ----------

async function resolveInVault(
  vaultPath: string,
  candidate: string,
): Promise<string> {
  const target = path.isAbsolute(candidate)
    ? candidate
    : path.join(vaultPath, candidate);
  let vaultReal: string;
  try {
    vaultReal = await fs.realpath(vaultPath);
  } catch {
    throw new AppError("invalid_vault", `vault path missing: ${vaultPath}`);
  }
  let probe: string;
  try {
    probe = await fs.realpath(target);
  } catch {
    throw new AppError("not_found", `path does not exist: ${target}`);
  }
  if (probe !== vaultReal && !probe.startsWith(vaultReal + path.sep)) {
    throw new AppError(
      "outside_vault",
      `path '${probe}' escapes vault '${vaultReal}'`,
    );
  }
  return probe;
}

function relativeOf(vaultPath: string, abs: string): string {
  return path.relative(vaultPath, abs).replace(/\\/g, "/");
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
