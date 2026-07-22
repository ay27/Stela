import { AppError } from "@shared/errors";
import { resolveDialect } from "@shared/sql-dialect";
import type {
  AiInlineCompletionEvent,
  AiInlineCompletionRequest,
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

    const symbols = extractSqlSymbols(`${request.prefix}\n${request.suffix}`);
    const ctes = new Set(symbols.ctes.map((name) => name.toLowerCase()));
    const tables = symbols.tables
      .filter((name) => !ctes.has(name.toLowerCase()))
      .slice(0, MAX_TABLES);
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
    });

    const schemaText = [
      tables.length > 0 ? `Referenced tables: ${tables.join(", ")}` : "Referenced tables: none",
      ...schemas.flatMap((schema) =>
        schema.ddlSnippet
          ? [`\nTable ${schema.database ? `${schema.database}.` : ""}${schema.table}:\n${schema.ddlSnippet}`]
          : [],
      ),
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
    const user = `Language: SQL
Dialect: ${dialect}
Schema:
${safe.schema}

Nearby RunSQL blocks (nearest first):
${safe.siblingSqls || "(none)"}

Prefix:
${safe.prefix}
<CURSOR>
Suffix:
${safe.suffix}`;
    const apiKey = await loadApiKey(vaultPath, slug, profile.id);
    await streamChatCompletions({
      settings: settings.ai,
      apiKey,
      system: SYSTEM_PROMPT,
      user,
      profileId: profile.id,
      signal,
      onDelta: (text) =>
        onEvent({ type: "delta", requestId: request.requestId, text }),
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
