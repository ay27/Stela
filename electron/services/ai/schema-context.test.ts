import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ConnectionEntry } from "@shared/types";

import {
  mergeSchemaTargets,
  parseColumnsFromDdl,
  resolveMentionedSchemaContext,
  resolveNamedTableSchemas,
  resolveSchemaContext,
  searchTables,
} from "./schema-context";
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

  let qualifiedListDatabaseCalls = 0;
  let qualifiedListTableCalls = 0;
  const qualifiedExecuteSql: string[] = [];
  const liveAgentSchema = await resolveNamedTableSchemas({
    tableNames: ["dw.users"],
    connectionName: "prod",
    connection,
    request: {
      action: "explain-table",
      context: {
        source: "schema",
        connectionName: "prod",
        connector: { kind: "mysql", displayName: "MySQL", dialect: "MySQL" },
      },
    },
    matchReason: "agent get_table_schema",
    preferLocalSchemaDir: false,
    deps: {
      listDatabases: async () => {
        qualifiedListDatabaseCalls += 1;
        return ["dw"];
      },
      listTables: async () => {
        qualifiedListTableCalls += 1;
        return ["users"];
      },
      execute: async (_kind, _config, sql) => {
        qualifiedExecuteSql.push(sql);
        return {
          kind: "query",
          columns: [{ name: "Create Table", typeName: "varchar" }],
          rows: [[
            "CREATE TABLE `dw`.`users` (\n  `live_id` bigint,\n  `live_email` varchar(255)\n)",
          ]],
        };
      },
    },
  });
  assert.equal(liveAgentSchema[0]?.source, "connector");
  assert.ok(liveAgentSchema[0]?.columns?.some((column) => column.name === "live_id"));
  assert.equal(qualifiedListDatabaseCalls, 0);
  assert.equal(qualifiedListTableCalls, 0);
  assert.deepEqual(qualifiedExecuteSql, ["SHOW CREATE TABLE `dw`.`users`"]);

  let unqualifiedListDatabaseCalls = 0;
  let unqualifiedListTableCalls = 0;
  const unqualifiedSchema = await resolveNamedTableSchemas({
    tableNames: ["users"],
    connectionName: "prod",
    connection,
    request: {
      action: "explain-table",
      context: {
        source: "schema",
        connectionName: "prod",
        connector: { kind: "mysql", displayName: "MySQL", dialect: "MySQL" },
      },
    },
    matchReason: "agent get_table_schema",
    preferLocalSchemaDir: false,
    deps: {
      listDatabases: async () => {
        unqualifiedListDatabaseCalls += 1;
        return ["dw"];
      },
      listTables: async (_kind, _config, database) => {
        unqualifiedListTableCalls += 1;
        return database === "dw" ? ["users"] : [];
      },
      execute: async () => ({
        kind: "query",
        columns: [{ name: "Create Table", typeName: "varchar" }],
        rows: [["CREATE TABLE `dw`.`users` (\n  `id` bigint\n)"]],
      }),
    },
  });
  assert.equal(unqualifiedSchema[0]?.database, "dw");
  assert.equal(unqualifiedListDatabaseCalls, 1);
  assert.equal(unqualifiedListTableCalls, 1);

  const describeFallbackSchema = await resolveNamedTableSchemas({
    tableNames: ["dw.users"],
    connectionName: "prod",
    connection,
    request: {
      action: "explain-table",
      context: {
        source: "schema",
        connectionName: "prod",
        connector: { kind: "http", displayName: "HTTP", dialect: "StarRocks" },
      },
    },
    matchReason: "agent get_table_schema",
    preferLocalSchemaDir: false,
    deps: {
      listDatabases: async () => ["dw"],
      listTables: async () => ["users"],
      execute: async (_kind, _config, sql) => {
        if (sql.startsWith("SHOW CREATE")) throw new Error("gateway does not support SHOW CREATE");
        if (sql.startsWith("DESCRIBE")) {
          return {
            kind: "query",
            columns: [
              { name: "Field", typeName: "VARCHAR" },
              { name: "Type", typeName: "VARCHAR" },
            ],
            rows: [["live_id", "BIGINT"]],
          };
        }
        return { kind: "query", columns: [], rows: [] };
      },
    },
  });
  assert.deepEqual(describeFallbackSchema[0]?.columns, [{ name: "live_id", typeName: "BIGINT" }]);

  const liveAgentSearch = await searchTables({
    connectionName: "prod",
    connection,
    keywords: ["newly_added"],
    preferLocalSchemaDir: false,
    deps: {
      listDatabases: async () => ["dw"],
      listTables: async () => ["newly_added"],
    },
  });
  assert.equal(liveAgentSearch[0]?.table, "newly_added");
  assert.equal(liveAgentSearch[0]?.source, "connector");

  let activeCatalogCalls = 0;
  let maxActiveCatalogCalls = 0;
  const catalogDatabases = Array.from({ length: 8 }, (_, index) => `db_${index}`);
  const concurrentCatalogSearch = await searchTables({
    connectionName: "prod",
    connection,
    keywords: ["shared_table"],
    preferLocalSchemaDir: false,
    deps: {
      listDatabases: async () => catalogDatabases,
      listTables: async (_kind, _config, database) => {
        activeCatalogCalls += 1;
        maxActiveCatalogCalls = Math.max(maxActiveCatalogCalls, activeCatalogCalls);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeCatalogCalls -= 1;
        return [`shared_table_${database}`];
      },
    },
  });
  assert.equal(concurrentCatalogSearch.length, 5);
  assert.equal(maxActiveCatalogCalls, 4);

  let activeSchemaCalls = 0;
  let maxActiveSchemaCalls = 0;
  const concurrentQualifiedSchemas = await resolveNamedTableSchemas({
    tableNames: ["dw.users", "dw.orders"],
    connectionName: "prod",
    connection,
    request: {
      action: "explain-table",
      context: {
        source: "schema",
        connectionName: "prod",
        connector: { kind: "mysql", displayName: "MySQL", dialect: "MySQL" },
      },
    },
    matchReason: "agent get_table_schema",
    preferLocalSchemaDir: false,
    deps: {
      execute: async (_kind, _config, sql) => {
        activeSchemaCalls += 1;
        maxActiveSchemaCalls = Math.max(maxActiveSchemaCalls, activeSchemaCalls);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeSchemaCalls -= 1;
        const table = sql.includes("`orders`") ? "orders" : "users";
        return {
          kind: "query",
          columns: [{ name: "Create Table", typeName: "varchar" }],
          rows: [[`CREATE TABLE \`dw\`.\`${table}\` (\n  \`id\` bigint\n)`]],
        };
      },
    },
  });
  assert.deepEqual(
    concurrentQualifiedSchemas.map((entry) => entry.table),
    ["users", "orders"],
  );
  assert.equal(maxActiveSchemaCalls, 2);

  // describeTables 提供 COMMENT 时，searchTables 与 resolveNamedTableSchemas
  // 都能拿到结构化列（不再走 SHOW CREATE/DESCRIBE 探测链）。
  const liveConnectorOnly: ConnectionEntry = {
    kind: "fake-kind",
    config: {},
  };
  const describedSearch = await searchTables({
    connectionName: "prod",
    connection: liveConnectorOnly,
    keywords: ["orders"],
    preferLocalSchemaDir: false,
    deps: {
      listDatabases: async () => ["dw"],
      listTables: async (_kind, _cfg, db) => (db === "dw" ? ["orders"] : []),
      describeTables: async (_kind, _cfg, tables) =>
        tables.map((t) => ({
          database: t.database,
          table: t.table,
          columns: [
            { name: "order_id", typeName: "BIGINT", comment: "订单 id" },
            { name: "amount", typeName: "DECIMAL", comment: "金额" },
          ],
        })),
    },
  });
  assert.equal(describedSearch[0]?.table, "orders");
  assert.match(describedSearch[0]?.columns?.[0]?.comment ?? "", /订单/);

  const describedSchema = await resolveNamedTableSchemas({
    tableNames: ["dw.orders"],
    connectionName: "prod",
    connection: liveConnectorOnly,
    request: {
      action: "explain-table",
      context: {
        source: "schema",
        connectionName: "prod",
        connector: { kind: "fake-kind", displayName: "Fake", dialect: "MySQL" },
      },
    },
    matchReason: "agent get_table_schema",
    preferLocalSchemaDir: false,
    deps: {
      listDatabases: async () => ["dw"],
      listTables: async (_kind, _cfg, db) => (db === "dw" ? ["orders"] : []),
      describeTables: async (_kind, _cfg, tables) =>
        tables.map((t) => ({
          database: t.database,
          table: t.table,
          columns: [
            { name: "order_id", typeName: "BIGINT", comment: "订单 id" },
            { name: "amount", typeName: "DECIMAL", comment: "金额" },
          ],
          ddlSnippet: "CREATE TABLE dw.orders (order_id BIGINT, amount DECIMAL)",
        })),
    },
  });
  assert.equal(describedSchema[0]?.columns.length, 2);
  assert.match(describedSchema[0]?.ddlSnippet ?? "", /CREATE TABLE/);

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
