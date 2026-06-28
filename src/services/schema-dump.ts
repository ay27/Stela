/**
 * 「同步表结构到 Markdown」核心逻辑。
 *
 * 给定一个已保存的连接（`ConnectionEntry`）和目标目录，抓取所有业务库里每张表的
 * `SHOW CREATE TABLE` DDL，格式化成规整 markdown 写入 `${schemaDir}/db.table.md`。
 *
 * 设计约束与取舍：
 * - 只拉 **业务 schema**：information_schema / performance_schema / mysql / sys 等系统库
 *   直接跳过，避免把无意义的 DDL 全塞进用户目录。
 * - 并发度固定为 4：MySQL 对 `SHOW CREATE TABLE` 几乎免费，但我们不想把用户的
 *   连接池打满。用自带的 pMap 避免引 p-limit。
 * - 单张表失败（权限不足 / VIEW definer 丢失 / 表在枚举过程中被删）不中断整体，
 *   记入 `failed` 列表继续后续；失败表对应的 md 文件 **不写**，保留旧版本（如果有）。
 * - 不做 prune：连接里删掉的表对应的旧 md 会残留；做成显式操作，这次不做。
 * - 走 connector bridge 执行 schema 查询，**不**落
 *   runs/result_schemas/result_rows；这次 dump 不会污染历史记录。
 */

import type { IConnectorRegistry, QueryResult } from "@/contracts";
import type { ConnectionEntry } from "@/services/connections";
import { electronConnectorRegistry } from "@/services/connectors/electron-connector";
import { writeFile } from "@/services/fs-write";

/** 命令参数 / 结果 ---------------------------------------------------------- */

export interface DumpOptions {
  connectionName: string;
  entry: ConnectionEntry;
  /** 绝对路径；目录必须已经存在（由调用侧选/校验） */
  schemaDir: string;
  /** 进度回调，每开始抓一张表前调用一次 */
  onProgress?: (p: DumpProgress) => void;
  /**
   * 依赖注入口，方便测试替换。运行时调用侧传 `electronConnectorRegistry` 和
   * `writeFile`；单测替换成内存 mock。
   */
  deps?: {
    registry?: Pick<IConnectorRegistry, "listDatabases" | "listTables" | "execute">;
    writeFile?: (path: string, contents: string) => Promise<void>;
    /** 时间戳注入，保证测试里 markdown header 里的时间稳定 */
    now?: () => Date;
  };
}

export interface DumpProgress {
  /** 1-based index */
  index: number;
  total: number;
  db: string;
  table: string;
  phase: "fetch" | "write" | "error";
}

export interface DumpFailure {
  db: string;
  table: string;
  error: string;
}

export interface DumpReport {
  ok: number;
  failed: DumpFailure[];
  /** 目标目录 */
  outDir: string;
  /** 涉及到的 (db, table) 总数；`ok + failed.length = total` */
  total: number;
}

/** 过滤规则：MySQL 系统库 + 信息库 */
const SYSTEM_SCHEMAS: ReadonlySet<string> = new Set([
  "information_schema",
  "performance_schema",
  "mysql",
  "sys",
]);

/**
 * 并发池（手写 p-limit 的最小版本）。
 * - 保持原 items 顺序的迭代，不需要重排结果。
 * - 单个任务抛错 → 本函数不抛，只把错误交给 `fn` 里自己处理。调用侧的 `fn`
 *   负责把错误写回 report，而不是让 Promise.all 短路。
 */
export async function pMap<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, idx: number) => Promise<void>,
): Promise<void> {
  const n = Math.max(1, Math.min(concurrency, items.length));
  if (items.length === 0) return;
  let cursor = 0;
  const workers = Array.from({ length: n }, async () => {
    while (true) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

/** 对一个 db.table 跑 SHOW CREATE TABLE，解析出 DDL 字符串。 */
async function fetchCreateTable(
  registry: Pick<IConnectorRegistry, "execute">,
  entry: ConnectionEntry,
  db: string,
  table: string,
): Promise<string> {
  const sql = `SHOW CREATE TABLE \`${escapeIdent(db)}\`.\`${escapeIdent(table)}\``;
  const result: QueryResult = await registry.execute(entry.kind, entry.config, sql);
  if (result.kind !== "query") {
    throw new Error("SHOW CREATE TABLE 返回了 mutation 结果，期望 query");
  }
  if (result.rows.length === 0) {
    throw new Error("SHOW CREATE TABLE 结果为空");
  }
  const firstRow = result.rows[0];
  // MySQL 返回两列 [Table, Create Table]；个别魔改 fork 会有不同列名。
  // 优先按「列名含 create」匹配，否则回退到最后一列。
  let idx = result.columns.findIndex((c) => /create/i.test(c.name));
  if (idx < 0) idx = firstRow.length - 1;
  const ddl = firstRow[idx];
  if (typeof ddl !== "string") {
    throw new Error(`SHOW CREATE TABLE 的 DDL 列类型意外：${typeof ddl}`);
  }
  return ddl;
}

/** 把 DDL 包装成带标题 + 时间戳的 markdown 文件。 */
export function renderMarkdown(params: {
  db: string;
  table: string;
  connectionName: string;
  ddl: string;
  now: Date;
}): string {
  const { db, table, connectionName, ddl, now } = params;
  const timestamp = formatIsoLocal(now);
  return [
    `# \`${db}\`.\`${table}\``,
    "",
    `> 由 Stela 自动生成于 ${timestamp} · 连接：\`${connectionName}\``,
    "",
    "```sql",
    ddl.trim(),
    "```",
    "",
  ].join("\n");
}

/**
 * 主入口。步骤：
 * 1. listDatabases → 过滤系统库
 * 2. 对每个 db: listTables(db)
 * 3. 对每个 (db, table) 并发 4 跑 SHOW CREATE TABLE
 * 4. 写入 `${schemaDir}/${db}.${table}.md`
 * 5. 汇总 ok/failed
 *
 * 不抛异常给调用侧：所有失败都收进 `report.failed`。唯一会冒出来的是
 * `listDatabases` 本身失败（连接问题），这种情况下 report.ok = 0、failed = 空、
 * 并 rethrow；UI 直接展示错误即可。
 */
export async function dumpSchemaToMarkdown(
  options: DumpOptions,
): Promise<DumpReport> {
  const registry = options.deps?.registry ?? electronConnectorRegistry;
  const write = options.deps?.writeFile ?? writeFile;
  const now = options.deps?.now ?? (() => new Date());

  const { entry, connectionName, schemaDir, onProgress } = options;

  // 1. 业务 schema
  const allDbs = await registry.listDatabases(entry.kind, entry.config);
  const dbs = [...allDbs].filter((d) => !SYSTEM_SCHEMAS.has(d.toLowerCase())).sort();

  // 2. 枚举 (db, table)；单个 db listTables 失败记 failure，继续。
  const pairs: Array<{ db: string; table: string }> = [];
  const listFailures: DumpFailure[] = [];
  for (const db of dbs) {
    let tables: string[] = [];
    try {
      tables = await registry.listTables(entry.kind, entry.config, db);
    } catch (err) {
      listFailures.push({
        db,
        table: "*",
        error: `listTables 失败：${errMessage(err)}`,
      });
      continue;
    }
    const sorted = [...tables].sort();
    for (const t of sorted) pairs.push({ db, table: t });
  }

  const total = pairs.length;
  const report: DumpReport = {
    ok: 0,
    failed: [...listFailures],
    outDir: schemaDir,
    total: total + listFailures.length,
  };

  if (total === 0) {
    return report;
  }

  // 3 + 4. 并发跑
  let done = 0;
  await pMap(pairs, 4, async ({ db, table }) => {
    done += 1;
    const phaseIndex = done;
    onProgress?.({ index: phaseIndex, total, db, table, phase: "fetch" });
    try {
      const ddl = await fetchCreateTable(registry, entry, db, table);
      onProgress?.({ index: phaseIndex, total, db, table, phase: "write" });
      const md = renderMarkdown({
        db,
        table,
        connectionName,
        ddl,
        now: now(),
      });
      const fileName = `${sanitizeFileSegment(db)}.${sanitizeFileSegment(table)}.md`;
      const outPath = joinPath(schemaDir, fileName);
      await write(outPath, md);
      report.ok += 1;
    } catch (err) {
      onProgress?.({ index: phaseIndex, total, db, table, phase: "error" });
      report.failed.push({ db, table, error: errMessage(err) });
    }
  });

  return report;
}

/** 工具 ---------------------------------------------------------------------- */

/** MySQL 反引号内的转义：`\`` → `\`\``。 */
function escapeIdent(id: string): string {
  return id.replace(/`/g, "``");
}

/**
 * 文件系统段转义。MySQL 允许库名/表名里出现 `/` `\` 甚至空格等字符，直接丢进
 * 文件名会出问题；统一换成 `_` 以保证文件可写、跨 OS 一致。
 * 注意 markdown 标题里仍然保留原始名，只有文件路径做 sanitize。
 */
function sanitizeFileSegment(s: string): string {
  // 保留中日韩等 unicode；只过滤明确会搞坏路径的字符。
  return s.replace(/[\\/:*?"<>|\s]+/g, "_");
}

/** 跨平台 join：dir 里若出现 `\\` 认为是 Windows 风格，否则用 `/`。 */
function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  const trimmed = dir.endsWith(sep) ? dir.slice(0, -1) : dir;
  return `${trimmed}${sep}${name}`;
}

/** 格式 `YYYY-MM-DDTHH:mm:ss±HH:mm`，不依赖 Intl，保持测试可控。 */
function formatIsoLocal(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const y = d.getFullYear();
  const mo = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const h = pad(d.getHours());
  const mi = pad(d.getMinutes());
  const s = pad(d.getSeconds());
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const offAbs = Math.abs(off);
  const offH = pad(Math.floor(offAbs / 60));
  const offM = pad(offAbs % 60);
  return `${y}-${mo}-${day}T${h}:${mi}:${s}${sign}${offH}:${offM}`;
}

function errMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(err);
}
