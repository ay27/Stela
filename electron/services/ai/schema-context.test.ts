import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ConnectionEntry } from "@shared/types";

import { parseColumnsFromDdl, resolveSchemaContext } from "./schema-context";
import { extractSqlSymbols } from "./sql-symbols";

const root = await mkdtemp(join(tmpdir(), "stela-ai-schema-"));
try {
  await writeFile(
    join(root, "dw.users.md"),
    [
      "# `dw`.`users`",
      "",
      "```sql",
      "CREATE TABLE `dw`.`users` (",
      "  `id` bigint,",
      "  `email` varchar(255),",
      "  `signup_date` date",
      ")",
      "```",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "dw.orders.md"),
    [
      "# `dw`.`orders`",
      "",
      "```sql",
      "CREATE TABLE `dw`.`orders` (",
      "  `order_id` bigint,",
      "  `user_id` bigint,",
      "  `amount` decimal(18,2)",
      ")",
      "```",
      "",
    ].join("\n"),
  );

  const connection: ConnectionEntry = {
    kind: "mysql",
    config: {},
    schemaDir: root,
  };

  const explicit = await resolveSchemaContext({
    request: {
      action: "rewrite-sql",
      context: {
        source: "runsql",
        connectionName: "prod",
        sql: "select * from dw.users",
        userInstruction: "add a limit",
      },
    },
    symbols: extractSqlSymbols("select * from dw.users"),
    connectionName: "prod",
    connection,
  });
  assert.equal(explicit[0]?.table, "users");
  assert.match(explicit[0]?.matchReason ?? "", /explicit SQL table/);

  const natural = await resolveSchemaContext({
    request: {
      action: "ask-sql",
      context: {
        source: "runsql",
        connectionName: "prod",
        sql: "",
        userInstruction: "How do I query user email and signup date?",
      },
    },
    symbols: extractSqlSymbols(""),
    connectionName: "prod",
    connection,
  });
  assert.equal(natural[0]?.table, "users");
  assert.ok(natural[0]?.columns?.some((column) => column.name === "email"));

  const fallback = await resolveSchemaContext({
    request: {
      action: "ask-sql",
      context: {
        source: "runsql",
        connectionName: "prod",
        connector: { kind: "mysql", displayName: "MySQL", dialect: "MySQL" },
        sql: "",
        userInstruction: "order amount",
      },
    },
    symbols: extractSqlSymbols(""),
    connectionName: "prod",
    connection: { kind: "mysql", config: {} },
    deps: {
      listDatabases: async () => ["dw"],
      listTables: async () => ["orders", "users"],
      execute: async () => ({
        kind: "query",
        columns: [
          { name: "order_id", typeName: "bigint" },
          { name: "amount", typeName: "decimal" },
        ],
        rows: [],
      }),
    },
  });
  assert.equal(fallback[0]?.table, "orders");
  assert.ok(fallback[0]?.columns?.some((column) => column.name === "amount"));

  const parsed = parseColumnsFromDdl("CREATE TABLE t (\n  `id` int,\n  KEY `idx` (`id`)\n)");
  assert.deepEqual(parsed, [{ name: "id", typeName: "int" }]);

  console.log("ai schema-context tests passed.");
} finally {
  await rm(root, { recursive: true, force: true });
}
