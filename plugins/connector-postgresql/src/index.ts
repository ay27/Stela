/**
 * Stela PostgreSQL connector 插件（官方，进程内 module 形态）。
 */

import { Pool, type PoolClient, type QueryResult as PgQueryResult } from "pg";

import {
  CONNECTOR_PLUGIN_API_VERSION,
  PluginError,
  defineConnectorPlugin,
  type ColumnDef,
  type Connector,
  type ConnectorKindMeta,
  type PluginContext,
  type QueryResult,
  type TestResult,
} from "@stela/connector-plugin-sdk";

interface PostgresConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database?: string;
  ssl?: boolean;
}

const QUERY_RE = /^\s*(SELECT|SHOW|WITH|EXPLAIN|VALUES|TABLE)\b/is;

function coercePort(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = parseInt(v, 10);
    if (!Number.isNaN(n)) return n;
  }
  return 5432;
}

function coerceBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return ["1", "true", "yes"].includes(v.toLowerCase());
  return false;
}

function parseConfig(raw: unknown): PostgresConfig {
  const v = (raw ?? {}) as Record<string, unknown>;
  const user = (v.user as string | undefined) ?? "";
  if (!user) {
    throw new PluginError("bad_config", "postgresql.user required");
  }
  return {
    host: (v.host as string) || "127.0.0.1",
    port: coercePort(v.port),
    user,
    password: (v.password as string) || "",
    database: (v.database as string) || undefined,
    ssl: coerceBool(v.ssl),
  };
}

function cacheKey(c: PostgresConfig): string {
  return `${c.user}@${c.host}:${c.port}/${c.database ?? ""}?ssl=${String(c.ssl)}`;
}

function normalizeCell(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().replace(".000Z", "Z");
  if (Buffer.isBuffer(v)) return `<base64:${v.toString("base64")}>`;
  if (typeof v === "bigint") return v.toString();
  return v;
}

function oidToTypeName(oid: number | undefined): string {
  const map: Record<number, string> = {
    16: "BOOLEAN",
    17: "BYTEA",
    20: "BIGINT",
    21: "SMALLINT",
    23: "INTEGER",
    25: "TEXT",
    700: "REAL",
    701: "DOUBLE PRECISION",
    1082: "DATE",
    1083: "TIME",
    1114: "TIMESTAMP",
    1184: "TIMESTAMPTZ",
    1700: "NUMERIC",
    2950: "UUID",
    3802: "JSONB",
  };
  return oid === undefined ? "UNKNOWN" : (map[oid] ?? `OID_${oid}`);
}

function columnsFromResult(result: PgQueryResult): ColumnDef[] {
  return result.fields.map((field) => ({
    name: field.name,
    typeName: oidToTypeName(field.dataTypeID),
  }));
}

class PostgresConnector implements Connector {
  private readonly pools = new Map<string, Pool>();
  private readonly log: PluginContext["log"];

  constructor(ctx: PluginContext) {
    this.log = ctx.log;
  }

  private getPool(cfg: PostgresConfig): Pool {
    const key = cacheKey(cfg);
    const existing = this.pools.get(key);
    if (existing) return existing;
    const pool = new Pool({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      max: 4,
      ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
    });
    this.pools.set(key, pool);
    return pool;
  }

  meta(): ConnectorKindMeta {
    return {
      kind: "postgresql",
      displayName: "PostgreSQL",
      configSchema: {
        type: "object",
        properties: {
          host: { type: "string", default: "127.0.0.1" },
          port: { type: "integer", default: 5432 },
          user: { type: "string" },
          password: { type: "string", format: "password" },
          database: { type: "string" },
          ssl: { type: "boolean", default: false },
        },
        required: ["host", "port", "user"],
      },
      defaultConfig: {
        host: "127.0.0.1",
        port: 5432,
        user: "postgres",
        password: "",
        database: "",
        ssl: false,
      },
      subprocess: false,
      dialect: "PostgreSQL",
    };
  }

  async test(cfg: unknown): Promise<TestResult> {
    const c = parseConfig(cfg);
    const pool = this.getPool(c);
    const started = Date.now();
    try {
      await pool.query("SELECT 1");
      return {
        ok: true,
        message: `connected to ${c.host}:${c.port}`,
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      throw new PluginError(
        "test_failed",
        (err as Error).message ?? "test failed",
      );
    }
  }

  async execute(cfg: unknown, sql: string): Promise<QueryResult> {
    const c = parseConfig(cfg);
    const pool = this.getPool(c);
    const started = Date.now();
    try {
      const result = await pool.query({ text: sql, rowMode: "array" });
      if (QUERY_RE.test(sql) || result.fields.length > 0) {
        return {
          kind: "query",
          columns: columnsFromResult(result),
          rows: (result.rows as unknown[][]).map((row) =>
            row.map((cell) => normalizeCell(cell)),
          ),
          elapsedMs: Date.now() - started,
        };
      }
      return {
        kind: "mutation",
        affectedRows: result.rowCount ?? 0,
        elapsedMs: Date.now() - started,
      };
    } catch (err) {
      throw new PluginError(
        QUERY_RE.test(sql) ? "query_failed" : "mutation_failed",
        (err as Error).message ?? "execute failed",
      );
    }
  }

  async listDatabases(cfg: unknown): Promise<string[]> {
    const c = parseConfig(cfg);
    const pool = this.getPool({ ...c, database: c.database || "postgres" });
    const result = await pool.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname",
    );
    return result.rows.map((row) => row.datname);
  }

  async listTables(cfg: unknown, db?: string | null): Promise<string[]> {
    const c = parseConfig(cfg);
    const pool = this.getPool({ ...c, database: db || c.database });
    let client: PoolClient | null = null;
    try {
      client = await pool.connect();
      const result = await client.query<{ table_name: string }>(
        "SELECT table_schema || '.' || table_name AS table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_type = 'BASE TABLE' ORDER BY table_schema, table_name",
      );
      return result.rows.map((row) => row.table_name);
    } finally {
      client?.release();
    }
  }

  async dispose(): Promise<void> {
    for (const [key, pool] of this.pools.entries()) {
      try {
        await pool.end();
      } catch (err) {
        this.log.warn("pool end failed", { key, err: (err as Error).message });
      }
    }
    this.pools.clear();
  }
}

export default defineConnectorPlugin({
  apiVersion: CONNECTOR_PLUGIN_API_VERSION,
  create(ctx) {
    return new PostgresConnector(ctx);
  },
});
