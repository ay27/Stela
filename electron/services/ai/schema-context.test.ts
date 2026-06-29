import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ConnectionEntry } from "@shared/types";

import { mergeSchemaTargets, parseColumnsFromDdl, resolveMentionedSchemaContext, resolveSchemaContext } from "./schema-context";
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
  await writeFile(
    join(root, "threed.clustering_stage3_task.md"),
    [
      "# `threed`.`clustering_stage3_task`",
      "",
      "```sql",
      "CREATE TABLE `threed`.`clustering_stage3_task` (",
      "  `id` bigint",
      ")",
      "```",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "threed.shapegen_v2_maxinfo_clustering_stage3.md"),
    [
      "# `threed`.`shapegen_v2_maxinfo_clustering_stage3`",
      "",
      "```sql",
      "CREATE TABLE `threed`.`shapegen_v2_maxinfo_clustering_stage3` (",
      "  `id` bigint,",
      "  `topo_hash` varchar(64)",
      ")",
      "```",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "threed.global_gray_clustering_stage3.md"),
    [
      "# `threed`.`global_gray_clustering_stage3`",
      "",
      "```sql",
      "CREATE TABLE `threed`.`global_gray_clustering_stage3` (",
      "  `id` bigint",
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
  assert.equal(explicit[0]?.matchReason, "explicit SQL table");

  const sqlOnly = await resolveSchemaContext({
    request: {
      action: "ask-sql",
      context: {
        source: "runsql",
        connectionName: "prod",
        sql: "UPDATE threed.shapegen_v2_maxinfo_clustering_stage3 SET err_code = 1",
        userInstruction: "threed.global_gray_clustering_stage3",
        mentionedTables: ["threed.global_gray_clustering_stage3"],
      },
    },
    symbols: extractSqlSymbols(
      "UPDATE threed.shapegen_v2_maxinfo_clustering_stage3 SET err_code = 1",
    ),
    connectionName: "prod",
    connection,
  });
  assert.deepEqual(
    sqlOnly.map((entry) => entry.table).sort(),
    ["shapegen_v2_maxinfo_clustering_stage3"],
  );

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

  const fuzzyNoise = await resolveSchemaContext({
    request: {
      action: "ask-sql",
      context: {
        source: "runsql",
        connectionName: "prod",
        sql: "UPDATE threed.shapegen_v2_maxinfo_clustering_stage3 SET err_code = 1",
        userInstruction: "explain clustering stage3 tables",
      },
    },
    symbols: extractSqlSymbols(
      "UPDATE threed.shapegen_v2_maxinfo_clustering_stage3 SET err_code = 1",
    ),
    connectionName: "prod",
    connection,
  });
  assert.deepEqual(
    fuzzyNoise.map((entry) => entry.table),
    ["shapegen_v2_maxinfo_clustering_stage3"],
  );

  const mergedAsk = mergeSchemaTargets(
    await resolveMentionedSchemaContext({
      mentionedTables: ["threed.global_gray_clustering_stage3"],
      connectionName: "prod",
      connection,
      request: {
        action: "ask-sql",
        context: { source: "runsql", connectionName: "prod" },
      },
    }),
    sqlOnly,
    8,
  );
  assert.equal(mergedAsk.length, 2);
  assert.deepEqual(
    mergedAsk.map((entry) => entry.table).sort(),
    ["global_gray_clustering_stage3", "shapegen_v2_maxinfo_clustering_stage3"],
  );

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

  const mentioned = await resolveMentionedSchemaContext({
    mentionedTables: ["dw.orders"],
    connectionName: "prod",
    connection,
    request: {
      action: "ask-sql",
      context: {
        source: "runsql",
        connectionName: "prod",
        connector: { kind: "mysql", displayName: "MySQL", dialect: "MySQL" },
      },
    },
  });
  assert.equal(mentioned[0]?.table, "orders");
  assert.match(mentioned[0]?.ddlSnippet ?? "", /CREATE TABLE/i);
  assert.equal(mentioned[0]?.matchReason, "user @mention");

  const parsed = parseColumnsFromDdl("CREATE TABLE t (\n  `id` int,\n  KEY `idx` (`id`)\n)");
  assert.deepEqual(parsed, [{ name: "id", typeName: "int" }]);

  const starrocks = parseColumnsFromDdl(
    [
      "CREATE TABLE t (",
      "  `id` int",
      ") ENGINE=OLAP",
      "DISTRIBUTED BY HASH(`id`)",
    ].join("\n"),
  );
  assert.deepEqual(starrocks, [{ name: "id", typeName: "int" }]);

  const merged = mergeSchemaTargets(
    [
      {
        connectionName: "prod",
        database: "threed",
        table: "mentioned_only",
        ddlSnippet: "CREATE TABLE mentioned_only (id int)",
        source: "manual",
        matchReason: "user @mention",
        score: 1_000,
      },
    ],
    [
      {
        connectionName: "prod",
        database: "threed",
        table: "from_sql",
        ddlSnippet: "CREATE TABLE from_sql (id int)",
        source: "schema-dir",
        matchReason: "explicit SQL table",
        score: 100,
      },
      {
        connectionName: "prod",
        database: "threed",
        table: "mentioned_only",
        ddlSnippet: "CREATE TABLE mentioned_only (id int)",
        source: "schema-dir",
        matchReason: "explicit SQL table",
        score: 100,
      },
    ],
    8,
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[0]?.table, "mentioned_only");
  assert.equal(merged[1]?.table, "from_sql");

  console.log("ai schema-context tests passed.");
} finally {
  await rm(root, { recursive: true, force: true });
}
