import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const resources = process.resourcesPath;
assert.ok(resources, "Run with the packaged Electron binary and ELECTRON_RUN_AS_NODE=1");
const requireApp = createRequire(join(resources, "app.asar", "package.json"));
const requirePlugin = createRequire(import.meta.url);
const temp = mkdtempSync(join(tmpdir(), "stela-packaged-connectors-"));
const noOp = () => {};
const context = { pluginDir: temp, log: { info: noOp, warn: noOp, error: noOp } };
function connector(id) {
  return requirePlugin(join(resources, "plugins", id, "dist", "index.cjs")).default.create(context);
}

try {
  for (const dependency of ["@duckdb/node-api", "better-sqlite3", "@google-cloud/bigquery", "snowflake-sdk", "@databricks/sql", "mssql"]) {
    assert.ok(requireApp(dependency), `${dependency} is loadable from app.asar`);
  }
  const csv = join(temp, "sales.csv");
  writeFileSync(csv, "channel,revenue\nemail,10\nsocial,20\n");
  const duckdb = connector("connector-duckdb");
  const result = await duckdb.execute({ filePath: csv }, "SELECT SUM(revenue) AS total FROM data");
  assert.equal(result.kind, "query");
  assert.equal(Number(result.rows[0][0]), 30);

  const Database = requireApp("better-sqlite3");
  const sqlitePath = join(temp, "sales.sqlite");
  const db = new Database(sqlitePath);
  db.exec("CREATE TABLE sales (revenue INTEGER); INSERT INTO sales VALUES (10), (20)");
  db.close();
  const sqliteResult = await connector("connector-sqlite").execute({ filePath: sqlitePath }, "SELECT SUM(revenue) AS total FROM sales");
  assert.equal(sqliteResult.kind, "query");
  assert.equal(sqliteResult.rows[0][0], 30);

  for (const id of ["connector-starrocks", "connector-doris", "connector-clickhouse", "connector-trino", "connector-sqlserver", "connector-bigquery", "connector-snowflake", "connector-databricks"]) {
    assert.equal(typeof connector(id).execute, "function");
  }
  console.log("packaged analytics connectors passed");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
