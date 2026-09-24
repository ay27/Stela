import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { DuckDBInstance } from "@duckdb/node-api";

const require = createRequire(import.meta.url);
const temp = mkdtempSync(join(tmpdir(), "stela-connector-test-"));
const noOp = () => {};
const ctx = { pluginDir: temp, log: { info: noOp, warn: noOp, error: noOp } };
process.env.ELECTRON_RENDERER_URL = "1";

function plugin(id) {
  const module = require(`../plugins/${id}/dist/index.cjs`);
  return module.default.create(ctx);
}

async function withServer(handler, test) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return await test(address.port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

try {
  const csv = join(temp, "sales.csv");
  const jsonl = join(temp, "sales.jsonl");
  const json = join(temp, "sales.json");
  const tsv = join(temp, "sales.tsv");
  const parquet = join(temp, "sales.parquet");
  const database = join(temp, "sales.duckdb");
  writeFileSync(csv, "channel,revenue\nemail,10\nsocial,20\n");
  writeFileSync(jsonl, '{"channel":"email","revenue":10}\n{"channel":"social","revenue":20}\n');
  writeFileSync(json, '[{"channel":"email","revenue":10},{"channel":"social","revenue":20}]');
  writeFileSync(tsv, "channel\trevenue\nemail\t10\nsocial\t20\n");
  const setup = await DuckDBInstance.create(database);
  const connection = await setup.connect();
  await connection.run("CREATE TABLE sales AS SELECT 'email' AS channel, 10 AS revenue UNION ALL SELECT 'social', 20");
  await connection.run(`COPY sales TO '${parquet.replaceAll("'", "''")}' (FORMAT PARQUET)`);
  connection.disconnectSync();
  setup.closeSync();

  const duckdb = plugin("connector-duckdb");
  for (const filePath of [csv, tsv, json, jsonl, parquet, database]) {
    const config = { filePath };
    assert.equal((await duckdb.test(config)).ok, true);
    assert.deepEqual(await duckdb.listTables(config), [filePath === database ? "sales" : "data"]);
    const result = await duckdb.execute(config, `SELECT SUM(revenue) AS total FROM ${filePath === database ? "sales" : "data"}`);
    assert.equal(result.kind, "query");
    assert.equal(Number(result.rows[0][0]), 30);
  }

  const sqlite = plugin("connector-sqlite");
  assert.equal(sqlite.meta().kind, "sqlite");
  if (process.versions.electron) {
    const Database = require("better-sqlite3");
    const sqlitePath = join(temp, "sales.sqlite");
    const db = new Database(sqlitePath);
    db.exec("CREATE TABLE sales (channel TEXT, revenue INTEGER); INSERT INTO sales VALUES ('email', 10), ('social', 20)");
    db.close();
    const config = { filePath: sqlitePath };
    assert.equal((await sqlite.test(config)).ok, true);
    assert.deepEqual(await sqlite.listTables(config), ["sales"]);
    const result = await sqlite.execute(config, "SELECT SUM(revenue) AS total FROM sales");
    assert.equal(result.kind, "query");
    assert.equal(result.rows[0][0], 30);
    await assert.rejects(sqlite.execute(config, "DELETE FROM sales"), /read-only/);
  }
  assert.equal(plugin("connector-starrocks").meta().kind, "starrocks");
  assert.equal(plugin("connector-doris").meta().kind, "doris");
  for (const id of ["connector-clickhouse", "connector-trino", "connector-sqlserver", "connector-bigquery", "connector-snowflake", "connector-databricks"]) {
    const connector = plugin(id);
    assert.equal(typeof connector.execute, "function");
    assert.equal(typeof connector.listTables, "function");
    assert.equal(typeof connector.meta().kind, "string");
  }
  await withServer((request, response) => {
    if (request.url?.startsWith("/ping")) { response.end("Ok.\n"); return; }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ meta: [{ name: "total", type: "Int64" }], data: [{ total: "30" }], rows: 1, statistics: { elapsed: 0, rows_read: 1, bytes_read: 8 } }));
  }, async (port) => {
    const clickhouse = plugin("connector-clickhouse");
    const config = { url: `http://127.0.0.1:${port}`, user: "default", database: "default" };
    assert.equal((await clickhouse.test(config)).ok, true);
    const result = await clickhouse.execute(config, "SELECT 30 AS total");
    assert.equal(result.kind, "query");
    assert.equal(result.columns[0].typeName, "Int64");
    assert.equal(Number(result.rows[0][0]), 30);
  });
  await withServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ id: "test-query", columns: [{ name: "total", type: "integer" }], data: [[30]], stats: { state: "FINISHED" } }));
  }, async (port) => {
    const trino = plugin("connector-trino");
    const result = await trino.execute({ server: `http://127.0.0.1:${port}`, user: "test", catalog: "memory", schema: "default" }, "SELECT 30 AS total");
    assert.equal(result.kind, "query");
    assert.equal(result.rows[0][0], 30);
  });
  await withServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.method === "POST") {
      const port = request.socket.localPort;
      response.end(JSON.stringify({ id: "paged-query", nextUri: `http://127.0.0.1:${port}/v1/statement/paged-query/1`, columns: [{ name: "total", type: "integer" }], data: [[10]] }));
    } else {
      response.end(JSON.stringify({ id: "paged-query", data: [[20]], stats: { state: "FINISHED" } }));
    }
  }, async (port) => {
    const result = await plugin("connector-trino").execute({ server: `http://127.0.0.1:${port}`, user: "test", catalog: "memory" }, "SELECT total FROM t");
    assert.equal(result.kind, "query");
    assert.deepEqual(result.rows, [[10], [20]]);
  });
  console.log("analytics connector local smoke passed");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
