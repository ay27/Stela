import assert from "node:assert/strict";
import mysql from "mysql2/promise";

import { buildDemoFixture, buildDemoQueryResults } from "./demo-vault-fixture";

const connection = await mysql.createConnection({
  host: "127.0.0.1",
  port: 3306,
  user: "demo",
  password: "demo",
  database: "stela_demo",
});

try {
  const expectedResults = buildDemoQueryResults(buildDemoFixture());
  for (const expected of expectedResults) {
    const [rawRows] = await connection.query(expected.sql);
    assert.ok(Array.isArray(rawRows), `${expected.id} must return rows`);
    const actual = (rawRows as Array<Record<string, unknown>>).map((row) => expected.columns.map((column) => {
      const value = row[column.name];
      return column.typeName === "DECIMAL" || column.typeName === "BIGINT" ? Number(value) : value;
    }));
    assert.deepEqual(actual, expected.rows, `${expected.id} result drifted from the saved Demo snapshot`);
  }
  console.log("commerce demo MySQL results match saved snapshots.");
} finally {
  await connection.end();
}
