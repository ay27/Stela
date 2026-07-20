import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  AiCompleteRequest,
  AiSchemaColumnContext,
  AiSchemaTargetContext,
  ConnectionEntry,
  QueryResult,
} from "@shared/types";

import type { SqlSymbols } from "./sql-symbols";

const MAX_SCHEMA_TARGETS = 5;
const MAX_DDL_CHARS = 4_000;
const MAX_SCHEMA_FILES = 500;
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

export function parseColumnsFromDdl(ddl: string): AiSchemaColumnContext[] {
  const columns: AiSchemaColumnContext[] = [];
  const seen = new Set<string>();
  for (const rawLine of ddl.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/,$/, "");
    if (/^create\s+table\b/i.test(line) || line === "(" || line === ")") continue;
    if (/^\)/.test(line)) continue;
    if (/^(primary|unique|foreign)\s+key\b/i.test(line)) continue;
    if (/^(key|index|constraint)\b/i.test(line)) continue;
    if (/^engine\s*=/i.test(line)) continue;
    if (/^distributed\b/i.test(line)) continue;
    if (/^properties\s*\(/i.test(line)) continue;
    const match = /^[`"]?([A-Za-z_][\w$]*)[`"]?\s+([A-Za-z][\w() ,]*)/i.exec(line);
    if (!match) continue;
    const name = match[1] ?? "";
    const typeName = (match[2] ?? "").trim();
    const lowerName = name.toLowerCase();
    if (!name || seen.has(lowerName)) continue;
    if (["primary", "unique", "key", "constraint", "index"].includes(lowerName)) continue;
    seen.add(lowerName);
    columns.push({ name, typeName });
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
      for (const term of terms) {
        if (tableName.includes(term) || qName.includes(term)) {
          score += 16;
          reasons.push(`table match:${term}`);
        }
        if (entry.columns.some((column) => normalizeName(column.name).includes(term))) {
          score += 8;
          reasons.push(`column match:${term}`);
        }
        if (entry.ddlSnippet?.toLowerCase().includes(term)) {
          score += 3;
          reasons.push(`ddl match:${term}`);
        }
      }
      return { ...entry, score, reasons };
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
    .map((entry) => {
      let score = 0;
      const reasons: string[] = [];
      const tableName = normalizeName(entry.table);
      const qName = normalizeName(entry.qualifiedName);
      for (const term of terms) {
        if (tableName.includes(term) || qName.includes(term)) {
          score += 16;
          reasons.push(`table match:${term}`);
        }
        if (entry.columns.some((column) => normalizeName(column.name).includes(term))) {
          score += 8;
          reasons.push(`column match:${term}`);
        }
        if (entry.ddlSnippet?.toLowerCase().includes(term)) {
          score += 3;
          reasons.push(`ddl match:${term}`);
        }
      }
      return { ...entry, score, reasons };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.qualifiedName.localeCompare(b.qualifiedName));
}

export interface SearchTablesOptions {
  connectionName: string;
  connection: ConnectionEntry;
  /** 自然语言关键词（表名/业务词），来自 agent 对用户问题的推测。 */
  keywords: string[];
  limit?: number;
  deps?: SchemaResolverDeps;
}

/**
 * 需求 5 的核心：agent 拿一组模糊关键词（表名片段 / 业务词），在 schema-dir
 * 文档 或 connector 的 database/table 目录里模糊打分找候选表。复用
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
  const fromSchemaDir = await loadSchemaDirCatalog(
    options.connectionName,
    options.connection.schemaDir,
    deps,
  );
  const catalog =
    fromSchemaDir.length > 0
      ? fromSchemaDir
      : await loadConnectorCatalog(options.connectionName, options.connection, deps);
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
  if (!deps.execute) return { columns: [], ddlSnippet: null };
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
  const schemaDirCatalog = await loadSchemaDirCatalog(
    options.connectionName,
    options.connection.schemaDir,
    deps,
  );
  const connectorCatalog =
    schemaDirCatalog.length > 0
      ? schemaDirCatalog
      : await loadConnectorCatalog(options.connectionName, options.connection, deps);

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
      const fetched = await fetchTableSchemaFromConnector(
        options.connection,
        database,
        table,
        dialect,
        deps,
      );
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
