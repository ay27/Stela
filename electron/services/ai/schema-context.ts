import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  AiCompleteRequest,
  AiSchemaColumnContext,
  AiSchemaTargetContext,
  ConnectionEntry,
  QueryResult,
} from "@shared/types";

import { getLogger } from "../logger";
import type { SqlSymbols } from "./sql-symbols";

const log = getLogger("ai.schema-context");
const MAX_SCHEMA_TARGETS = 5;
const MAX_DDL_CHARS = 4_000;
/**
 * schemaDir 里的表数量上限。真实 vault 已有 900+ 张表，旧上限 500 会按 readdir
 * 顺序静默切掉近一半——和「搜索满 cap 就 return」是同一类任意截断 bug。
 *
 * ponytail: 天花板是「每次调用都重读整个目录」，5000 个小文件约 200ms（有 OS
 * page cache 时更快）。真到万级表再加按目录 mtime 失效的内存 catalog 缓存。
 */
const MAX_SCHEMA_FILES = 5_000;
const TOKEN_MIN_LENGTH = 2;
const QUERY_STOPWORDS = new Set([
  "as",
  "by",
  "do",
  "from",
  "group",
  "having",
  "in",
  "into",
  "is",
  "join",
  "limit",
  "not",
  "on",
  "or",
  "order",
  "select",
  "sql",
  "table",
  "the",
  "to",
  "where",
  "with",
]);

interface SchemaCatalogEntry {
  connectionName: string;
  database: string | null;
  table: string;
  qualifiedName: string;
  columns: AiSchemaColumnContext[];
  ddlSnippet: string | null;
  source: "schema-dir" | "connector";
}

interface RankedSchemaEntry extends SchemaCatalogEntry {
  score: number;
  reasons: string[];
}

export interface SchemaResolverDeps {
  readDir?: typeof fs.readdir;
  readFile?: typeof fs.readFile;
  listDatabases?: (kind: string, config: unknown) => Promise<string[]>;
  listTables?: (kind: string, config: unknown, db?: string | null) => Promise<string[]>;
  execute?: (kind: string, config: unknown, sql: string) => Promise<QueryResult>;
  /**
   * 可选：批量拿带 COMMENT 的列。若提供并返回结果，会跳过 SHOW CREATE /
   * DESCRIBE / LIMIT 0 三段拼装。返回的列可不带 COMMENT。
   */
  describeTables?: (
    kind: string,
    config: unknown,
    tables: Array<{ database: string | null; table: string }>,
  ) => Promise<
    Array<{
      database: string | null;
      table: string;
      columns: Array<{ name: string; typeName: string; comment?: string | null }>;
      ddlSnippet?: string | null;
    }>
  >;
}

export interface ResolveSchemaContextOptions {
  request: AiCompleteRequest;
  symbols: SqlSymbols;
  connectionName: string;
  connection: ConnectionEntry;
  deps?: SchemaResolverDeps;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n[truncated ${value.length - max} chars]`;
}

function cleanIdentifier(value: string): string {
  return value.replace(/^[`"[]|[`"\]]$/g, "").trim();
}

function normalizeName(value: string): string {
  return cleanIdentifier(value).toLowerCase();
}

function splitQualifiedName(value: string): { database: string | null; table: string } {
  const cleaned = cleanIdentifier(value);
  const parts = cleaned.split(".").map(cleanIdentifier).filter(Boolean);
  if (parts.length >= 2) {
    return { database: parts.slice(0, -1).join("."), table: parts[parts.length - 1] ?? cleaned };
  }
  return { database: null, table: parts[0] ?? cleaned };
}

function qualifiedName(database: string | null, table: string): string {
  return database ? `${database}.${table}` : table;
}

const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/gu;

/**
 * 中日韩文字没有词边界，`[\p{L}\p{N}_]+` 会把「按月统计pbr通过率」整段吃成
 * **一个** token，之后任何 `includes` 都不可能命中——中文查询因此几乎零召回。
 *
 * 用字符 bigram 切开（"通过率" → "通过" / "过率"），与 SQLite FTS5 trigram
 * tokenizer 同思路但只需十几行。同时把 CJK 串里夹着的 ascii 片段单独抽出来，
 * 这样「pbr通过率」既产出 `pbr` 也产出中文 bigram。
 */
function expandCjk(token: string): string[] {
  const out: string[] = [];
  const runs = token.match(CJK_RUN);
  if (!runs) return out;
  for (const run of runs) {
    if (run.length === 1) {
      out.push(run);
      continue;
    }
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  }
  // CJK 串之间的 ascii/数字片段（"pbr"、"v2"）也要成为独立 token。
  for (const piece of token.split(CJK_RUN)) {
    if (piece.length >= TOKEN_MIN_LENGTH) out.push(piece);
  }
  return out;
}

function tokenize(
  values: Array<string | null | undefined>,
  options?: { filterStopwords?: boolean },
): string[] {
  const tokens = new Set<string>();
  const filterStopwords = options?.filterStopwords ?? false;
  for (const value of values) {
    if (!value) continue;
    const matches = value
      .toLowerCase()
      .match(/[\p{L}\p{N}_]+/gu);
    for (const token of matches ?? []) {
      if (token.length >= TOKEN_MIN_LENGTH && (!filterStopwords || !QUERY_STOPWORDS.has(token))) {
        tokens.add(token);
      }
      for (const gram of expandCjk(token)) {
        if (!filterStopwords || !QUERY_STOPWORDS.has(gram)) tokens.add(gram);
      }
    }
  }
  return Array.from(tokens);
}

function parseSchemaFileName(fileName: string): { database: string | null; table: string } | null {
  if (!fileName.endsWith(".md")) return null;
  const stem = fileName.slice(0, -3);
  const parts = stem.split(".");
  if (parts.length >= 2) {
    const table = parts.pop();
    if (!table) return null;
    return { database: parts.join("."), table };
  }
  if (!stem) return null;
  return { database: null, table: stem };
}

function extractDdl(markdown: string): string | null {
  const fenced = /```sql\s*([\s\S]*?)```/i.exec(markdown)?.[1]?.trim();
  if (fenced) return fenced;
  return markdown.trim() || null;
}

/**
 * 列注释：MySQL 用 `COMMENT '...'`，StarRocks/Doris 用 `COMMENT "..."`。
 * 两种都要认——真实 vault 里 900+ 张表用的是双引号风格。
 */
const COLUMN_COMMENT_RE = /\bcomment\s+(?:'((?:[^']|'')*)'|"((?:[^"]|"")*)")/i;

function extractColumnComment(line: string): string | undefined {
  const m = COLUMN_COMMENT_RE.exec(line);
  if (!m) return undefined;
  const raw = m[1] ?? m[2];
  if (raw === undefined) return undefined;
  const text = raw.replace(/''/g, "'").replace(/""/g, '"').trim();
  return text.length > 0 ? text : undefined;
}

export function parseColumnsFromDdl(ddl: string): AiSchemaColumnContext[] {
  const columns: AiSchemaColumnContext[] = [];
  const seen = new Set<string>();
  for (const rawLine of ddl.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/,$/, "");
    if (/^create\s+table\b/i.test(line) || line === "(" || line === ")") continue;
    if (/^\)/.test(line)) continue;
    if (/^(primary|unique|foreign|duplicate|aggregate)\s+key\b/i.test(line)) continue;
    if (/^(key|index|constraint)\b/i.test(line)) continue;
    // StarRocks/Doris 的表尾子句，否则 `DUPLICATE KEY(...)` 会被当成一列。
    if (/^(partition|order|distributed)\s+by\b/i.test(line)) continue;
    if (/^comment\b/i.test(line)) continue;
    if (/^engine\s*=/i.test(line)) continue;
    if (/^distributed\b/i.test(line)) continue;
    if (/^properties\s*\(/i.test(line)) continue;
    const match = /^[`"]?([A-Za-z_][\w$]*)[`"]?\s+([A-Za-z][\w() ,]*)/i.exec(line);
    if (!match) continue;
    const name = match[1] ?? "";
    // 类型只到修饰符为止：`bigint NOT NULL COMMENT "主键"` 的类型是 `bigint`，
    // 把 `NOT NULL COMMENT` 一起塞进 typeName 会污染所有下游（prompt、
    // search_tables 输出）。
    const typeName = (match[2] ?? "")
      .replace(
        /\s+(not\s+null|null|default|comment|auto_increment|generated|as|collate|primary|unique|key)\b.*$/i,
        "",
      )
      .trim();
    const lowerName = name.toLowerCase();
    if (!name || seen.has(lowerName)) continue;
    if (["primary", "unique", "key", "constraint", "index"].includes(lowerName)) continue;
    seen.add(lowerName);
    const comment = extractColumnComment(line);
    columns.push(comment ? { name, typeName, comment } : { name, typeName });
    if (columns.length >= 80) break;
  }
  return columns;
}

async function loadSchemaDirCatalog(
  connectionName: string,
  schemaDir: string | undefined,
  deps: Required<Pick<SchemaResolverDeps, "readDir" | "readFile">>,
): Promise<SchemaCatalogEntry[]> {
  if (!schemaDir) return [];
  let files: string[];
  try {
    files = await deps.readDir(schemaDir);
  } catch {
    return [];
  }
  const out: SchemaCatalogEntry[] = [];
  for (const fileName of files.filter((file) => file.endsWith(".md")).slice(0, MAX_SCHEMA_FILES)) {
    const parsed = parseSchemaFileName(fileName);
    if (!parsed) continue;
    let markdown: string;
    try {
      markdown = await deps.readFile(path.join(schemaDir, fileName), "utf-8");
    } catch {
      continue;
    }
    const ddl = extractDdl(markdown);
    out.push({
      connectionName,
      database: parsed.database,
      table: parsed.table,
      qualifiedName: qualifiedName(parsed.database, parsed.table),
      columns: ddl ? parseColumnsFromDdl(ddl) : [],
      ddlSnippet: ddl ? truncate(ddl, MAX_DDL_CHARS) : null,
      source: "schema-dir",
    });
  }
  return out;
}

export async function loadSchemaDirTableSchemas({
  connectionName,
  schemaDir,
  tableNames,
}: {
  connectionName: string;
  schemaDir: string | undefined;
  tableNames: string[];
}): Promise<AiSchemaTargetContext[]> {
  if (!schemaDir) return [];
  const qualified = new Set<string>();
  const unqualified = new Set<string>();
  for (const name of tableNames) {
    const parsed = splitQualifiedName(name);
    if (parsed.database) {
      qualified.add(normalizeName(qualifiedName(parsed.database, parsed.table)));
    } else {
      unqualified.add(normalizeName(parsed.table));
    }
  }
  if (qualified.size === 0 && unqualified.size === 0) return [];

  let files: string[];
  try {
    files = await fs.readdir(schemaDir);
  } catch {
    return [];
  }

  const out: AiSchemaTargetContext[] = [];
  for (const fileName of files) {
    const parsed = parseSchemaFileName(fileName);
    if (
      !parsed ||
      (!unqualified.has(normalizeName(parsed.table)) &&
        !qualified.has(normalizeName(qualifiedName(parsed.database, parsed.table))))
    ) {
      continue;
    }
    try {
      const ddl = extractDdl(await fs.readFile(path.join(schemaDir, fileName), "utf-8"));
      out.push({
        connectionName,
        database: parsed.database,
        table: parsed.table,
        columns: ddl ? parseColumnsFromDdl(ddl) : [],
        ddlSnippet: ddl ? truncate(ddl, MAX_DDL_CHARS) : null,
        source: "schema-dir",
        matchReason: "explicit SQL table",
        score: 100,
      });
    } catch {
      // Missing or unreadable snapshots are optional context.
    }
    if (out.length >= MAX_SCHEMA_TARGETS) break;
  }
  return out;
}

async function loadConnectorCatalog(
  connectionName: string,
  connection: ConnectionEntry,
  deps: SchemaResolverDeps,
): Promise<SchemaCatalogEntry[]> {
  if (!deps.listTables) return [];
  const listDatabases = deps.listDatabases ?? (async () => [] as string[]);
  const dbs = await listDatabases(connection.kind, connection.config).catch(() => [] as string[]);
  const fallbackDbs = dbs.length > 0 ? dbs : [null];
  const entries: SchemaCatalogEntry[] = [];
  for (const db of fallbackDbs.slice(0, 30)) {
    const tables = await deps.listTables(connection.kind, connection.config, db).catch(() => [] as string[]);
    for (const table of tables.slice(0, 200)) {
      entries.push({
        connectionName,
        database: db,
        table,
        qualifiedName: qualifiedName(db, table),
        columns: [],
        ddlSnippet: null,
        source: "connector",
      });
    }
  }
  return entries;
}

function explicitTableSet(symbols: SqlSymbols): Set<string> {
  const set = new Set<string>();
  for (const table of symbols.tables) {
    const parsed = splitQualifiedName(table);
    set.add(normalizeName(parsed.table));
    set.add(normalizeName(qualifiedName(parsed.database, parsed.table)));
  }
  return set;
}

/**
 * 单条目的关键词打分。两个 rank 入口共用，避免权重在两处漂移。
 *
 * 权重意图：表名命中最强；列注释次之——业务词（尤其中文 bigram）唯一能落地的
 * 位置就是注释，若只给它 DDL 全文的 +3，中文查询会被表名 substring 噪声压死；
 * DDL 全文兜底最弱（注释已单独计分，这里只捕捉类型/属性等剩余文本）。
 */
function scoreEntryTerms(
  entry: SchemaCatalogEntry,
  terms: string[],
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const tableName = normalizeName(entry.table);
  const qName = normalizeName(entry.qualifiedName);
  const comments = entry.columns
    .map((column) => column.comment?.toLowerCase())
    .filter((text): text is string => Boolean(text));
  for (const term of terms) {
    if (tableName.includes(term) || qName.includes(term)) {
      score += 16;
      reasons.push(`table match:${term}`);
    }
    if (entry.columns.some((column) => normalizeName(column.name).includes(term))) {
      score += 8;
      reasons.push(`column match:${term}`);
    }
    if (comments.some((text) => text.includes(term))) {
      score += 6;
      reasons.push(`comment match:${term}`);
    }
    if (entry.ddlSnippet?.toLowerCase().includes(term)) {
      score += 1;
      reasons.push(`ddl match:${term}`);
    }
  }
  return { score, reasons };
}

function rankCatalog(
  catalog: SchemaCatalogEntry[],
  request: AiCompleteRequest,
  symbols: SqlSymbols,
): RankedSchemaEntry[] {
  const explicit = explicitTableSet(symbols);
  const terms =
    explicit.size > 0
      ? []
      : [
          ...tokenize([request.context.sql], { filterStopwords: true }),
          ...tokenize([
            request.context.userInstruction,
            request.context.selectedText,
          ]),
        ];
  return catalog
    .map((entry) => {
      let score = 0;
      const reasons: string[] = [];
      const tableName = normalizeName(entry.table);
      const qName = normalizeName(entry.qualifiedName);
      if (explicit.has(tableName) || explicit.has(qName)) {
        score += 100;
        reasons.push("explicit SQL table");
      }
      if (explicit.size > 0) {
        return { ...entry, score, reasons };
      }
      const termScore = scoreEntryTerms(entry, terms);
      return {
        ...entry,
        score: score + termScore.score,
        reasons: [...reasons, ...termScore.reasons],
      };
    })
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.qualifiedName.localeCompare(b.qualifiedName),
    );
}

function rankCatalogByKeywords(
  catalog: SchemaCatalogEntry[],
  keywords: string[],
): RankedSchemaEntry[] {
  const terms = tokenize(keywords, { filterStopwords: true });
  return catalog
    .map((entry) => ({ ...entry, ...scoreEntryTerms(entry, terms) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.qualifiedName.localeCompare(b.qualifiedName));
}

export interface SearchTablesOptions {
  connectionName: string;
  connection: ConnectionEntry;
  /** 自然语言关键词（表名/业务词），来自 agent 对用户问题的推测。 */
  keywords: string[];
  limit?: number;
  /** false 时跳过可过期的本地 dump，只枚举当前 connector。 */
  preferLocalSchemaDir?: boolean;
  deps?: SchemaResolverDeps;
}

/**
 * 需求 5 的核心：agent 拿一组模糊关键词（表名片段 / 业务词），在 schema-dir
 * 文档或 connector 的 database/table 目录里模糊打分找候选表。复用
 * [rankCatalog](#rankCatalog) 同款打分逻辑（表名/列名/DDL 命中），只是输入
 * 从 `AiCompleteRequest` 换成一组裸关键词，方便 agent 工具直接调用。
 */
export async function searchTables(
  options: SearchTablesOptions,
): Promise<AiSchemaTargetContext[]> {
  const deps = {
    readDir: fs.readdir,
    readFile: fs.readFile,
    ...options.deps,
  };
  const fromSchemaDir =
    options.preferLocalSchemaDir === false
      ? []
      : await loadSchemaDirCatalog(
          options.connectionName,
          options.connection.schemaDir,
          deps,
        );
  let catalog =
    fromSchemaDir.length > 0
      ? fromSchemaDir
      : await loadConnectorCatalog(options.connectionName, options.connection, deps);
  // 让 live connector 上的 COMMENT 进入打分：先按表名筛，再批量拉结构。
  // ponytail: 整页表不会被全量拉，只命中当前关键词后的候选表前 N 个。
  if (deps.describeTables && catalog.every((entry) => entry.source === "connector")) {
    const probed = await callDescribeTables(
      options.connection,
      catalog.slice(0, 200).map((entry) => ({ database: entry.database, table: entry.table })),
      deps,
    );
    if (probed.length > 0) {
      const byQName = new Map(
        probed.map((entry) => [
          normalizeName(qualifiedName(entry.database, entry.table)),
          entry,
        ]),
      );
      catalog = catalog.map((entry) => {
        const hit = byQName.get(normalizeName(entry.qualifiedName));
        if (!hit) return entry;
        return {
          ...entry,
          columns: hit.columns.length > 0 ? hit.columns : entry.columns,
          ddlSnippet: hit.ddlSnippet ?? entry.ddlSnippet,
        };
      });
    }
  }
  const ranked = rankCatalogByKeywords(catalog, options.keywords);
  const limit = options.limit ?? MAX_SCHEMA_TARGETS;
  return ranked.slice(0, limit).map((entry) => ({
    connectionName: entry.connectionName,
    database: entry.database,
    table: entry.table,
    columns: entry.columns,
    ddlSnippet: entry.ddlSnippet,
    source: entry.source === "schema-dir" ? "schema-dir" : "connector",
    matchReason: Array.from(new Set(entry.reasons)).slice(0, 4).join(", "),
    score: entry.score,
  }));
}

function quoteIdent(value: string, dialect: string | undefined): string {
  const quote = dialect?.toLowerCase().includes("postgres") ? `"` : "`";
  return `${quote}${value.replaceAll(quote, `${quote}${quote}`)}${quote}`;
}

/**
 * 把 connector 直出的列转成 AiSchemaColumnContext。
 * 缺失 `comment` 字段的老插件保留原 shape（可选字段省略）。
 */
function descriptorColumns(
  columns: Array<{ name: string; typeName: string; comment?: string | null }>,
): AiSchemaColumnContext[] {
  return columns.map((column) => ({
    name: column.name,
    typeName: column.typeName,
    ...(column.comment ? { comment: column.comment } : {}),
  }));
}

async function callDescribeTables(
  connection: ConnectionEntry,
  targets: Array<{ database: string | null; table: string }>,
  deps: SchemaResolverDeps,
): Promise<
  Array<{
    database: string | null;
    table: string;
    columns: AiSchemaColumnContext[];
    ddlSnippet: string | null;
  }>
> {
  if (!deps.describeTables) return [];
  const raw = await deps
    .describeTables(connection.kind, connection.config, targets)
    .catch((err) => {
      log.warn("describeTables failed, falling back to SQL probes", {
        connectionKind: connection.kind,
        err: (err as Error).message,
      });
      return [];
    });
  const descriptors = Array.isArray(raw) ? raw : [];
  return descriptors.map((entry) => ({
    database: entry.database,
    table: entry.table,
    columns: descriptorColumns(entry.columns),
    ddlSnippet: entry.ddlSnippet ?? null,
  }));
}

function columnsFromDescribe(result: QueryResult): AiSchemaColumnContext[] {
  if (result.kind !== "query") return [];
  const fieldIndex = result.columns.findIndex((column) => /^(field|column|column_name|name)$/i.test(column.name));
  if (fieldIndex < 0) return [];
  const typeIndex = result.columns.findIndex((column) => /^(type|data_type)$/i.test(column.name));
  return result.rows.flatMap((row) => {
    const name = row[fieldIndex];
    if (typeof name !== "string" || !name.trim()) return [];
    const type = typeIndex >= 0 ? row[typeIndex] : null;
    return [{ name, typeName: typeof type === "string" ? type : undefined }];
  });
}

async function probeColumns(
  ranked: RankedSchemaEntry[],
  connection: ConnectionEntry,
  request: AiCompleteRequest,
  deps: SchemaResolverDeps,
): Promise<RankedSchemaEntry[]> {
  if (!deps.execute) return ranked;
  const dialect = request.context.connector?.dialect;
  return Promise.all(
    ranked.map(async (entry, idx) => {
      if (entry.columns.length > 0 || idx >= MAX_SCHEMA_TARGETS) return entry;
      const tableRef = entry.database
        ? `${quoteIdent(entry.database, dialect)}.${quoteIdent(entry.table, dialect)}`
        : quoteIdent(entry.table, dialect);
      try {
        const result = await deps.execute!(connection.kind, connection.config, `SELECT * FROM ${tableRef} LIMIT 0`);
        if (result.kind !== "query") return entry;
        return {
          ...entry,
          columns: result.columns.map((column) => ({
            name: column.name,
            typeName: column.typeName,
          })),
        };
      } catch {
        return entry;
      }
    }),
  );
}

async function fetchTableSchemaFromConnector(
  connection: ConnectionEntry,
  database: string | null,
  table: string,
  dialect: string | undefined,
  deps: SchemaResolverDeps,
): Promise<{ columns: AiSchemaColumnContext[]; ddlSnippet: string | null }> {
  if (!deps.execute) {
    log.warn("schema probe skipped: connector execute dep missing", {
      connectionKind: connection.kind,
      table: qualifiedName(database, table),
    });
    return { columns: [], ddlSnippet: null };
  }
  const tableRef = database
    ? `${quoteIdent(database, dialect)}.${quoteIdent(table, dialect)}`
    : quoteIdent(table, dialect);

  try {
    const result = await deps.execute(
      connection.kind,
      connection.config,
      `SHOW CREATE TABLE ${tableRef}`,
    );
    if (result.kind === "query" && result.rows.length > 0) {
      const firstRow = result.rows[0] ?? [];
      let idx = result.columns.findIndex((column) => /create/i.test(column.name));
      if (idx < 0) idx = firstRow.length - 1;
      const ddl = firstRow[idx];
      if (typeof ddl === "string" && ddl.trim()) {
        return {
          ddlSnippet: truncate(ddl.trim(), MAX_DDL_CHARS),
          columns: parseColumnsFromDdl(ddl),
        };
      }
    }
  } catch {
    // Fall through to DESCRIBE / LIMIT 0 probes.
  }

  try {
    const result = await deps.execute(
      connection.kind,
      connection.config,
      `DESCRIBE ${tableRef}`,
    );
    const columns = columnsFromDescribe(result);
    if (columns.length > 0) return { columns, ddlSnippet: null };
  } catch {
    // fall through to LIMIT 0 probe
  }

  try {
    const result = await deps.execute(
      connection.kind,
      connection.config,
      `SELECT * FROM ${tableRef} LIMIT 0`,
    );
    if (result.kind === "query") {
      return {
        columns: result.columns.map((column) => ({
          name: column.name,
          typeName: column.typeName,
        })),
        ddlSnippet: null,
      };
    }
  } catch {
    // ignore
  }

  return { columns: [], ddlSnippet: null };
}

function findCatalogEntry(
  catalog: SchemaCatalogEntry[],
  mention: string,
): SchemaCatalogEntry | null {
  const parsed = splitQualifiedName(mention);
  const mentionQName = normalizeName(qualifiedName(parsed.database, parsed.table));
  const mentionTable = normalizeName(parsed.table);

  const exact = catalog.find(
    (entry) => normalizeName(entry.qualifiedName) === mentionQName,
  );
  if (exact) return exact;

  const byTable = catalog.filter(
    (entry) => normalizeName(entry.table) === mentionTable,
  );
  if (byTable.length === 1) return byTable[0] ?? null;
  return null;
}

function isSchemaEntryValid(entry: SchemaCatalogEntry): boolean {
  return Boolean(
    (entry.ddlSnippet && entry.ddlSnippet.trim()) ||
      (entry.columns && entry.columns.length > 0),
  );
}

function mergeSchemaTargets(
  primary: AiSchemaTargetContext[],
  secondary: AiSchemaTargetContext[],
  limit: number,
): AiSchemaTargetContext[] {
  const seen = new Set<string>();
  const out: AiSchemaTargetContext[] = [];
  for (const entry of [...primary, ...secondary]) {
    const key = normalizeName(
      qualifiedName(entry.database ?? null, entry.table ?? ""),
    );
    if (!entry.table || seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
    if (out.length >= limit) break;
  }
  return out;
}

export interface ResolveNamedTableSchemasOptions {
  tableNames: string[];
  connectionName: string;
  connection: ConnectionEntry;
  request: AiCompleteRequest;
  matchReason: string;
  score?: number;
  /** false 时即使存在 schemaDir，也向当前 connector 拉取结构。 */
  preferLocalSchemaDir?: boolean;
  deps?: SchemaResolverDeps;
}

export async function resolveNamedTableSchemas(
  options: ResolveNamedTableSchemasOptions,
): Promise<AiSchemaTargetContext[]> {
  const uniqueNames = Array.from(
    new Set(options.tableNames.map((name) => name.trim()).filter(Boolean)),
  ).slice(0, MAX_SCHEMA_TARGETS);
  if (uniqueNames.length === 0) return [];

  const deps = {
    readDir: fs.readdir,
    readFile: fs.readFile,
    ...options.deps,
  };
  const dialect = options.request.context.connector?.dialect;
  const schemaDirCatalog =
    options.preferLocalSchemaDir === false
      ? []
      : await loadSchemaDirCatalog(
          options.connectionName,
          options.connection.schemaDir,
          deps,
        );
  const connectorCatalog =
    schemaDirCatalog.length > 0
      ? schemaDirCatalog
      : await loadConnectorCatalog(options.connectionName, options.connection, deps);

  // 先尝试 connector 直出的 describeTables：单次往返、可拿到 COMMENT 全文。
  // 没接口或失败时回退到原本的 SHOW CREATE / DESCRIBE / LIMIT 0 拼装。
  const parsedTargets: Array<{ database: string | null; table: string }> = [];
  for (const name of uniqueNames) {
    const parsed = splitQualifiedName(name);
    const connectorEntry = findCatalogEntry(connectorCatalog, name);
    parsedTargets.push({
      database: connectorEntry?.database ?? parsed.database,
      table: connectorEntry?.table ?? parsed.table,
    });
  }
  const described = await callDescribeTables(options.connection, parsedTargets, deps);
  const describedByQName = new Map(
    described.map((entry) => [
      normalizeName(qualifiedName(entry.database, entry.table)),
      entry,
    ]),
  );

  const out: AiSchemaTargetContext[] = [];
  for (const name of uniqueNames) {
    const parsed = splitQualifiedName(name);
    const entry = findCatalogEntry(schemaDirCatalog, name);
    let source: AiSchemaTargetContext["source"] = "schema-dir";
    let columns = entry?.columns ?? [];
    let ddlSnippet = entry?.ddlSnippet ?? null;
    let database = entry?.database ?? parsed.database;
    let table = entry?.table ?? parsed.table;

    if (!entry || !isSchemaEntryValid(entry)) {
      const connectorEntry = findCatalogEntry(connectorCatalog, name);
      if (connectorEntry) {
        database = connectorEntry.database ?? parsed.database;
        table = connectorEntry.table;
      }
      const describedHit =
        describedByQName.get(normalizeName(qualifiedName(database, table))) ?? null;
      let fetched: { columns: AiSchemaColumnContext[]; ddlSnippet: string | null };
      if (describedHit && describedHit.columns.length > 0) {
        fetched = {
          columns: describedHit.columns,
          ddlSnippet: describedHit.ddlSnippet,
        };
      } else {
        fetched = await fetchTableSchemaFromConnector(
          options.connection,
          database,
          table,
          dialect,
          deps,
        );
      }
      columns = fetched.columns.length > 0 ? fetched.columns : columns;
      ddlSnippet = fetched.ddlSnippet ?? ddlSnippet;
      source = "connector";
    }

    out.push({
      connectionName: options.connectionName,
      database,
      table,
      columns,
      ddlSnippet,
      source: entry && isSchemaEntryValid(entry) ? "schema-dir" : source,
      matchReason: options.matchReason,
      score: options.score ?? 100,
    });
  }
  return out;
}

export interface ResolveMentionedSchemaContextOptions {
  mentionedTables: string[];
  connectionName: string;
  connection: ConnectionEntry;
  request: AiCompleteRequest;
  deps?: SchemaResolverDeps;
}

export async function resolveMentionedSchemaContext(
  options: ResolveMentionedSchemaContextOptions,
): Promise<AiSchemaTargetContext[]> {
  return resolveNamedTableSchemas({
    tableNames: options.mentionedTables,
    connectionName: options.connectionName,
    connection: options.connection,
    request: options.request,
    matchReason: "user @mention",
    score: 1_000,
    deps: options.deps,
  });
}

export { mergeSchemaTargets };

export async function resolveSchemaContext(
  options: ResolveSchemaContextOptions,
): Promise<AiSchemaTargetContext[]> {
  if (options.symbols.tables.length > 0) {
    return resolveNamedTableSchemas({
      tableNames: options.symbols.tables,
      connectionName: options.connectionName,
      connection: options.connection,
      request: options.request,
      matchReason: "explicit SQL table",
      deps: options.deps,
    });
  }

  const deps = {
    readDir: fs.readdir,
    readFile: fs.readFile,
    ...options.deps,
  };
  const fromSchemaDir = await loadSchemaDirCatalog(
    options.connectionName,
    options.connection.schemaDir,
    deps,
  );
  const catalog =
    fromSchemaDir.length > 0
      ? fromSchemaDir
      : await loadConnectorCatalog(options.connectionName, options.connection, deps);
  const ranked = await probeColumns(
    rankCatalog(catalog, options.request, options.symbols),
    options.connection,
    options.request,
    deps,
  );
  return ranked.slice(0, MAX_SCHEMA_TARGETS).map((entry) => ({
    connectionName: entry.connectionName,
    database: entry.database,
    table: entry.table,
    columns: entry.columns,
    ddlSnippet: entry.ddlSnippet,
    source: entry.source === "schema-dir" ? "schema-dir" : "connector",
    matchReason: Array.from(new Set(entry.reasons)).slice(0, 4).join(", "),
    score: entry.score,
  }));
}
