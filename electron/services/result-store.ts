/**
 * SQLite 结果存储（使用 better-sqlite3）。
 *
 * 路径：`<vault>/.stela.sqlite` —— 与 legacy Obsidian 插件 + 上一代 Tauri 版本对齐，
 * 同一 vault 切换运行时无需迁移即可复用。
 *
 * Schema：
 *   runs(run_id PK, block_id, sql, status, message, started_at, elapsed_ms, row_count, connection_name)
 *   result_schemas(run_id PK, columns_json)
 *   result_rows(run_id, row_index, row_json) PK=(run_id, row_index)
 *
 * Legacy 兼容：
 *   - 若 runs 仍是老 schema（含 executed_at 列），先把三张 legacy 表 rename 到 legacy_*，
 *     再创建新 schema，最后用 INSERT OR IGNORE 把数据 copy 到新表（幂等）。
 *   - copy 触发条件是 `legacy_runs` 表存在，与新表是否已建无关——兼容半迁移态。
 *
 * better-sqlite3 是同步 API：所有方法在 main 进程同步执行；写入若量大请在 worker_thread
 * 里跑（M3 写入量都在合理范围，本期同步即可）。
 */

import Database from "better-sqlite3";
import path from "node:path";
import { promises as fs } from "node:fs";

import { AppError } from "@shared/errors";
import type { ColumnDef, RowsPage, RunRecord } from "@shared/types";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS runs (
    run_id           TEXT PRIMARY KEY,
    block_id         TEXT NOT NULL,
    sql              TEXT NOT NULL,
    status           TEXT NOT NULL,
    message          TEXT,
    started_at       INTEGER NOT NULL,
    elapsed_ms       INTEGER NOT NULL,
    row_count        INTEGER NOT NULL,
    connection_name  TEXT NOT NULL,
    note_path        TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_block_id ON runs(block_id);
CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at);

CREATE TABLE IF NOT EXISTS result_schemas (
    run_id        TEXT PRIMARY KEY,
    columns_json  TEXT NOT NULL,
    FOREIGN KEY(run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS result_rows (
    run_id     TEXT NOT NULL,
    row_index  INTEGER NOT NULL,
    row_json   TEXT NOT NULL,
    PRIMARY KEY(run_id, row_index),
    FOREIGN KEY(run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);

-- 执行历史 JSONL 导入游标（v2 Git+JSONL 同步）：每行记录一个 history_*.jsonl
-- 文件已消费到的字节 offset。SQLite 在该模型下是本机查询缓存，真相源是 JSONL；
-- 游标让 vault open / git pull 后只需增量续读新追加的行，而非全量重扫。
CREATE TABLE IF NOT EXISTS journal_cursors (
    file_name      TEXT PRIMARY KEY,
    imported_bytes INTEGER NOT NULL DEFAULT 0,
    updated_at     INTEGER NOT NULL DEFAULT 0
);
`;

let current: { db: Database.Database; vaultPath: string } | null = null;

export async function open(vaultPath: string): Promise<void> {
  if (current && current.vaultPath === vaultPath) return;
  if (current) {
    try {
      current.db.close();
    } catch {
      /* ignore */
    }
    current = null;
  }
  await fs.mkdir(vaultPath, { recursive: true }).catch(() => undefined);
  const dbPath = path.join(vaultPath, ".stela.sqlite");
  let db: Database.Database;
  try {
    db = new Database(dbPath);
  } catch (err) {
    throw new AppError(
      "storage_open_failed",
      `open sqlite failed: ${(err as Error).message}`,
    );
  }
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  migrateLegacyIfNeeded(db);
  db.exec(SCHEMA_SQL);
  copyLegacyIntoNewIfPresent(db);
  ensureRunsNotePathColumn(db);

  current = { db, vaultPath };
}

/**
 * v0.2 #5 增量：若现有 runs 表是早期 schema（没有 note_path 列），追加一列。
 *
 * 必须在 SCHEMA_SQL 之后调用——SCHEMA_SQL 的 CREATE TABLE IF NOT EXISTS 不会
 * 给已存在的旧表追列。`ALTER TABLE ... ADD COLUMN` 默认 NULL，老 run 行天然
 * 拿到 NULL，与 RunRecord.notePath: string | null 语义一致。
 */
function ensureRunsNotePathColumn(db: Database.Database): void {
  if (!tableExists(db, "runs")) return;
  if (tableHasColumn(db, "runs", "note_path")) return;
  db.exec(`ALTER TABLE runs ADD COLUMN note_path TEXT`);
}

function ensureOpen(): Database.Database {
  if (!current) {
    throw new AppError(
      "not_open",
      "storage not opened; call storage.open(vaultPath) first",
    );
  }
  return current.db;
}

/**
 * 暴露当前 SQLite 连接给 sync-store 等同 vault 内的兄弟模块复用。
 *
 * 边界：调用方仅能在 storage.open(vaultPath) 之后用；切 vault 时旧连接会被
 * close 替换，所以**不要**把返回值缓存到模块级变量。
 */
export function getDb(): Database.Database {
  return ensureOpen();
}

/** 当前打开的 vault path；sync-service 用来做读写边界校验。 */
export function getCurrentVaultPath(): string | null {
  return current?.vaultPath ?? null;
}

export function saveRun(record: RunRecord): void {
  const db = ensureOpen();
  // 兼容旧远端包：v0.2 加列前 push 的 result object 反序列化后 record.notePath
  // 是 undefined；better-sqlite3 named-param 不接受 undefined（会抛 TypeError）。
  // 这里规整成 null，保持与"老 run 没有 path"语义一致。
  const normalized: RunRecord = {
    ...record,
    notePath: record.notePath ?? null,
  };
  db.prepare(
    `INSERT OR REPLACE INTO runs
     (run_id, block_id, sql, status, message, started_at, elapsed_ms, row_count, connection_name, note_path)
     VALUES (@runId, @blockId, @sql, @status, @message, @startedAt, @elapsedMs, @rowCount, @connectionName, @notePath)`,
  ).run(normalized);
}

export function saveSchema(runId: string, columns: ColumnDef[]): void {
  const db = ensureOpen();
  db.prepare(
    `INSERT OR REPLACE INTO result_schemas (run_id, columns_json) VALUES (?, ?)`,
  ).run(runId, JSON.stringify(columns));
}

/**
 * 写入一批结果行。
 *
 * `rowOffset` 用于分块写入：renderer 在大结果集（比如 5w 行）下会把 rows 切成
 * 多个 batch 顺序调用，每次传当前 batch 在整体里的起始 row_index，main 端用
 * `rowOffset + i` 作为 row_index 写入。这样既保证 (run_id, row_index) 主键唯一，
 * 又把单次 IPC 结构化克隆与单次事务的耗时压在可接受区间内（默认 5000 行/批）。
 *
 * 兼容性：rowOffset 缺省 0，旧调用（一次性 saveRows 整张结果）行为不变。
 */
export function saveRows(
  runId: string,
  rows: unknown[][],
  rowOffset = 0,
): void {
  const db = ensureOpen();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO result_rows (run_id, row_index, row_json) VALUES (?, ?, ?)`,
  );
  const tx = db.transaction((rs: unknown[][]) => {
    for (let i = 0; i < rs.length; i++) {
      stmt.run(runId, rowOffset + i, JSON.stringify(rs[i]));
    }
  });
  tx(rows);
}

export function queryPage(
  runId: string,
  offset: number,
  limit: number,
): RowsPage {
  const db = ensureOpen();
  const total = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM result_rows WHERE run_id = ?`)
      .get(runId) as { n: number }
  ).n;
  const rows = (
    db
      .prepare(
        `SELECT row_json FROM result_rows
       WHERE run_id = ?
       ORDER BY row_index ASC
       LIMIT ? OFFSET ?`,
      )
      .all(runId, limit, offset) as { row_json: string }[]
  ).map((r) => {
    return JSON.parse(r.row_json) as unknown[];
  });
  return { offset, limit, rows, total };
}

export function getSchema(runId: string): ColumnDef[] {
  const db = ensureOpen();
  const row = db
    .prepare(`SELECT columns_json FROM result_schemas WHERE run_id = ?`)
    .get(runId) as { columns_json?: string } | undefined;
  if (!row?.columns_json) return [];
  try {
    return JSON.parse(row.columns_json) as ColumnDef[];
  } catch {
    return [];
  }
}

/**
 * 列出所有 run 记录（按 startedAt 倒序）。给 sync-service 遍历 push 用，
 * 也给将来的 Run History 视图（v0.2 #5）复用。
 */
export function listRuns(): RunRecord[] {
  const db = ensureOpen();
  const rows = db
    .prepare(
      `SELECT run_id          AS runId,
              block_id        AS blockId,
              sql             AS sql,
              status          AS status,
              message         AS message,
              started_at      AS startedAt,
              elapsed_ms      AS elapsedMs,
              row_count       AS rowCount,
              connection_name AS connectionName,
              note_path       AS notePath
       FROM runs
       ORDER BY started_at DESC`,
    )
    .all() as RunRecord[];
  return rows;
}

export interface ListRunsByBlockOptions {
  limit?: number;
  offset?: number;
  status?: "ok" | "err" | "all";
}

/**
 * 列出某个 block 的历史 run（按 startedAt 倒序）。Block 内 Run Rail / diff 用。
 * 走 idx_runs_block_id 索引。
 */
export function listRunsByBlockId(
  blockId: string,
  options: ListRunsByBlockOptions = {},
): RunRecord[] {
  const db = ensureOpen();
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;
  const status = options.status ?? "all";
  const statusFilter = status === "all" ? "" : "AND status = @status";
  const rows = db
    .prepare(
      `SELECT run_id          AS runId,
              block_id        AS blockId,
              sql             AS sql,
              status          AS status,
              message         AS message,
              started_at      AS startedAt,
              elapsed_ms      AS elapsedMs,
              row_count       AS rowCount,
              connection_name AS connectionName,
              note_path       AS notePath
       FROM runs
       WHERE block_id = @blockId ${statusFilter}
       ORDER BY started_at DESC
       LIMIT @limit OFFSET @offset`,
    )
    .all({ blockId, status, limit, offset }) as RunRecord[];
  return rows;
}

export function getRun(runId: string): RunRecord | null {
  const db = ensureOpen();
  const row = db
    .prepare(
      `SELECT run_id          AS runId,
              block_id        AS blockId,
              sql             AS sql,
              status          AS status,
              message         AS message,
              started_at      AS startedAt,
              elapsed_ms      AS elapsedMs,
              row_count       AS rowCount,
              connection_name AS connectionName,
              note_path       AS notePath
       FROM runs WHERE run_id = ?`,
    )
    .get(runId) as RunRecord | undefined;
  return row ?? null;
}

/** 取一个 run 的全部行（不分页）。v0.2 push results 用；上限由远端对象大小控制。 */
export function getAllRows(runId: string): unknown[][] {
  const db = ensureOpen();
  const rows = db
    .prepare(
      `SELECT row_json FROM result_rows
       WHERE run_id = ?
       ORDER BY row_index ASC`,
    )
    .all(runId) as { row_json: string }[];
  return rows.map((r) => JSON.parse(r.row_json) as unknown[]);
}

/** 删 keepDays 天之前的所有 run（FK 级联删 schemas / rows） */
export function cleanup(keepDays: number): number {
  const db = ensureOpen();
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  const info = db.prepare(`DELETE FROM runs WHERE started_at < ?`).run(cutoff);
  return Number(info.changes);
}

/**
 * 删 startedAt 小于 cutoff（Unix epoch ms）的 run。
 * 与 `cleanup(keepDays)` 区别：cutoff 由 caller 计算，避免重复一遍"今天-N天"的换算；
 * journal cleanup 流程会先算好 cutoff、删 JSONL 行，再用同一 cutoff 删缓存。
 */
export function deleteRunsBefore(cutoff: number): number {
  const db = ensureOpen();
  const info = db.prepare(`DELETE FROM runs WHERE started_at < ?`).run(cutoff);
  return Number(info.changes);
}

/**
 * 清空所有 journal 游标。journal 重写后调用：下次 incremental import 从 0 开始
 * 重扫存活行，INSERT OR IGNORE 自然去重。
 */
export function resetJournalCursors(): void {
  const db = ensureOpen();
  db.exec(`DELETE FROM journal_cursors;`);
}

export function close(): void {
  if (current) {
    try {
      current.db.close();
    } catch {
      /* ignore */
    }
    current = null;
  }
}

// ---------- 执行历史 JSONL 导入（v2 Git+JSONL 同步） ----------

/** 一个 JSONL 行反序列化后的完整 run 包。 */
export interface RunPackage {
  record: RunRecord;
  columns: ColumnDef[];
  rows: unknown[][];
}

/** 某个 runId 是否已在本机缓存中。journal 导入用来跳过已存在的 run。 */
export function runExists(runId: string): boolean {
  const db = ensureOpen();
  const r = db
    .prepare(`SELECT 1 FROM runs WHERE run_id = ? LIMIT 1`)
    .get(runId) as { 1: number } | undefined;
  return r !== undefined;
}

/**
 * 把一个 run 包写入缓存（INSERT OR IGNORE，幂等）。已存在则整体跳过并返回 false。
 * 用于 journal 增量导入；本地实时执行仍走 saveRun/saveSchema/saveRows。
 */
export function importRunPackage(pkg: RunPackage): boolean {
  const db = ensureOpen();
  if (runExists(pkg.record.runId)) return false;
  const record: RunRecord = {
    ...pkg.record,
    notePath: pkg.record.notePath ?? null,
  };
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO runs
       (run_id, block_id, sql, status, message, started_at, elapsed_ms, row_count, connection_name, note_path)
       VALUES (@runId, @blockId, @sql, @status, @message, @startedAt, @elapsedMs, @rowCount, @connectionName, @notePath)`,
    ).run(record);
    if (pkg.columns.length > 0) {
      db.prepare(
        `INSERT OR IGNORE INTO result_schemas (run_id, columns_json) VALUES (?, ?)`,
      ).run(record.runId, JSON.stringify(pkg.columns));
    }
    const rowStmt = db.prepare(
      `INSERT OR IGNORE INTO result_rows (run_id, row_index, row_json) VALUES (?, ?, ?)`,
    );
    for (let i = 0; i < pkg.rows.length; i++) {
      rowStmt.run(record.runId, i, JSON.stringify(pkg.rows[i]));
    }
  });
  tx();
  return true;
}

export function getJournalCursor(fileName: string): number {
  const db = ensureOpen();
  const r = db
    .prepare(
      `SELECT imported_bytes AS n FROM journal_cursors WHERE file_name = ?`,
    )
    .get(fileName) as { n: number } | undefined;
  return r?.n ?? 0;
}

export function setJournalCursor(fileName: string, bytes: number): void {
  const db = ensureOpen();
  db.prepare(
    `INSERT INTO journal_cursors (file_name, imported_bytes, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(file_name) DO UPDATE SET imported_bytes = excluded.imported_bytes,
                                          updated_at = excluded.updated_at`,
  ).run(fileName, bytes, Date.now());
}

/**
 * 全量重建缓存：清空 runs（FK 级联清 schemas / rows）与所有 journal 游标。
 * 调用方随后会触发一次全量 journal import。
 */
export function clearResultCache(): void {
  const db = ensureOpen();
  const tx = db.transaction(() => {
    db.exec(`DELETE FROM runs;`);
    db.exec(`DELETE FROM journal_cursors;`);
  });
  tx();
}

// ---------- Legacy 迁移 ----------

function tableHasColumn(
  db: Database.Database,
  table: string,
  column: string,
): boolean {
  // PRAGMA 表名不能参数化；table 来自 hardcoded 常量，无注入风险
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return rows.some((r) => r.name === column);
}

function tableExists(db: Database.Database, table: string): boolean {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?`,
    )
    .get(table) as { n: number };
  return r.n > 0;
}

function migrateLegacyIfNeeded(db: Database.Database): void {
  if (!tableExists(db, "runs")) return;
  if (!tableHasColumn(db, "runs", "executed_at")) return;
  // legacy schema 探测到 → rename 三张表（保留备份）
  db.exec(`
    ALTER TABLE runs RENAME TO legacy_runs;
    ALTER TABLE result_schemas RENAME TO legacy_result_schemas;
    ALTER TABLE result_rows RENAME TO legacy_result_rows;
  `);
}

function copyLegacyIntoNewIfPresent(db: Database.Database): void {
  if (!tableExists(db, "legacy_runs")) return;

  // legacy executed_at: 'YYYY-MM-DD HH:MM:SS' (本地时区裸串)
  // strftime('%s', x) 按 UTC 解释 → 秒；乘 1000 得毫秒。
  // 解析失败 → 0；其它 NOT NULL 列用 COALESCE 兜底。
  db.exec(`
    INSERT OR IGNORE INTO runs
      (run_id, block_id, sql, status, message,
       started_at, elapsed_ms, row_count, connection_name)
    SELECT
      run_id,
      COALESCE(block_id, ''),
      COALESCE(sql_text, ''),
      COALESCE(status, 'unknown'),
      NULLIF(COALESCE(error_message, ''), ''),
      CAST(COALESCE(strftime('%s', executed_at), '0') AS INTEGER) * 1000,
      COALESCE(elapsed_ms, 0),
      COALESCE(row_count, 0),
      COALESCE(connection_id, '')
    FROM legacy_runs;
  `);

  if (tableExists(db, "legacy_result_rows")) {
    db.exec(`
      INSERT OR IGNORE INTO result_rows (run_id, row_index, row_json)
      SELECT run_id, row_index, row_values_json
      FROM legacy_result_rows;
    `);
  }

  if (!tableExists(db, "legacy_result_schemas")) return;
  // 老 schema 是每列一行；聚合成 columns_json 单行 JSON 数组
  const rows = db
    .prepare(
      `SELECT run_id,
              COALESCE(column_name, '') AS name,
              COALESCE(column_type, '') AS type
       FROM legacy_result_schemas
       WHERE run_id NOT IN (SELECT run_id FROM result_schemas)
       ORDER BY run_id, ordinal`,
    )
    .all() as Array<{ run_id: string; name: string; type: string }>;

  const insert = db.prepare(
    `INSERT OR IGNORE INTO result_schemas (run_id, columns_json) VALUES (?, ?)`,
  );

  let currentId: string | null = null;
  let buf: Array<{ name: string; typeName: string }> = [];
  const flush = () => {
    if (currentId && buf.length > 0) {
      insert.run(currentId, JSON.stringify(buf));
    }
    buf = [];
  };
  for (const r of rows) {
    if (currentId !== r.run_id) {
      flush();
      currentId = r.run_id;
    }
    buf.push({ name: r.name, typeName: r.type });
  }
  flush();
}
