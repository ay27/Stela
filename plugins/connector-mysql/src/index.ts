/**
 * Stela MySQL connector 插件（官方，进程内 module 形态）。
 *
 * 基于 mysql2/promise。原内置 `electron/services/connectors/mysql.ts` 的行为照搬：
 *   - 按 user@host:port/database 缓存 Pool（connectionLimit: 4）
 *   - SELECT/SHOW/DESC/EXPLAIN/WITH → query；其余 → mutation
 *   - 单元格归一化：Date→ISO、Buffer→<base64:...>、BigInt→string、DECIMAL 保留字符串
 *   - dispose()：vault 切换 / 卸载时关掉所有 Pool（module 插件相对子进程多了这步）
 *
 * mysql2 在构建时被 esbuild 内联进 dist/index.cjs（见 build.mjs），运行时无需
 * 额外 node_modules。
 */

import mysql, {
  type Pool,
  type FieldPacket,
  type RowDataPacket,
  type ResultSetHeader,
} from "mysql2/promise";

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

interface MysqlConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database?: string;
}

const QUERY_RE = /^\s*(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN|WITH)\b/is;

/** 把可能是 number / string（连接表单文本框写回的都是 string）的端口收成 number。 */
function coercePort(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = parseInt(v, 10);
    if (!Number.isNaN(n)) return n;
  }
  return 3306;
}

function parseConfig(raw: unknown): MysqlConfig {
  const v = (raw ?? {}) as Record<string, unknown>;
  const user = (v.user as string | undefined) ?? "";
  if (!user) {
    throw new PluginError("bad_config", "mysql.user required");
  }
  return {
    host: (v.host as string) || "127.0.0.1",
    port: coercePort(v.port),
    user,
    password: (v.password as string) || "",
    database: (v.database as string) || undefined,
  };
}

function cacheKey(c: MysqlConfig): string {
  return `${c.user}@${c.host}:${c.port}/${c.database ?? ""}`;
}

function normalizeCell(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    return v.toISOString().replace(".000Z", "Z");
  }
  if (Buffer.isBuffer(v)) {
    return `<base64:${v.toString("base64")}>`;
  }
  if (typeof v === "bigint") {
    return v.toString();
  }
  return v;
}

function fieldsToColumnDefs(fields: FieldPacket[]): ColumnDef[] {
  return fields.map((f) => ({
    name: f.name,
    typeName: typeNameFromCode(f.type),
  }));
}

/** mysql2 的 type 是 protocol code（数字），映射回字符串名让前端表头能展示。 */
function typeNameFromCode(code: number | undefined): string {
  if (code === undefined) return "UNKNOWN";
  const map: Record<number, string> = {
    0: "DECIMAL",
    1: "TINY",
    2: "SHORT",
    3: "LONG",
    4: "FLOAT",
    5: "DOUBLE",
    6: "NULL",
    7: "TIMESTAMP",
    8: "LONGLONG",
    9: "INT24",
    10: "DATE",
    11: "TIME",
    12: "DATETIME",
    13: "YEAR",
    15: "VARCHAR",
    16: "BIT",
    245: "JSON",
    246: "NEWDECIMAL",
    247: "ENUM",
    248: "SET",
    249: "TINY_BLOB",
    250: "MEDIUM_BLOB",
    251: "LONG_BLOB",
    252: "BLOB",
    253: "VAR_STRING",
    254: "STRING",
    255: "GEOMETRY",
  };
  return map[code] ?? `TYPE_${code}`;
}

class MysqlConnector implements Connector {
  private readonly pools = new Map<string, Pool>();
  private readonly log: PluginContext["log"];

  constructor(ctx: PluginContext) {
    this.log = ctx.log;
  }

  private getPool(cfg: MysqlConfig): Pool {
    const key = cacheKey(cfg);
    const existing = this.pools.get(key);
    if (existing) return existing;
    const pool = mysql.createPool({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      connectionLimit: 4,
      waitForConnections: true,
      enableKeepAlive: true,
      decimalNumbers: false,
      dateStrings: false,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    this.pools.set(key, pool);
    return pool;
  }

  meta(): ConnectorKindMeta {
    return {
      kind: "mysql",
      displayName: "MySQL",
      configSchema: {
        type: "object",
        properties: {
          host: { type: "string", default: "127.0.0.1" },
          port: { type: "integer", default: 3306 },
          user: { type: "string" },
          password: { type: "string", format: "password" },
          database: { type: "string" },
        },
        required: ["host", "port", "user"],
      },
      defaultConfig: {
        host: "127.0.0.1",
        port: 3306,
        user: "root",
        password: "",
        database: "",
      },
      subprocess: false,
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
      if (QUERY_RE.test(sql)) {
        const [rowsRaw, fields] = (await pool.query({
          sql,
          rowsAsArray: true,
        })) as [unknown[][], FieldPacket[]];
        const columns = fieldsToColumnDefs(fields);
        const rows = (rowsRaw as unknown[][]).map((row) =>
          row.map((cell) => normalizeCell(cell)),
        );
        return {
          kind: "query",
          columns,
          rows,
          elapsedMs: Date.now() - started,
        };
      } else {
        const [res] = (await pool.query(sql)) as [
          ResultSetHeader,
          FieldPacket[],
        ];
        return {
          kind: "mutation",
          affectedRows: res.affectedRows,
          elapsedMs: Date.now() - started,
        };
      }
    } catch (err) {
      throw new PluginError(
        QUERY_RE.test(sql) ? "query_failed" : "mutation_failed",
        (err as Error).message ?? "execute failed",
      );
    }
  }

  async listDatabases(cfg: unknown): Promise<string[]> {
    const c = parseConfig(cfg);
    const pool = this.getPool(c);
    const [rows] = (await pool.query("SHOW DATABASES")) as [
      RowDataPacket[],
      FieldPacket[],
    ];
    return rows
      .map((r) => Object.values(r)[0])
      .filter((v): v is string => typeof v === "string");
  }

  async listTables(cfg: unknown, db?: string | null): Promise<string[]> {
    const c = parseConfig(cfg);
    if (db) c.database = db;
    const pool = this.getPool(c);
    const [rows] = (await pool.query("SHOW TABLES")) as [
      RowDataPacket[],
      FieldPacket[],
    ];
    return rows
      .map((r) => Object.values(r)[0])
      .filter((v): v is string => typeof v === "string");
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
    return new MysqlConnector(ctx);
  },
});
