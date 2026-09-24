import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import { statSync } from "node:fs";
import type BetterSqlite3 from "better-sqlite3";
import {
  CONNECTOR_PLUGIN_API_VERSION, PluginError, defineConnectorPlugin,
  type Connector, type ConnectorKindMeta, type QueryResult, type TableDescriptor, type TestResult,
} from "@stela/connector-plugin-sdk";

interface SQLiteConfig { filePath: string }
function config(raw: unknown): SQLiteConfig {
  const value = raw as Record<string, unknown> | null;
  const filePath = value?.filePath;
  if (typeof filePath !== "string" || !isAbsolute(filePath))
    throw new PluginError("bad_config", "Select an absolute SQLite database file path.");
  try { if (!statSync(filePath).isFile()) throw new Error("not a regular file"); }
  catch { throw new PluginError("bad_config", "SQLite database file does not exist."); }
  return { filePath };
}
function open(raw: unknown): BetterSqlite3.Database {
  const { filePath } = config(raw);
  // The packaged native addon lives in app.asar.unpacked, under the app's
  // own dependency tree. Resolve from there, not from the vault plugin folder.
  const packagePath = process.env.ELECTRON_RENDERER_URL
    ? join(process.cwd(), "package.json")
    : join((process as NodeJS.Process & { resourcesPath: string }).resourcesPath, "app.asar", "package.json");
  const Database = createRequire(packagePath)("better-sqlite3") as typeof BetterSqlite3;
  return new Database(filePath, { readonly: true, fileMustExist: true });
}
function cell(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) return `<base64:${value.toString("base64")}>`;
  return value;
}
class SQLiteConnector implements Connector {
  meta(): ConnectorKindMeta {
    return { kind: "sqlite", displayName: "SQLite", dialect: "SQLite", subprocess: false,
      configSchema: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] },
      defaultConfig: { filePath: "" } };
  }
  async test(raw: unknown): Promise<TestResult> {
    const started = Date.now(); const db = open(raw);
    try { db.prepare("SELECT 1").get(); return { ok: true, latencyMs: Date.now() - started }; }
    finally { db.close(); }
  }
  async execute(raw: unknown, sql: string): Promise<QueryResult> {
    const db = open(raw); const started = Date.now();
    try {
      const statement = db.prepare(sql);
      if (!statement.reader) throw new PluginError("mutation_failed", "SQLite connection is read-only.");
      const columns = statement.columns().map(column => ({ name: column.name, typeName: column.type ?? "UNKNOWN" }));
      const rows = (statement.raw().all() as unknown[][]).map(row => row.map(cell));
      return { kind: "query", columns, rows, elapsedMs: Date.now() - started };
    } catch (error) {
      if (error instanceof PluginError) throw error;
      throw new PluginError("query_failed", (error as Error).message);
    } finally { db.close(); }
  }
  async listDatabases(raw: unknown): Promise<string[]> { const db = open(raw); try { return ["main"]; } finally { db.close(); } }
  async listTables(raw: unknown): Promise<string[]> {
    const db = open(raw);
    try { return (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[]).map(row => row.name); }
    finally { db.close(); }
  }
  async describeTables(raw: unknown, tables: { database: string | null; table: string }[]): Promise<TableDescriptor[]> {
    const db = open(raw);
    try { return tables.map(item => {
      const columns = (db.prepare("SELECT name, type FROM pragma_table_xinfo(?) WHERE hidden = 0 ORDER BY cid").all(item.table) as {name:string; type:string}[])
        .map(column => ({ name: column.name, typeName: column.type || "UNKNOWN" }));
      const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE name = ? LIMIT 1").get(item.table) as {sql:string}|undefined;
      return { database: item.database, table: item.table, columns, ddlSnippet: ddl?.sql ?? null };
    }); } finally { db.close(); }
  }
}
export default defineConnectorPlugin({ apiVersion: CONNECTOR_PLUGIN_API_VERSION, create: () => new SQLiteConnector() });
