import type {
  AiCompleteRequest,
  AiCompleteResponse,
  AiParseSqlQueryRequest,
  AiParseSqlQueryResponse,
  AiProviderStatus,
  AiSettings,
} from "@shared/types";
import { AppError, isAppError } from "@shared/errors";
import { resolveDialect } from "@shared/sql-dialect";
import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";

import * as settingsStore from "../settings-store";
import * as connectionsStore from "../connections-store";
import * as connectorRegistry from "../connectors/registry";
import * as sqlIndex from "../sql-index";
import { getLogger } from "../logger";
import { buildAiContext } from "./context-builder";
import { buildPrompt } from "./prompt-builder";
import { formatPromptDebugLog } from "./prompt-logging";
import { mergeSchemaTargets, resolveMentionedSchemaContext, resolveSchemaContext } from "./schema-context";
import { buildSqlQueryParsePrompt, parseModelFilterOutput } from "./sql-query-parser";
import {
  callChatCompletions,
  clearApiKey,
  configureProvider,
  createTransportForProfile,
  getActiveProfile,
  getProviderStatus,
  loadApiKey,
  deleteProfile,
  upsertProfile,
} from "./provider";
import * as agentMetrics from "./agent-metrics";

const log = getLogger("ai");

function metricError(err: unknown): { code: string; message: string } {
  return {
    code: isAppError(err) ? err.code : "unknown_error",
    message: err instanceof Error ? err.message : String(err),
  };
}

function messageUsage(message: AssistantMessage | null) {
  return {
    inputTokens: message?.usage.input ?? 0,
    outputTokens: message?.usage.output ?? 0,
    cacheReadTokens: message?.usage.cacheRead ?? 0,
    cacheWriteTokens: message?.usage.cacheWrite ?? 0,
  };
}

function extractSql(text: string): string | null {
  const match = /```sql\s*([\s\S]*?)```/i.exec(text);
  return match?.[1]?.trim() || null;
}

async function enrichConnectorContext(
  vaultPath: string,
  slug: string,
  request: AiCompleteRequest,
): Promise<AiCompleteRequest> {
  const connectionName =
    request.context.connectionName ?? request.context.schema?.connectionName ?? null;
  if (!connectionName || request.context.connector) return request;
  try {
    const connections = await connectionsStore.loadConnections(vaultPath, slug);
    const entry = connections[connectionName];
    if (!entry) return request;
    const meta = connectorRegistry
      .listKinds()
      .find((item) => item.kind === entry.kind);
    const displayName = meta?.displayName ?? entry.kind;
    return {
      ...request,
      context: {
        ...request.context,
        connector: {
          kind: entry.kind,
          displayName,
          dialect: resolveDialect({ kind: entry.kind, displayName, dialect: meta?.dialect }),
        },
      },
    };
  } catch {
    return request;
  }
}

async function enrichSchemaContext(
  vaultPath: string,
  slug: string,
  request: AiCompleteRequest,
): Promise<AiCompleteRequest> {
  if (request.context.schemas && request.context.schemas.length > 0) {
    return request;
  }
  const connectionName =
    request.context.connectionName ?? request.context.schema?.connectionName ?? null;
  if (!connectionName) return request;
  const initialBundle = buildAiContext(request, 0);
  try {
    const connections = await connectionsStore.loadConnections(vaultPath, slug);
    const connection = connections[connectionName];
    if (!connection) return request;
    const deps = {
      listDatabases: connectorRegistry.listDatabases,
      listTables: connectorRegistry.listTables,
      execute: connectorRegistry.execute,
    };
    const mentionedTables = request.context.mentionedTables ?? [];
    const mentionedSchemas =
      mentionedTables.length > 0
        ? await resolveMentionedSchemaContext({
            mentionedTables,
            connectionName,
            connection,
            request,
            deps,
          })
        : [];
    const sqlSchemas = await resolveSchemaContext({
      request,
      symbols: initialBundle.symbols,
      connectionName,
      connection,
      deps,
    });
    const schemas = mergeSchemaTargets(mentionedSchemas, sqlSchemas, 8);
    if (schemas.length === 0) return request;
    return {
      ...request,
      context: {
        ...request.context,
        schemas,
      },
    };
  } catch {
    return request;
  }
}

export async function getStatus(vaultPath: string): Promise<AiProviderStatus> {
  return getProviderStatus(vaultPath);
}

export async function configure(
  vaultPath: string,
  slug: string,
  settings: Partial<Omit<AiSettings, "hasApiKey">>,
  apiKey?: string | null,
  profileId?: string | null,
): Promise<AiProviderStatus> {
  return configureProvider(vaultPath, slug, settings, apiKey, profileId);
}

export async function clearSecret(
  vaultPath: string,
  slug: string,
  profileId?: string | null,
): Promise<AiProviderStatus> {
  await clearApiKey(vaultPath, slug, profileId);
  return getProviderStatus(vaultPath);
}

export async function saveProfile(
  vaultPath: string,
  slug: string,
  profile: Parameters<typeof upsertProfile>[2],
  apiKey?: string | null,
  makeActive = true,
): Promise<AiProviderStatus> {
  return upsertProfile(vaultPath, slug, profile, apiKey, makeActive);
}

export async function removeProfile(
  vaultPath: string,
  slug: string,
  profileId: string,
): Promise<AiProviderStatus> {
  return deleteProfile(vaultPath, slug, profileId);
}

export async function complete(
  vaultPath: string,
  slug: string,
  request: AiCompleteRequest,
): Promise<AiCompleteResponse> {
  const metricRunId = `action:${randomUUID()}`;
  const startedAt = Date.now();
  const settings = await settingsStore.loadAppSettings(vaultPath);
  const enrichedRequest = await enrichConnectorContext(vaultPath, slug, request);
  const schemaRequest = await enrichSchemaContext(vaultPath, slug, enrichedRequest);
  const bundle = buildAiContext(
    schemaRequest,
    settings.ai.sendResultSamples ? settings.ai.maxSampleRows : 0,
  );
  const prompt = buildPrompt(bundle);
  log.info("\n" + formatPromptDebugLog(bundle, prompt));
  const profile = getActiveProfile(settings.ai);
  let message: AssistantMessage | null = null;
  if (agentMetrics.isOpen()) {
    agentMetrics.startRun({
      runId: metricRunId,
      surface: "ai_action",
      operation: schemaRequest.action,
      startedAt,
      profileId: profile.id,
      vendorId: profile.vendorId,
      model: profile.model,
      request: { request: schemaRequest, prompt },
    });
  }
  try {
    const apiKey = await loadApiKey(vaultPath, slug, profile.id);
    const text = await callChatCompletions({
      settings: settings.ai,
      apiKey,
      system: prompt.system,
      user: prompt.user,
      profileId: profile.id,
      onMessage: (result) => { message = result; },
    });
    const response: AiCompleteResponse = {
      action: schemaRequest.action,
      text,
      sql: extractSql(text),
      warnings: bundle.summary,
      contextSummary: bundle.summary,
    };
    if (agentMetrics.isOpen()) {
      agentMetrics.finishRun(metricRunId, { status: "completed", ...messageUsage(message), response });
    }
    return response;
  } catch (err) {
    if (agentMetrics.isOpen()) {
      const failure = metricError(err);
      agentMetrics.finishRun(metricRunId, {
        status: failure.code === "ai_aborted" ? "cancelled" : "error",
        ...messageUsage(message),
        errorCode: failure.code,
        errorMessage: failure.message,
      });
    }
    throw err;
  }
}

/**
 * NL → SQL 索引 filter JSON。只翻译不作答：真正命中一律走 `sql-index.ts` 的
 * 确定性倒排索引求交集，这里产出的 filter 只是"用户想查什么"的结构化猜测。
 */
export async function parseSqlQuery(
  vaultPath: string,
  slug: string,
  request: AiParseSqlQueryRequest,
): Promise<AiParseSqlQueryResponse> {
  const metricRunId = `parse:${randomUUID()}`;
  const startedAt = Date.now();
  const settings = await settingsStore.loadAppSettings(vaultPath);
  const profile = getActiveProfile(settings.ai);
  const facetsData = await sqlIndex.facets();
  const locale = request.locale ?? "zh";
  const { system, instructions } = buildSqlQueryParsePrompt(facetsData, locale);
  const prompt = { system: `${system}\n\n${instructions}`, user: request.question };
  let message: AssistantMessage | null = null;
  if (agentMetrics.isOpen()) {
    agentMetrics.startRun({
      runId: metricRunId,
      surface: "sql_query_parse",
      operation: "parse_sql_query",
      startedAt,
      profileId: profile.id,
      vendorId: profile.vendorId,
      model: profile.model,
      request: { request, prompt },
    });
  }
  try {
    const apiKey = await loadApiKey(vaultPath, slug, profile.id);
    const text = await callChatCompletions({
      settings: settings.ai,
      apiKey,
      system: prompt.system,
      user: prompt.user,
      profileId: profile.id,
      onMessage: (result) => { message = result; },
    });
    const { filter, warnings } = parseModelFilterOutput(text);
    const response = { filter, warnings };
    if (agentMetrics.isOpen()) {
      agentMetrics.finishRun(metricRunId, { status: "completed", ...messageUsage(message), response });
    }
    return response;
  } catch (err) {
    if (!isAppError(err)) {
      log.error("parseSqlQuery: failed to parse model output", {
        err: err instanceof Error ? err.message : String(err),
        text: "Model output omitted from application log; see local Agent Dashboard trace.",
      });
    }
    const wrapped = isAppError(err) ? err : new AppError(
      "ai_parse_sql_query_failed",
      "AI did not return a valid filter JSON for the SQL query.",
    );
    if (agentMetrics.isOpen()) {
      const failure = metricError(wrapped);
      agentMetrics.finishRun(metricRunId, {
        status: failure.code === "ai_aborted" ? "cancelled" : "error",
        ...messageUsage(message),
        errorCode: failure.code,
        errorMessage: failure.message,
      });
    }
    throw wrapped;
  }
}

// re-export for tests / callers that need transport helpers
export { createTransportForProfile, getActiveProfile };
