import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import {
  Binary,
  Decimal128,
  Long,
  MongoClient,
  ObjectId,
  type Document,
} from "mongodb";

import {
  CONNECTOR_PLUGIN_API_VERSION,
  PluginError,
  defineConnectorPlugin,
  type ColumnDef,
  type Connector,
  type ConnectorKindMeta,
  type DataQueryRequest,
  type MaterializedQueryResult,
  type PluginContext,
  type QueryArtifactRequest,
  type QueryResult,
  type TableDescriptor,
  type TestResult,
} from "@stela/connector-plugin-sdk";

interface MongoConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  authSource: string;
  tls: boolean;
}

function config(raw: unknown): MongoConfig {
  const value = (raw ?? {}) as Record<string, unknown>;
  const port = typeof value.port === "number" ? value.port : Number(value.port ?? 27017);
  const host = typeof value.host === "string" && value.host.trim() ? value.host.trim() : "127.0.0.1";
  if (/[/?@\s]/.test(host)) {
    throw new PluginError("bad_config", "MongoDB host must be a hostname or IP address");
  }
  return {
    host,
    port: Number.isFinite(port) ? Math.min(65_535, Math.max(1, Math.floor(port))) : 27017,
    username: typeof value.username === "string" ? value.username : "",
    password: typeof value.password === "string" ? value.password : "",
    database: typeof value.database === "string" ? value.database.trim() : "",
    authSource: typeof value.authSource === "string" && value.authSource.trim() ? value.authSource.trim() : "admin",
    tls: value.tls === true || value.tls === "true",
  };
}

function clientUri(value: MongoConfig): string {
  const host = value.host.includes(":") ? `[${value.host}]` : value.host;
  return `mongodb://${host}:${value.port}`;
}

function clientKey(value: MongoConfig): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const FORBIDDEN_MONGO_OPERATORS = new Set(["$where", "$function", "$accumulator"]);

function containsServerSideJavaScript(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsServerSideJavaScript);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([key, nested]) => FORBIDDEN_MONGO_OPERATORS.has(key.toLowerCase()) || containsServerSideJavaScript(nested),
  );
}

function normalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof ObjectId) return value.toHexString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Decimal128 || value instanceof Long) return value.toString();
  if (value instanceof Binary) return `<base64:${Buffer.from(value.buffer).toString("base64")}>`;
  if (Buffer.isBuffer(value)) return `<base64:${value.toString("base64")}>`;
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, normalize(nested)]),
    );
  }
  return value;
}

function typeName(values: unknown[]): string {
  const value = values.find((item) => item !== null && item !== undefined);
  if (value === undefined) return "UNKNOWN";
  if (Array.isArray(value)) return "ARRAY";
  if (typeof value === "object") return "JSON";
  if (typeof value === "boolean") return "BOOLEAN";
  if (typeof value === "number") return Number.isInteger(value) ? "BIGINT" : "DOUBLE";
  return "TEXT";
}

function tabular(documents: Document[]): { columns: ColumnDef[]; rows: unknown[][]; records: Record<string, unknown>[] } {
  const records = documents.map((document) => normalize(document) as Record<string, unknown>);
  const names = Array.from(new Set(records.flatMap((record) => Object.keys(record))));
  const columns = names.map((name) => ({
    name,
    typeName: typeName(records.map((record) => record[name])),
  }));
  return { columns, rows: records.map((record) => names.map((name) => record[name] ?? null)), records };
}

function mongoQuery(request: DataQueryRequest): Extract<DataQueryRequest, { language: "mongodb" }> {
  if (request.language !== "mongodb") {
    throw new PluginError("unsupported_query_language", "MongoDB connector accepts mongodb queries only");
  }
  if (!request.collection.trim()) throw new PluginError("invalid_query", "collection is required");
  if (containsServerSideJavaScript(request.filter) || containsServerSideJavaScript(request.projection)) {
    throw new PluginError("unsafe_query", "MongoDB server-side JavaScript operators are not allowed");
  }
  return request;
}

class MongoConnector implements Connector {
  private readonly clients = new Map<string, MongoClient>();
  private readonly log: PluginContext["log"];

  constructor(context: PluginContext) {
    this.log = context.log;
  }

  meta(): ConnectorKindMeta {
    return {
      kind: "mongodb",
      displayName: "MongoDB",
      subprocess: false,
      dialect: "MongoDB find",
      queryLanguages: ["mongodb"],
      queryArtifactFormats: ["jsonl"],
      configSchema: {
        type: "object",
        properties: {
          host: { type: "string", default: "127.0.0.1" },
          port: { type: "integer", default: 27017 },
          username: { type: "string" },
          password: { type: "string", format: "password" },
          database: { type: "string" },
          authSource: { type: "string", default: "admin" },
          tls: { type: "boolean", default: false },
        },
        required: ["host", "port"],
      },
      defaultConfig: {
        host: "127.0.0.1",
        port: 27017,
        username: "",
        password: "",
        database: "",
        authSource: "admin",
        tls: false,
      },
    };
  }

  private getClient(raw: unknown): MongoClient {
    const parsed = config(raw);
    const key = clientKey(parsed);
    const existing = this.clients.get(key);
    if (existing) return existing;
    const created = new MongoClient(clientUri(parsed), {
      serverSelectionTimeoutMS: 10_000,
      tls: parsed.tls,
      ...(parsed.username
        ? { auth: { username: parsed.username, password: parsed.password }, authSource: parsed.authSource }
        : {}),
    });
    this.clients.set(key, created);
    return created;
  }

  private databaseName(raw: unknown, requested?: string | null): string {
    const name = requested?.trim() || config(raw).database;
    if (!name) throw new PluginError("bad_config", "MongoDB database is required");
    return name;
  }

  async test(raw: unknown): Promise<TestResult> {
    const started = Date.now();
    await this.getClient(raw).db("admin").command({ ping: 1 });
    return { ok: true, message: "MongoDB connected", latencyMs: Date.now() - started };
  }

  async execute(_raw: unknown, _sql: string): Promise<QueryResult> {
    throw new PluginError("unsupported_query_language", "MongoDB connections do not execute SQL");
  }

  async executeQuery(raw: unknown, input: DataQueryRequest): Promise<QueryResult> {
    const query = mongoQuery(input);
    const started = Date.now();
    let cursor = this.getClient(raw)
      .db(this.databaseName(raw, query.database))
      .collection(query.collection)
      .find(query.filter ?? {}, { projection: query.projection ?? undefined });
    if (query.limit !== null) cursor = cursor.limit(query.limit ?? 200);
    const table = tabular(await cursor.toArray());
    return { kind: "query", columns: table.columns, rows: table.rows, elapsedMs: Date.now() - started };
  }

  async materializeDataQuery(
    raw: unknown,
    input: DataQueryRequest,
    artifact: QueryArtifactRequest,
  ): Promise<MaterializedQueryResult> {
    if (artifact.format !== "jsonl") throw new PluginError("unsupported_artifact", "MongoDB supports JSONL artifacts only");
    const query = mongoQuery(input);
    const started = Date.now();
    let cursor = this.getClient(raw)
      .db(this.databaseName(raw, query.database))
      .collection(query.collection)
      .find(query.filter ?? {}, { projection: query.projection ?? undefined });
    if (query.limit !== null) cursor = cursor.limit(query.limit ?? 200);
    const handle = await fs.open(artifact.outputPath, "wx");
    const previewRecords: Record<string, unknown>[] = [];
    const fieldSamples = new Map<string, unknown[]>();
    let bytes = 0;
    let rowCount = 0;
    try {
      for await (const document of cursor) {
        const record = normalize(document) as Record<string, unknown>;
        for (const [name, value] of Object.entries(record)) {
          const samples = fieldSamples.get(name) ?? [];
          if (samples.length < 20) samples.push(value);
          fieldSamples.set(name, samples);
        }
        const line = `${JSON.stringify(record)}\n`;
        bytes += Buffer.byteLength(line);
        if (bytes > artifact.maxBytes) throw new PluginError("artifact_too_large", `MongoDB artifact exceeds ${artifact.maxBytes} bytes`);
        await handle.write(line);
        rowCount += 1;
        if (previewRecords.length < artifact.previewRows) previewRecords.push(record);
      }
      await handle.close();
    } catch (error) {
      await handle.close().catch(() => {});
      await fs.rm(artifact.outputPath, { force: true });
      throw error;
    }
    const columns = [...fieldSamples.entries()].map(([name, samples]) => ({
      name,
      typeName: typeName(samples),
    }));
    return {
      kind: "query",
      columns,
      previewRows: previewRecords.map((record) => columns.map((column) => record[column.name] ?? null)),
      rowCount,
      elapsedMs: Date.now() - started,
    };
  }

  async listDatabases(raw: unknown): Promise<string[]> {
    const result = await this.getClient(raw).db("admin").admin().listDatabases();
    return result.databases.map((database) => database.name).sort();
  }

  async listTables(raw: unknown, database?: string | null): Promise<string[]> {
    const rows = await this.getClient(raw)
      .db(this.databaseName(raw, database))
      .listCollections({}, { nameOnly: true })
      .toArray();
    return rows.map((row) => row.name).sort();
  }

  async describeTables(
    raw: unknown,
    tables: Array<{ database: string | null; table: string }>,
  ): Promise<TableDescriptor[]> {
    const client = this.getClient(raw);
    return Promise.all(tables.map(async ({ database, table }) => {
      const documents = await client.db(this.databaseName(raw, database)).collection(table).find({}).limit(100).toArray();
      const normalized = documents.map((document) => normalize(document) as Record<string, unknown>);
      const names = Array.from(new Set(normalized.flatMap((document) => Object.keys(document))));
      return {
        database,
        table,
        columns: names.map((name) => ({ name, typeName: typeName(normalized.map((document) => document[name])) })),
        ddlSnippet: null,
      };
    }));
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.clients.values()].map((client) => client.close().catch((error) => {
      this.log.warn("MongoDB client close failed", { error: String(error) });
    })));
    this.clients.clear();
  }
}

export default defineConnectorPlugin({
  apiVersion: CONNECTOR_PLUGIN_API_VERSION,
  create: (context) => new MongoConnector(context),
});
