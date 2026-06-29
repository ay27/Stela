import type {
  AiCompleteRequest,
  AiCompleteResponse,
  AiProviderStatus,
  AiSettings,
} from "@shared/types";

import * as settingsStore from "../settings-store";
import * as connectionsStore from "../connections-store";
import * as connectorRegistry from "../connectors/registry";
import { getLogger } from "../logger";
import { buildAiContext } from "./context-builder";
import { buildPrompt } from "./prompt-builder";
import { formatPromptDebugLog } from "./prompt-logging";
import { mergeSchemaTargets, resolveMentionedSchemaContext, resolveSchemaContext } from "./schema-context";
import {
  callChatCompletions,
  clearApiKey,
  configureProvider,
  getProviderStatus,
  loadApiKey,
} from "./provider";

const log = getLogger("ai");

function extractSql(text: string): string | null {
  const match = /```sql\s*([\s\S]*?)```/i.exec(text);
  return match?.[1]?.trim() || null;
}

function dialectFromKind(kind: string, displayName: string): string {
  const key = `${kind} ${displayName}`.toLowerCase();
  if (key.includes("starrocks")) return "StarRocks";
  if (key.includes("postgres")) return "PostgreSQL";
  if (key.includes("mysql")) return "MySQL";
  if (key.includes("sqlite")) return "SQLite";
  if (key.includes("duckdb")) return "DuckDB";
  return displayName || kind;
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
          dialect: dialectFromKind(entry.kind, displayName),
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
): Promise<AiProviderStatus> {
  return configureProvider(vaultPath, slug, settings, apiKey);
}

export async function clearSecret(
  vaultPath: string,
  slug: string,
): Promise<AiProviderStatus> {
  await clearApiKey(vaultPath, slug);
  return getProviderStatus(vaultPath);
}

export async function complete(
  vaultPath: string,
  slug: string,
  request: AiCompleteRequest,
): Promise<AiCompleteResponse> {
  const settings = await settingsStore.loadAppSettings(vaultPath);
  const enrichedRequest = await enrichConnectorContext(vaultPath, slug, request);
  const schemaRequest = await enrichSchemaContext(vaultPath, slug, enrichedRequest);
  const bundle = buildAiContext(
    schemaRequest,
    settings.ai.sendResultSamples ? settings.ai.maxSampleRows : 0,
  );
  const prompt = buildPrompt(bundle);
  log.info("\n" + formatPromptDebugLog(bundle, prompt));
  const apiKey = await loadApiKey(vaultPath, slug);
  const text = await callChatCompletions({
    settings: settings.ai,
    apiKey,
    system: prompt.system,
    user: prompt.user,
  });
  return {
    action: schemaRequest.action,
    text,
    sql: extractSql(text),
    warnings: bundle.summary,
    contextSummary: bundle.summary,
  };
}

