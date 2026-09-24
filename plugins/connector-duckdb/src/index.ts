import { createRequire } from "node:module";
import { isAbsolute, extname, join } from "node:path";
import { statSync } from "node:fs";
import type { DuckDBInstance } from "@duckdb/node-api";
import { CONNECTOR_PLUGIN_API_VERSION, PluginError, defineConnectorPlugin, type Connector, type QueryResult, type TableDescriptor } from "@stela/connector-plugin-sdk";

const SOURCE_FUNCTIONS: Record<string, string> = {
  ".csv": "read_csv_auto", ".tsv": "read_csv_auto", ".parquet": "read_parquet", ".json": "read_json_auto", ".jsonl": "read_json_auto", ".ndjson": "read_json_auto",
};
function filePath(raw: unknown): string {
  const value = (raw as { filePath?: unknown } | null)?.filePath;
  if (typeof value !== "string" || !isAbsolute(value)) throw new PluginError("bad_config", "Select an absolute DuckDB database or data file path.");
  try { if (!statSync(value).isFile()) throw new Error("not a file"); }
  catch { throw new PluginError("bad_config", "Selected data file does not exist."); }
  const ext = extname(value).toLowerCase();
  if (ext !== ".duckdb" && !(ext in SOURCE_FUNCTIONS)) throw new PluginError("bad_config", "Supported files: .duckdb, .csv, .tsv, .parquet, .json, .jsonl, .ndjson.");
  return value;
}
function quote(value: string): string { return `'${value.replaceAll("'", "''")}'`; }
function engine(): typeof import("@duckdb/node-api") {
  const packagePath = process.env.ELECTRON_RENDERER_URL
    ? join(process.cwd(), "package.json")
    : join((process as NodeJS.Process & { resourcesPath: string }).resourcesPath, "app.asar", "package.json");
  return createRequire(packagePath)("@duckdb/node-api") as typeof import("@duckdb/node-api");
}
async function withConnection<T>(raw: unknown, fn: (connection: Awaited<ReturnType<DuckDBInstance["connect"]>>) => Promise<T>): Promise<T> {
  const path = filePath(raw);
  const ext = extname(path).toLowerCase();
  const isDatabase = ext === ".duckdb";
  const instance = await engine().DuckDBInstance.create(isDatabase ? path : undefined, isDatabase ? { access_mode: "READ_ONLY" } : undefined);
  const connection = await instance.connect();
  try {
    if (!isDatabase) await connection.run(`CREATE VIEW data AS SELECT * FROM ${SOURCE_FUNCTIONS[ext]}(${quote(path)})`);
    return await fn(connection);
  } finally { connection.disconnectSync(); instance.closeSync(); }
}
class DuckDBConnector implements Connector {
  meta() { return { kind: "duckdb", displayName: "DuckDB / Local Files", dialect: "DuckDB", subprocess: false,
    configSchema: { type: "object", properties: { filePath: { type: "string", description: "Absolute .duckdb, CSV, Parquet, JSON or JSONL file path" } }, required: ["filePath"] },
    defaultConfig: { filePath: "" } }; }
  async test(raw: unknown) { const started = Date.now(); await withConnection(raw, async c => { await c.run("SELECT 1"); }); return { ok: true, latencyMs: Date.now() - started }; }
  async execute(raw: unknown, sql: string): Promise<QueryResult> {
    const started = Date.now();
    try { return await withConnection(raw, async c => {
      const result = await c.runAndReadAll(sql);
      if (result.columnCount === 0) return { kind: "mutation", affectedRows: result.rowsChanged, elapsedMs: Date.now() - started };
      return { kind: "query", columns: result.columnNames().map((name, i) => ({ name, typeName: String(result.columnType(i)) })), rows: result.getRowsJson(), elapsedMs: Date.now() - started };
    }); } catch (error) { if (error instanceof PluginError) throw error; throw new PluginError("query_failed", (error as Error).message); }
  }
  async listDatabases(raw: unknown): Promise<string[]> { return withConnection(raw, async () => ["main"]); }
  async listTables(raw: unknown): Promise<string[]> { return withConnection(raw, async c => {
    const result = await c.runAndReadAll("SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name");
    return result.getRowsJson().map(row => String(row[0]));
  }); }
  async describeTables(raw: unknown, tables: { database: string | null; table: string }[]): Promise<TableDescriptor[]> {
    return withConnection(raw, async c => {
      const descriptors: TableDescriptor[] = [];
      for (const item of tables) {
        const result = await c.runAndReadAll(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'main' AND table_name = ${quote(item.table)} ORDER BY ordinal_position`);
        descriptors.push({ database: item.database, table: item.table, columns: result.getRowsJson().map(row => ({ name: String(row[0]), typeName: String(row[1]) })), ddlSnippet: null });
      }
      return descriptors;
    });
  }
}
export default defineConnectorPlugin({ apiVersion: CONNECTOR_PLUGIN_API_VERSION, create: () => new DuckDBConnector() });
