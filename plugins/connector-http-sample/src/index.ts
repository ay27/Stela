/**
 * Public HTTP connector sample.
 *
 * This intentionally points at a local demo endpoint and exposes the endpoint
 * as user config. It is meant as a template for teams that already have an
 * HTTP SQL gateway.
 */

import {
  CONNECTOR_PLUGIN_API_VERSION,
  PluginError,
  defineConnectorPlugin,
  type ColumnDef,
  type Connector,
  type ConnectorKindMeta,
  type QueryResult,
  type TestResult,
} from "@stela/connector-plugin-sdk";

interface HttpSampleConfig {
  endpoint: string;
  authorization?: string;
  timeoutMs: number;
}

interface GatewayEnvelope {
  code?: number;
  message?: string;
  result?: unknown;
  affectedRows?: number;
}

const DEFAULT_ENDPOINT = "http://127.0.0.1:7777/query";
const DEFAULT_TIMEOUT_MS = 30_000;

function parseConfig(raw: unknown): HttpSampleConfig {
  const v = (raw ?? {}) as Record<string, unknown>;
  const endpoint =
    typeof v.endpoint === "string" && v.endpoint.trim()
      ? v.endpoint.trim()
      : DEFAULT_ENDPOINT;
  const authorization =
    typeof v.authorization === "string" && v.authorization.trim()
      ? v.authorization.trim()
      : undefined;
  const timeout =
    typeof v.timeoutMs === "number"
      ? v.timeoutMs
      : typeof v.timeoutMs === "string"
        ? Number(v.timeoutMs)
        : DEFAULT_TIMEOUT_MS;
  return {
    endpoint,
    authorization,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
  };
}

function inferColumns(rows: Record<string, unknown>[]): ColumnDef[] {
  const names = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) names.add(key);
  }
  return [...names].map((name) => ({
    name,
    typeName: inferTypeName(rows.map((row) => row[name])),
  }));
}

function inferTypeName(values: unknown[]): string {
  const sample = values.find((v) => v !== null && v !== undefined);
  switch (typeof sample) {
    case "number":
      return "NUMBER";
    case "boolean":
      return "BOOLEAN";
    case "object":
      return "JSON";
    case "string":
      return "TEXT";
    default:
      return "UNKNOWN";
  }
}

function rowsToArrays(
  rows: Record<string, unknown>[],
  columns: ColumnDef[],
): unknown[][] {
  return rows.map((row) => columns.map((column) => row[column.name] ?? null));
}

function parseEnvelope(payload: unknown, elapsedMs: number): QueryResult {
  const envelope = payload as GatewayEnvelope;
  if (typeof envelope.code === "number" && envelope.code !== 0) {
    throw new PluginError(
      "gateway_error",
      envelope.message || `gateway returned code ${envelope.code}`,
    );
  }

  if (Array.isArray(envelope.result)) {
    const objectRows = envelope.result.map((row) =>
      row && typeof row === "object" && !Array.isArray(row)
        ? (row as Record<string, unknown>)
        : { value: row },
    );
    const columns = inferColumns(objectRows);
    return {
      kind: "query",
      columns,
      rows: rowsToArrays(objectRows, columns),
      elapsedMs,
    };
  }

  return {
    kind: "mutation",
    affectedRows:
      typeof envelope.affectedRows === "number" ? envelope.affectedRows : 0,
    elapsedMs,
  };
}

async function postSql(cfg: HttpSampleConfig, sql: string): Promise<QueryResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(cfg.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cfg.authorization ? { authorization: cfg.authorization } : {}),
      },
      body: JSON.stringify({ sql }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new PluginError("http_error", `HTTP ${res.status} ${res.statusText}`);
    }
    return parseEnvelope(await res.json(), Date.now() - started);
  } catch (err) {
    if (err instanceof PluginError) throw err;
    throw new PluginError(
      (err as Error).name === "AbortError" ? "timeout" : "request_failed",
      (err as Error).message || "HTTP request failed",
      (err as Error).name === "AbortError",
    );
  } finally {
    clearTimeout(timer);
  }
}

class HttpSampleConnector implements Connector {
  meta(): ConnectorKindMeta {
    return {
      kind: "http-sample",
      displayName: "HTTP Gateway Sample",
      configSchema: {
        type: "object",
        properties: {
          endpoint: {
            type: "string",
            default: DEFAULT_ENDPOINT,
            description: "POST endpoint accepting { sql } and returning { code, message, result }",
          },
          authorization: {
            type: "string",
            format: "password",
            description: "Optional Authorization header",
          },
          timeoutMs: {
            type: "integer",
            default: DEFAULT_TIMEOUT_MS,
          },
        },
        required: ["endpoint"],
      },
      defaultConfig: {
        endpoint: DEFAULT_ENDPOINT,
        authorization: "",
        timeoutMs: DEFAULT_TIMEOUT_MS,
      },
      subprocess: false,
    };
  }

  async test(cfg: unknown): Promise<TestResult> {
    const parsed = parseConfig(cfg);
    const started = Date.now();
    await postSql(parsed, "SELECT 1 AS ok");
    return {
      ok: true,
      message: `connected to ${parsed.endpoint}`,
      latencyMs: Date.now() - started,
    };
  }

  async execute(cfg: unknown, sql: string): Promise<QueryResult> {
    return postSql(parseConfig(cfg), sql);
  }

  async listDatabases(): Promise<string[]> {
    return [];
  }

  async listTables(): Promise<string[]> {
    return [];
  }
}

export default defineConnectorPlugin({
  apiVersion: CONNECTOR_PLUGIN_API_VERSION,
  create() {
    return new HttpSampleConnector();
  },
});
