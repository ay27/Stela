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
  type TableDescriptor,
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
const DESCRIBE_CONCURRENCY = 4;

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

function quoteIdentifier(value: string): string {
  return `\`${value.replace(/`/g, "``")}\``;
}

function columnIndex(columns: ColumnDef[], candidates: string[]): number {
  const names = new Set(candidates.map((candidate) => candidate.toLowerCase()));
  return columns.findIndex((column) => names.has(column.name.toLowerCase()));
}

async function describeTable(
  cfg: HttpSampleConfig,
  database: string | null,
  table: string,
): Promise<TableDescriptor | null> {
  const tableRef = database
    ? `${quoteIdentifier(database)}.${quoteIdentifier(table)}`
    : quoteIdentifier(table);
  try {
    const result = await postSql(cfg, `SHOW FULL COLUMNS FROM ${tableRef}`);
    if (result.kind !== "query") return null;
    const nameIndex = columnIndex(result.columns, ["field", "column", "column_name", "name"]);
    const typeIndex = columnIndex(result.columns, ["type", "data_type", "typename", "type_name"]);
    const commentIndex = columnIndex(result.columns, ["comment", "column_comment"]);
    if (nameIndex < 0) return null;
    return {
      database,
      table,
      columns: result.rows.flatMap((row) => {
        const name = row[nameIndex];
        if (typeof name !== "string" || name.length === 0) return [];
        const typeName = typeIndex >= 0 ? row[typeIndex] : null;
        const comment = commentIndex >= 0 ? row[commentIndex] : null;
        return [{
          name,
          typeName: typeof typeName === "string" && typeName ? typeName : "UNKNOWN",
          ...(typeof comment === "string" && comment ? { comment } : {}),
        }];
      }),
      ddlSnippet: null,
    };
  } catch {
    return null;
  }
}

async function describeTablesConcurrent(
  cfg: HttpSampleConfig,
  tables: Array<{ database: string | null; table: string }>,
): Promise<TableDescriptor[]> {
  const results = new Array<TableDescriptor | null>(tables.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(DESCRIBE_CONCURRENCY, tables.length) },
    async () => {
      while (nextIndex < tables.length) {
        const index = nextIndex;
        nextIndex += 1;
        const target = tables[index];
        results[index] = target
          ? await describeTable(cfg, target.database, target.table)
          : null;
      }
    },
  );
  await Promise.all(workers);
  return results.filter((table): table is TableDescriptor => table !== null);
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

  async describeTables(
    cfg: unknown,
    tables: Array<{ database: string | null; table: string }>,
  ): Promise<TableDescriptor[]> {
    return describeTablesConcurrent(parseConfig(cfg), tables);
  }
}

export default defineConnectorPlugin({
  apiVersion: CONNECTOR_PLUGIN_API_VERSION,
  create() {
    return new HttpSampleConnector();
  },
});
