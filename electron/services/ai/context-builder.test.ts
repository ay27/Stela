import assert from "node:assert/strict";

import { buildAiContext } from "./context-builder";

const longNote = "x".repeat(20_000);
const bundle = buildAiContext(
  {
    action: "explain-result",
    context: {
      source: "result",
      connectionName: "local",
      connector: {
        kind: "mysql",
        displayName: "MySQL",
        dialect: "MySQL",
      },
      sql: "select u.id, u.email from dim.users u limit 10",
      noteMarkdown: longNote,
      result: {
        rowCount: 3,
        columns: [
          { name: "id", typeName: "int" },
          { name: "email", typeName: "text" },
        ],
        rows: [
          [1, "a@example.com"],
          [2, "b@example.com"],
          [3, "c@example.com"],
        ],
      },
    },
  },
  2,
);

assert.deepEqual(bundle.symbols.tables, ["dim.users"]);
assert.equal(bundle.request.context.result?.rows?.length, 2);
assert.ok((bundle.request.context.noteMarkdown ?? "").length < longNote.length);
assert.ok(bundle.summary.includes("source=result"));
assert.ok(bundle.summary.includes("connection=local"));
assert.ok(!bundle.summary.some((line) => line.startsWith("tables=")));
assert.ok(!bundle.summary.some((line) => line.startsWith("connector=")));

const schemaBundle = buildAiContext({
  action: "ask-sql",
  context: {
    source: "runsql",
    connectionName: "local",
    sql: "select * from dim.users",
    schemas: [
      {
        connectionName: "local",
        database: "dim",
        table: "users",
        columns: [{ name: "id", typeName: "int" }],
        ddlSnippet: "x".repeat(10_000),
        source: "schema-dir",
      },
    ],
  },
});

assert.equal(schemaBundle.schemaTargets.length, 1);
assert.equal(schemaBundle.schemaTargets[0]?.table, "users");
assert.ok((schemaBundle.request.context.schemas?.[0]?.ddlSnippet ?? "").length < 10_000);

const singleSchemaBundle = buildAiContext({
  action: "explain-table",
  context: {
    source: "schema",
    connectionName: "local",
    schema: {
      connectionName: "local",
      database: "dim",
      table: "users",
      columns: [{ name: "id", typeName: "int" }],
    },
  },
});
assert.equal(singleSchemaBundle.schemaTargets.length, 1);
assert.equal(singleSchemaBundle.schemaTargets[0]?.table, "users");

console.log("ai context-builder tests passed.");

