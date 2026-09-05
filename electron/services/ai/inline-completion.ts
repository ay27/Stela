import { AppError } from "@shared/errors";
import { lezerDialectFor, resolveDialect } from "@shared/sql-dialect";
import type {
  AiInlineCompletionEvent,
  AiInlineCompletionRequest,
  AiSchemaColumnContext,
  AiSchemaTargetContext,
} from "@shared/types";
import type { SyntaxNode } from "@lezer/common";

import * as connectionsStore from "../connections-store";
import { getLogger } from "../logger";
import * as settingsStore from "../settings-store";
import { loadApiKey, streamChatCompletions } from "./provider";
import { redactForPrompt } from "./redaction";
import { loadSchemaDirTableSchemas } from "./schema-context";
import { extractSqlSymbols } from "./sql-symbols";

const MAX_PREFIX_CHARS = 4_000;
const MAX_SUFFIX_CHARS = 2_000;
const MAX_AUXILIARY_CHARS = 2_000;
const MAX_PROSE_CHARS = 300;
const MAX_TABLES = 3;
const MAX_COLUMNS_PER_TABLE = 40;
const MAX_SIBLINGS = 2;
const MAX_SIBLING_CHARS = 650;
const MAX_OUTPUT_LINES = 3;
const MAX_OUTPUT_CHARS = 360;
/** Conservative initial gate; the explicit evaluator owns future calibration. */
const MIN_AVERAGE_LOGPROB = -2.5;
const log = getLogger("ai.inline-completion");

const SYSTEM_PROMPT = `Complete SQL at the cursor.
Output only the exact text to insert, using at most three short lines.
Never repeat the prefix or suffix.
Do not use Markdown fences or explanations.
Preserve indentation and required whitespace.
Use schema and nearby SQL only as reference.
Stop as soon as the existing suffix can continue naturally.`;

interface PreparedCompletionContext {
  prefix: string;
  suffix: string;
  auxiliary: string;
  schemas: AiSchemaTargetContext[];
}

function isCancellation(err: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (err instanceof AppError && err.code === "ai_aborted");
}

/** prefix/suffix 里出现过、且不是 CTE 别名的表名，最多 MAX_TABLES 个。 */
export function referencedTableNames(request: AiInlineCompletionRequest): string[] {
  const symbols = extractSqlSymbols(`${request.prefix}\n${request.suffix}`);
  const ctes = new Set(symbols.ctes.map((name) => name.toLowerCase()));
  return symbols.tables
    .filter((name) => !ctes.has(name.toLowerCase()))
    .slice(0, MAX_TABLES);
}

function tableKey(schema: AiSchemaTargetContext): string {
  return `${schema.database ?? ""}.${schema.table ?? ""}`.toLowerCase();
}

function tableNameKey(schema: AiSchemaTargetContext): string {
  return (schema.table ?? "").toLowerCase();
}

function mergeColumnComments(
  live: AiSchemaColumnContext[],
  documented: AiSchemaColumnContext[],
): AiSchemaColumnContext[] {
  const comments = new Map(
    documented
      .filter((column) => column.comment)
      .map((column) => [column.name.toLowerCase(), column.comment as string]),
  );
  return live.map((column) => {
    const comment = column.comment ?? comments.get(column.name.toLowerCase());
    return comment ? { ...column, comment } : { ...column };
  });
}

/** Live renderer columns own membership/type; schemaDir only supplies comments. */
export function mergeCompletionSchemas(
  fromRenderer: AiSchemaTargetContext[],
  fromSchemaDir: AiSchemaTargetContext[],
): AiSchemaTargetContext[] {
  const documentedByQualified = new Map(fromSchemaDir.map((schema) => [tableKey(schema), schema]));
  const documentedByTable = new Map(fromSchemaDir.map((schema) => [tableNameKey(schema), schema]));
  const used = new Set<AiSchemaTargetContext>();
  const merged = fromRenderer.map((live) => {
    const documented =
      documentedByQualified.get(tableKey(live)) ?? documentedByTable.get(tableNameKey(live));
    if (documented) used.add(documented);
    return {
      ...live,
      columns: mergeColumnComments(live.columns ?? [], documented?.columns ?? []),
      ddlSnippet: null,
    };
  });
  for (const documented of fromSchemaDir) {
    if (used.has(documented)) continue;
    merged.push({ ...documented, ddlSnippet: null });
  }
  return merged.slice(0, MAX_TABLES);
}

export function hasSchemasForReferencedTables(
  tables: string[],
  schemas: AiSchemaTargetContext[],
): boolean {
  return tables.every((referencedName) => {
    const referenced = referencedName.replace(/[`\"]/g, "").toLowerCase();
    const shortName = referenced.split(".").at(-1) ?? referenced;
    return schemas.some((schema) => {
      if (!schema.table || (schema.columns?.length ?? 0) === 0) return false;
      const table = schema.table.toLowerCase();
      const qualified = schema.database
        ? `${schema.database}.${schema.table}`.toLowerCase()
        : table;
      return referenced === qualified || shortName === table;
    });
  });
}

function describeTable(schema: AiSchemaTargetContext): string {
  const name = `${schema.database ? `${schema.database}.` : ""}${schema.table ?? "?"}`;
  const columns = (schema.columns ?? [])
    .slice(0, MAX_COLUMNS_PER_TABLE)
    .map((column) => {
      const comment = column.comment?.replace(/\s+/g, " ").trim();
      return `${column.name} ${column.typeName}${comment ? ` (${comment})` : ""}`;
    })
    .join("; ");
  return columns ? `table ${name}: ${columns}` : `table ${name}`;
}

function chooseSiblingSqls(sqls: string[], tables: string[]): string[] {
  if (tables.length === 0) return [];
  const needles = new Set(
    tables.flatMap((table) => {
      const lower = table.toLowerCase();
      return [lower, lower.split(".").at(-1) ?? lower];
    }),
  );
  return sqls
    .map((sql) => sql.trim())
    .filter(Boolean)
    .filter((sql) => {
      const lower = sql.toLowerCase();
      return [...needles].some((needle) => lower.includes(needle));
    })
    .slice(0, MAX_SIBLINGS)
    .map((sql) => sql.slice(0, MAX_SIBLING_CHARS));
}

export function prepareInlineCompletionContext(input: {
  request: AiInlineCompletionRequest;
  dialect: string;
  tables: string[];
  schemas: AiSchemaTargetContext[];
}): PreparedCompletionContext {
  const { request, dialect, tables } = input;
  const mergedSchemas = mergeCompletionSchemas(request.tableSchemas ?? [], input.schemas);
  const redacted = redactForPrompt({
    prefix: request.prefix,
    suffix: request.suffix,
    siblings: chooseSiblingSqls(request.siblingSqls, tables),
    heading: request.heading ?? "",
    prose: request.prose ?? "",
    schema: mergedSchemas.map(describeTable),
  });
  const auxiliary = [
    `dialect: ${dialect}`,
    ...redacted.schema,
    redacted.heading ? `section: ${redacted.heading}` : "",
    redacted.prose ? `notes: ${redacted.prose.slice(0, MAX_PROSE_CHARS)}` : "",
    ...redacted.siblings.map((sql, index) => `nearby sql ${index + 1}: ${sql}`),
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_AUXILIARY_CHARS);
  return {
    prefix: redacted.prefix.slice(-MAX_PREFIX_CHARS),
    suffix: redacted.suffix.slice(0, MAX_SUFFIX_CHARS),
    auxiliary,
    schemas: mergedSchemas,
  };
}

/** Product prompt shared with the evaluator for non-native provider profiles. */
export function buildInlineCompletionPrompt(input: {
  request: AiInlineCompletionRequest;
  dialect: string;
  tables: string[];
  schemas: AiSchemaTargetContext[];
}): { system: string; user: string } {
  const prepared = prepareInlineCompletionContext(input);
  return {
    system: SYSTEM_PROMPT,
    user: `Context:\n${prepared.auxiliary || "(none)"}\n\nPrefix:\n${prepared.prefix}\n<CURSOR>\nSuffix:\n${prepared.suffix}`,
  };
}

export function buildInlineFimInput(input: {
  request: AiInlineCompletionRequest;
  dialect: string;
  tables: string[];
  schemas: AiSchemaTargetContext[];
}): { prompt: string; suffix: string; schemas: AiSchemaTargetContext[] } {
  const prepared = prepareInlineCompletionContext(input);
  const comment = prepared.auxiliary.replace(/\*\//g, "* /");
  return {
    prompt: `/* Stela completion context\n${comment || "dialect: SQL"}\n*/\n${prepared.prefix}`,
    suffix: prepared.suffix,
    schemas: prepared.schemas,
  };
}

export function sanitizeCompletionCandidate(text: string): string {
  let out = text.replace(/\r\n?/g, "\n").trimEnd();
  const trimmed = out.trim();
  if (/^```(?:sql)?(?:\s*\n|$)/i.test(trimmed)) {
    out = trimmed.replace(/^```(?:sql)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
  }
  return out.split("\n").slice(0, MAX_OUTPUT_LINES).join("\n").slice(0, MAX_OUTPUT_CHARS);
}

function countSyntaxErrors(sql: string, dialect: string): number {
  const tree = lezerDialectFor(dialect).language.parser.parse(sql);
  let count = 0;
  const visit = (node: SyntaxNode): void => {
    if (node.name === "⚠") count += 1;
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child);
  };
  visit(tree.topNode);
  return count;
}

function aliasMap(sql: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /\b(?:from|join)\s+([`"\w$.]+)(?:\s+(?:as\s+)?([`"\w$]+))?/gi;
  for (const match of sql.matchAll(re)) {
    const table = (match[1] ?? "").replace(/[`"]/g, "");
    const alias = (match[2] ?? "").replace(/[`"]/g, "");
    if (table) out.set(table.split(".").at(-1)?.toLowerCase() ?? table.toLowerCase(), table);
    if (table && alias && !/^(where|join|left|right|inner|outer|cross|on|using)$/i.test(alias)) {
      out.set(alias.toLowerCase(), table);
    }
  }
  return out;
}

function hasProvableUnknownQualifiedColumn(
  candidate: string,
  prefix: string,
  suffix: string,
  schemas: AiSchemaTargetContext[],
): boolean {
  const aliases = aliasMap(`${prefix} ${suffix}`);
  const byName = new Map<string, Set<string>>();
  for (const schema of schemas) {
    const columns = new Set((schema.columns ?? []).map((column) => column.name.toLowerCase()));
    if (columns.size === 0 || !schema.table) continue;
    byName.set(schema.table.toLowerCase(), columns);
    if (schema.database) byName.set(`${schema.database}.${schema.table}`.toLowerCase(), columns);
  }
  for (const match of candidate.matchAll(/\b([A-Za-z_][\w$]*)\.([A-Za-z_][\w$]*)\b/g)) {
    const qualifier = (match[1] ?? "").toLowerCase();
    const column = (match[2] ?? "").toLowerCase();
    const table = aliases.get(qualifier)?.toLowerCase() ?? qualifier;
    const columns = byName.get(table) ?? byName.get(table.split(".").at(-1) ?? table);
    if (columns && !columns.has(column)) return true;
  }
  return false;
}

const SQL_NON_COLUMN_WORDS = new Set(
  `all alter and any array as asc between bigint boolean both by case cast char
  column create cross current current_date current_time current_timestamp database
  date day decimal delete desc distinct double else end escape except exists false
  fetch first float following from full group groups having hour if ilike in inner
  insert int integer intersect interval into is join last lateral left like limit
  map minute month natural next not null nulls offset on only or order outer over
  partition preceding qualify range recursive regexp replace right row rows second
  select semi set smallint table then time timestamp tinyint true unbounded union
  unique unknown update using value values varchar when where window with year`.split(
    /\s+/,
  ),
);

function maskSqlStringsAndComments(sql: string): string {
  return sql.replace(
    /'(?:''|\\.|[^'])*'|--[^\n]*|\/\*[\s\S]*?\*\//g,
    (match) => " ".repeat(match.length),
  );
}

function queryAliases(sql: string): Set<string> {
  const aliases = new Set<string>();
  for (const match of sql.matchAll(/\bas\s+(?:`([^`]+)`|"([^"]+)"|([A-Za-z_][\w$]*))/gi)) {
    const alias = match[1] ?? match[2] ?? match[3];
    if (alias) aliases.add(alias.toLowerCase());
  }
  return aliases;
}

function singleReferencedTableColumns(
  prefix: string,
  suffix: string,
  schemas: AiSchemaTargetContext[],
): Set<string> | null {
  const referenced = new Set(
    [...aliasMap(`${prefix} ${suffix}`).values()].map((table) => table.toLowerCase()),
  );
  const relevant = schemas.filter((schema) => {
    if (!schema.table || (schema.columns?.length ?? 0) === 0) return false;
    if (referenced.size === 0) return schemas.length === 1;
    const table = schema.table.toLowerCase();
    const qualified = schema.database
      ? `${schema.database}.${schema.table}`.toLowerCase()
      : table;
    return referenced.has(table) || referenced.has(qualified);
  });
  const unique = new Map<string, AiSchemaTargetContext>();
  for (const schema of relevant) unique.set(tableKey(schema), schema);
  if (unique.size !== 1) return null;
  const [schema] = unique.values();
  const columns = new Set((schema?.columns ?? []).map((column) => column.name.toLowerCase()));
  return columns.size > 0 ? columns : null;
}

/**
 * With one fully known table, a new bare identifier is provably not a column.
 * Stay conservative for candidates that introduce another table or subquery,
 * where the available schema no longer describes the whole candidate scope.
 */
function hasProvableUnknownUnqualifiedColumn(
  candidate: string,
  prefix: string,
  suffix: string,
  schemas: AiSchemaTargetContext[],
): boolean {
  if (/\b(?:from|join|into|update)\b/i.test(maskSqlStringsAndComments(candidate))) {
    return false;
  }
  const columns = singleReferencedTableColumns(prefix, suffix, schemas);
  if (!columns) return false;
  const allowedAliases = queryAliases(`${prefix} ${suffix} ${candidate}`);
  const sql = maskSqlStringsAndComments(candidate);
  const tokens = [...sql.matchAll(/`([^`]+)`|"([^"]+)"|([A-Za-z_][\w$]*)/g)];
  for (let index = 0; index < tokens.length; index += 1) {
    const match = tokens[index];
    const identifier = (match[1] ?? match[2] ?? match[3] ?? "").toLowerCase();
    if (!identifier || SQL_NON_COLUMN_WORDS.has(identifier) || allowedAliases.has(identifier)) {
      continue;
    }
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const before = sql.slice(0, start).trimEnd().at(-1);
    const after = sql.slice(end).trimStart().at(0);
    if (before === "." || after === "." || before === "@" || before === ":") continue;
    if (after === "(") continue;
    const previous = tokens[index - 1];
    const previousIdentifier = (
      previous?.[1] ??
      previous?.[2] ??
      previous?.[3] ??
      ""
    ).toLowerCase();
    if (previousIdentifier === "as") continue;
    if (!columns.has(identifier)) return true;
  }
  return false;
}

export function isCompletionCandidateSafe(input: {
  text: string;
  prefix: string;
  suffix: string;
  dialect: string;
  schemas: AiSchemaTargetContext[];
  averageLogprob: number | null;
}): boolean {
  const candidate = input.text;
  if (!candidate.trim()) return false;
  if (input.averageLogprob !== null && input.averageLogprob < MIN_AVERAGE_LOGPROB) return false;
  if (hasProvableUnknownQualifiedColumn(candidate, input.prefix, input.suffix, input.schemas)) {
    return false;
  }
  if (hasProvableUnknownUnqualifiedColumn(candidate, input.prefix, input.suffix, input.schemas)) {
    return false;
  }
  const before = countSyntaxErrors(`${input.prefix}${input.suffix}`, input.dialect);
  const after = countSyntaxErrors(`${input.prefix}${candidate}${input.suffix}`, input.dialect);
  return after <= before;
}

export async function runInlineCompletion(
  vaultPath: string,
  slug: string,
  request: AiInlineCompletionRequest,
  signal: AbortSignal,
  onEvent: (event: AiInlineCompletionEvent) => void,
): Promise<void> {
  log.info("request received", {
    requestId: request.requestId,
    connectionName: request.connectionName,
    prefixLength: request.prefix.length,
    suffixLength: request.suffix.length,
    siblingCount: request.siblingSqls.length,
  });
  onEvent({ type: "started", requestId: request.requestId });
  try {
    const settings = await settingsStore.loadAppSettings(vaultPath);
    const profileId = settings.ai.completionProfileId;
    if (settings.ai.providerMode === "disabled") {
      throw new AppError("ai_inline_completion_disabled", "AI is disabled.");
    }
    if (!settings.ai.inlineCompletionEnabled) {
      throw new AppError("ai_inline_completion_disabled", "AI inline completion is disabled.");
    }
    if (!profileId) {
      throw new AppError("ai_missing_completion_profile", "No AI inline completion profile is configured.");
    }
    const profile = settings.ai.profiles.find((item) => item.id === profileId);
    if (!profile) {
      throw new AppError("ai_missing_completion_profile", "The AI inline completion profile no longer exists.");
    }

    const connections = await connectionsStore.loadConnections(vaultPath, slug);
    const connection = request.connectionName ? connections[request.connectionName] : undefined;
    const dialect = connection
      ? resolveDialect({ kind: connection.kind, displayName: connection.kind })
      : "Standard SQL";
    const tables = referencedTableNames(request);
    const schemas =
      connection && request.connectionName
        ? await loadSchemaDirTableSchemas({
            connectionName: request.connectionName,
            schemaDir: connection.schemaDir,
            tableNames: tables,
          })
        : [];
    const availableSchemas = mergeCompletionSchemas(request.tableSchemas ?? [], schemas);
    if (!hasSchemasForReferencedTables(tables, availableSchemas)) {
      log.info("request suppressed because referenced table schema is unavailable", {
        requestId: request.requestId,
        tables,
      });
      onEvent({ type: "final", requestId: request.requestId });
      return;
    }
    const apiKey = await loadApiKey(vaultPath, slug, profile.id);
    let rawText = "";
    const prompt = buildInlineCompletionPrompt({ request, dialect, tables, schemas });
    const preparedSchemas = prepareInlineCompletionContext({
      request,
      dialect,
      tables,
      schemas,
    }).schemas;
    await streamChatCompletions({
      settings: settings.ai,
      apiKey,
      system: prompt.system,
      user: prompt.user,
      profileId: profile.id,
      sessionId: `stela-inline:${profile.id}`,
      signal,
      maxTokens: 64,
      onDelta: (text) => {
        rawText += text;
      },
    });

    const text = sanitizeCompletionCandidate(rawText);
    if (
      isCompletionCandidateSafe({
        text,
        prefix: request.prefix.slice(-MAX_PREFIX_CHARS),
        suffix: request.suffix.slice(0, MAX_SUFFIX_CHARS),
        dialect,
        schemas: preparedSchemas,
        averageLogprob: null,
      })
    ) {
      onEvent({ type: "delta", requestId: request.requestId, text });
    } else {
      log.info("candidate suppressed", { requestId: request.requestId });
    }
    onEvent({ type: "final", requestId: request.requestId });
  } catch (err) {
    if (isCancellation(err, signal)) {
      log.info("request cancelled", { requestId: request.requestId });
      onEvent({ type: "cancelled", requestId: request.requestId });
      return;
    }
    log.warn("request failed", {
      requestId: request.requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    onEvent({
      type: "error",
      requestId: request.requestId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
