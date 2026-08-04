import { AppError } from "@shared/errors";
import { resolveDialect } from "@shared/sql-dialect";
import type {
  AiInlineCompletionEvent,
  AiInlineCompletionRequest,
  AiSchemaTargetContext,
} from "@shared/types";

import * as connectionsStore from "../connections-store";
import { getLogger } from "../logger";
import * as settingsStore from "../settings-store";
import { loadApiKey, streamChatCompletions } from "./provider";
import { redactForPrompt } from "./redaction";
import { loadSchemaDirTableSchemas } from "./schema-context";
import { extractSqlSymbols } from "./sql-symbols";

const MAX_PREFIX_CHARS = 12_000;
const MAX_SUFFIX_CHARS = 8_000;
const MAX_SIBLING_SQL_CHARS = 8_000;
const MAX_SCHEMA_CHARS = 12_000;
const MAX_PROSE_CHARS = 500;
const MAX_TABLES = 5;
const log = getLogger("ai.inline-completion");

const SYSTEM_PROMPT = `Complete SQL at the cursor.
Output only the exact text to insert.
Output at most one line.
Never repeat the prefix or suffix.
Do not use Markdown fences or explanations.
Preserve the indentation established by the prefix.
Include required leading whitespace; never concatenate separate SQL tokens.
Use nearby RunSQL blocks only as reference; do not continue or repeat them.
Stop as soon as the existing suffix can continue naturally.`;

function joinSiblingSqls(sqls: string[]): string {
  let remaining = MAX_SIBLING_SQL_CHARS;
  const parts: string[] = [];
  for (const sql of sqls) {
    const text = sql.trim();
    if (!text) continue;
    const separatorLength = parts.length > 0 ? 2 : 0;
    const available = remaining - separatorLength;
    if (available <= 0) break;
    const part = text.slice(0, available);
    parts.push(part);
    remaining -= separatorLength + part.length;
    if (part.length < text.length) break;
  }
  return parts.join("\n\n");
}

function isCancellation(err: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (err instanceof AppError && err.code === "ai_aborted")
  );
}

/** prefix/suffix 里出现过、且不是 CTE 别名的表名，最多 MAX_TABLES 个。 */
export function referencedTableNames(request: AiInlineCompletionRequest): string[] {
  const symbols = extractSqlSymbols(`${request.prefix}\n${request.suffix}`);
  const ctes = new Set(symbols.ctes.map((name) => name.toLowerCase()));
  return symbols.tables
    .filter((name) => !ctes.has(name.toLowerCase()))
    .slice(0, MAX_TABLES);
}

/**
 * 纯函数版 prompt 组装。抽出来是为了让 `scripts/eval/run-completion.ts`
 * 评测的就是产品实际发出的 prompt，不会各写一份然后漂移。
 */
export function buildInlineCompletionPrompt(input: {
  request: AiInlineCompletionRequest;
  dialect: string;
  tables: string[];
  schemas: AiSchemaTargetContext[];
}): { system: string; user: string } {
  const { request, dialect, tables, schemas } = input;
  const schemaText = [
    tables.length > 0 ? `Referenced tables: ${tables.join(", ")}` : "Referenced tables: none",
    // renderer 的列缓存来自真实 `LIMIT 0` 探针，优先级高于 schemaDir 的 DDL 文档
    // （后者可能过期，也可能根本没有这张表）。
    ...mergeTableSchemas(request.tableSchemas ?? [], schemas)
      .map(describeTable)
      .filter(Boolean),
  ].join("\n");
  const redacted = redactForPrompt({
    prefix: request.prefix,
    suffix: request.suffix,
    siblingSqls: request.siblingSqls,
    schema: schemaText,
  });
  const safe = {
    prefix: redacted.prefix.slice(-MAX_PREFIX_CHARS),
    suffix: redacted.suffix.slice(0, MAX_SUFFIX_CHARS),
    siblingSqls: joinSiblingSqls(redacted.siblingSqls),
    schema: redacted.schema.slice(0, MAX_SCHEMA_CHARS),
  };
  const noteContext = [
    request.heading ? `Section: ${request.heading}` : null,
    request.prose ? `Notes: ${request.prose.slice(0, MAX_PROSE_CHARS)}` : null,
  ].filter(Boolean);
  const user = `Language: SQL
Dialect: ${dialect}
Schema:
${safe.schema}
${noteContext.length > 0 ? `\nSurrounding note context:\n${noteContext.join("\n")}\n` : ""}
Nearby RunSQL blocks (nearest first):
${safe.siblingSqls || "(none)"}

Prefix:
${safe.prefix}
<CURSOR>
Suffix:
${safe.suffix}`;
  return { system: SYSTEM_PROMPT, user };
}

function tableKey(schema: AiSchemaTargetContext): string {
  return `${schema.database ?? ""}.${schema.table ?? ""}`.toLowerCase();
}

/** 同一张表两边都有时以 renderer 的实测列为准，schemaDir 只补它没覆盖的表。 */
function mergeTableSchemas(
  fromRenderer: AiSchemaTargetContext[],
  fromSchemaDir: AiSchemaTargetContext[],
): AiSchemaTargetContext[] {
  const byKey = new Map(fromRenderer.map((schema) => [tableKey(schema), { ...schema }]));
  for (const schema of fromSchemaDir) {
    const key = tableKey(schema);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, schema);
      continue;
    }
    // schemaDir 的 DDL 里有中文 COMMENT，`LIMIT 0` 探针拿不到，两边合起来才完整。
    existing.ddlSnippet ??= schema.ddlSnippet;
  }
  return [...byKey.values()];
}

/**
 * 有 DDL 就只给 DDL（它本身已含列与 COMMENT，再列一遍是白花预算）；
 * 没有 DDL 的表——也就是只存在于 renderer 列缓存里的那些——才列列名。
 */
function describeTable(schema: AiSchemaTargetContext): string {
  const name = `${schema.database ? `${schema.database}.` : ""}${schema.table ?? "?"}`;
  if (schema.ddlSnippet) return `\nTable ${name}:\n${schema.ddlSnippet}`;
  const columns = (schema.columns ?? [])
    .map(
      (column) =>
        `  ${column.name} ${column.typeName}${column.comment ? ` -- ${column.comment}` : ""}`,
    )
    .join("\n");
  return columns ? `\nTable ${name}:\n${columns}` : "";
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
      throw new AppError(
        "ai_missing_completion_profile",
        "No AI inline completion profile is configured.",
      );
    }
    const profile = settings.ai.profiles.find((item) => item.id === profileId);
    if (!profile) {
      throw new AppError(
        "ai_missing_completion_profile",
        "The AI inline completion profile no longer exists.",
      );
    }
    log.info("request validated", {
      requestId: request.requestId,
      profileId: profile.id,
    });
    const connections = await connectionsStore.loadConnections(vaultPath, slug);
    const connection = request.connectionName
      ? connections[request.connectionName]
      : undefined;
    const dialect = connection
      ? resolveDialect({
          kind: connection.kind,
          displayName: connection.kind,
        })
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
    log.info("context prepared", {
      requestId: request.requestId,
      connectionFound: Boolean(connection),
      tableCount: tables.length,
      schemaCount: schemas.length,
      rendererSchemaCount: request.tableSchemas?.length ?? 0,
      hasHeading: Boolean(request.heading),
      hasProse: Boolean(request.prose),
    });

    const { system, user } = buildInlineCompletionPrompt({
      request,
      dialect,
      tables,
      schemas,
    });
    const apiKey = await loadApiKey(vaultPath, slug, profile.id);
    await streamChatCompletions({
      settings: settings.ai,
      apiKey,
      system,
      user,
      profileId: profile.id,
      signal,
      onDelta: (text) => {
        onEvent({ type: "delta", requestId: request.requestId, text });
      },
    });
    log.info("stream completed", { requestId: request.requestId });
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
