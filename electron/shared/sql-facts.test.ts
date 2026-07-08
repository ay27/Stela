/**
 * sql-facts.ts 单测。
 *
 *     npx tsx electron/shared/sql-facts.test.ts
 *
 * 覆盖 plan 里点名的核心场景：INSERT（含列清单/无列清单/SET 形式）、
 * UPDATE（单表/别名/多表 JOIN/Postgres FROM）、DELETE（单表/多表别名）、
 * upsert（MySQL ON DUPLICATE KEY UPDATE / Postgres ON CONFLICT DO UPDATE）、
 * SELECT readTables、动态 SQL 降级、CTE 主动词识别。
 */
import assert from "node:assert";
import { MySQL, PostgreSQL } from "@codemirror/lang-sql";

import { extractSqlFacts, type StatementFacts } from "./sql-facts";

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

const results: Check[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
}

function first(sql: string, dialect = MySQL): StatementFacts {
  const facts = extractSqlFacts(sql, { dialect });
  assert.strictEqual(facts.length, 1, `expected exactly 1 statement, got ${facts.length}`);
  return facts[0]!;
}

// ---------- INSERT ----------
{
  const f = first("INSERT INTO orders (id, price) VALUES (1, 2)");
  check(
    "INSERT 带列清单：writeTables=orders, writeColumns=[id,price]，无 unresolved",
    f.operation === "insert" &&
      f.writeTables.length === 1 &&
      f.writeTables[0]!.table === "orders" &&
      f.writeColumns.map((c) => c.column).join(",") === "id,price" &&
      f.writeColumns.every((c) => c.table === "orders") &&
      f.unresolved.length === 0,
    JSON.stringify(f),
  );
}

{
  const f = first("INSERT INTO orders VALUES (1, 2)");
  check(
    "INSERT 无列清单：writeTables=orders, writeColumns=[], unresolved=[columns-unknown]",
    f.operation === "insert" &&
      f.writeTables[0]!.table === "orders" &&
      f.writeColumns.length === 0 &&
      f.unresolved.includes("columns-unknown"),
    JSON.stringify(f),
  );
}

{
  const f = first("INSERT INTO orders SET id = 1, price = 2");
  check(
    "MySQL INSERT ... SET 形式：writeColumns=[id,price]",
    f.operation === "insert" &&
      f.writeTables[0]!.table === "orders" &&
      f.writeColumns.map((c) => c.column).sort().join(",") === "id,price",
    JSON.stringify(f),
  );
}

{
  const f = first("INSERT IGNORE INTO orders (id) VALUES (1)");
  check(
    "INSERT IGNORE INTO：跳过修饰词正确识别目标表",
    f.writeTables[0]!.table === "orders" && f.writeColumns[0]!.column === "id",
    JSON.stringify(f),
  );
}

{
  const f = first("REPLACE INTO orders (id, price) VALUES (1,2)");
  check(
    "REPLACE INTO：operation=replace",
    f.operation === "replace" && f.writeTables[0]!.table === "orders",
    JSON.stringify(f),
  );
}

{
  const f = first("INSERT INTO archive.orders (id) VALUES (1)");
  check(
    "db.table 限定名：db=archive, table=orders",
    f.writeTables[0]!.db === "archive" && f.writeTables[0]!.table === "orders",
    JSON.stringify(f),
  );
}

{
  const f = first(
    "INSERT INTO orders (id, price) VALUES (1,2) ON DUPLICATE KEY UPDATE price = 2, qty = qty + 1",
  );
  check(
    "MySQL upsert：operation=upsert，ON DUPLICATE KEY UPDATE 的列并入 writeColumns",
    f.operation === "upsert" &&
      f.writeColumns.map((c) => c.column).sort().join(",") === "id,price,price,qty",
    JSON.stringify(f),
  );
}

{
  const f = first(
    "INSERT INTO orders (id, price) VALUES (1,2) ON CONFLICT (id) DO UPDATE SET price = 2",
    PostgreSQL,
  );
  check(
    "Postgres upsert：ON CONFLICT DO UPDATE SET 的列并入 writeColumns，operation=upsert",
    f.operation === "upsert" && f.writeColumns.some((c) => c.column === "price"),
    JSON.stringify(f),
  );
}

{
  const f = first(
    "INSERT INTO orders (id) VALUES (1) ON CONFLICT (id) DO NOTHING",
    PostgreSQL,
  );
  check(
    "Postgres ON CONFLICT DO NOTHING：不产生额外 writeColumns，operation=upsert",
    f.operation === "upsert" && f.writeColumns.length === 1 && f.writeColumns[0]!.column === "id",
    JSON.stringify(f),
  );
}

{
  const f = first(
    "INSERT INTO orders (\n  id,\n  -- price comment, with a comma\n  price\n) VALUES (1, 2)",
  );
  check(
    "列清单里的行注释不应被当成列名",
    f.writeColumns.map((c) => c.column).sort().join(",") === "id,price",
    JSON.stringify(f),
  );
}

{
  const f = first("INSERT INTO orders SELECT * FROM tmp_orders");
  check(
    "INSERT ... SELECT 无列清单：unresolved=[columns-unknown]",
    f.operation === "insert" &&
      f.writeTables[0]!.table === "orders" &&
      f.unresolved.includes("columns-unknown"),
    JSON.stringify(f),
  );
}

// ---------- UPDATE ----------
{
  const f = first("UPDATE orders SET price = 1, qty = 2 WHERE id = 1");
  check(
    "UPDATE 单表无别名：writeTables=orders, writeColumns 归到 orders",
    f.operation === "update" &&
      f.writeTables[0]!.table === "orders" &&
      f.writeColumns.every((c) => c.table === "orders") &&
      f.writeColumns.map((c) => c.column).sort().join(",") === "price,qty",
    JSON.stringify(f),
  );
}

{
  const f = first("UPDATE orders o SET o.price = 1, o.qty = 2 WHERE o.id = 1");
  check(
    "UPDATE 带别名 + 列前缀：alias 正确解析回 orders",
    f.writeTables[0]!.table === "orders" &&
      f.writeColumns.every((c) => c.table === "orders") &&
      f.writeColumns.map((c) => c.column).sort().join(",") === "price,qty",
    JSON.stringify(f),
  );
}

{
  const f = first(
    "UPDATE t1 JOIN t2 ON t1.id = t2.id SET t1.price = t2.price WHERE t2.x = 1",
  );
  check(
    "UPDATE 多表 JOIN：writeTables=[t1,t2]（JOIN 涉及的表），列正确归属 t1",
    f.writeTables.map((t) => t.table).join(",") === "t1,t2" &&
      f.writeColumns.length === 1 &&
      f.writeColumns[0]!.table === "t1" &&
      f.writeColumns[0]!.column === "price",
    JSON.stringify(f),
  );
}

{
  const f = first(
    "UPDATE orders SET price = 1 FROM tmp_prices WHERE orders.id = tmp_prices.id",
    PostgreSQL,
  );
  check(
    "Postgres UPDATE...FROM：writeTables=orders, readTables=tmp_prices",
    f.writeTables[0]!.table === "orders" &&
      f.readTables.length === 1 &&
      f.readTables[0]!.table === "tmp_prices",
    JSON.stringify(f),
  );
}

{
  const f = first("UPDATE orders SET price = price + 1 WHERE id = 1");
  check(
    "UPDATE 自引用表达式（price = price + 1）：只取 LHS 列名",
    f.writeColumns.length === 1 && f.writeColumns[0]!.column === "price",
    JSON.stringify(f),
  );
}

{
  // Postgres 把 CLUSTER 收进了保留字（`CLUSTER table [USING index]` 维护命令），
  // 列名恰好叫 cluster 时 lezer 会把它 token 成 Keyword 而非 Identifier，
  // 若不特殊处理这条赋值会被静默丢弃/错配（回归用例：真实业务 SQL 踩到过）。
  const f = first(
    "UPDATE t SET cluster = 1, cluster_gcs = 2 WHERE t.id = 1",
    PostgreSQL,
  );
  check(
    "Postgres 保留字用作列名（cluster）：仍被正确识别为写列",
    f.writeColumns.map((c) => c.column).sort().join(",") === "cluster,cluster_gcs" &&
      f.writeColumns.every((c) => c.table === "t"),
    JSON.stringify(f),
  );
}

{
  // 真实案例回归：UPDATE db.table SET ... FROM (子查询) src WHERE ... 三段式表名 +
  // 保留字列名 + JOIN 子查询，读写表/列都要能正确落到 writeColumns 上。
  const f = first(
    `UPDATE ds.full_dataset
     SET cluster = src.url
     FROM (SELECT id, url FROM tmp_src) src
     WHERE full_dataset.id = src.id`,
    PostgreSQL,
  );
  check(
    "真实场景回归：db.table 限定名 + FROM 子查询 + 保留字列名同时命中",
    f.writeTables.length === 1 &&
      f.writeTables[0]!.db === "ds" &&
      f.writeTables[0]!.table === "full_dataset" &&
      f.writeColumns.some((c) => c.db === "ds" && c.table === "full_dataset" && c.column === "cluster"),
    JSON.stringify(f),
  );
}

// ---------- DELETE ----------
{
  const f = first("DELETE FROM orders WHERE id = 1");
  check(
    "DELETE FROM 单表：writeTables=orders",
    f.operation === "delete" && f.writeTables.length === 1 && f.writeTables[0]!.table === "orders",
    JSON.stringify(f),
  );
}

{
  const f = first(
    "DELETE t1 FROM t1 JOIN t2 ON t1.id = t2.id WHERE t2.x = 1",
  );
  check(
    "MySQL 多表 DELETE：按目标别名 t1 精确解析，不含 t2",
    f.writeTables.length === 1 && f.writeTables[0]!.table === "t1",
    JSON.stringify(f),
  );
}

// ---------- SELECT ----------
{
  const f = first("SELECT id, price FROM orders o WHERE o.price > 1");
  check(
    "SELECT：readTables=orders",
    f.operation === "select" && f.readTables.length === 1 && f.readTables[0]!.table === "orders",
    JSON.stringify(f),
  );
}

// ---------- CTE ----------
{
  const f = first(
    "WITH recent AS (SELECT id FROM tmp_orders) INSERT INTO archive SELECT id FROM recent",
  );
  check(
    "CTE 前缀：正确识别主动词为 INSERT，目标表 archive",
    f.operation === "insert" && f.writeTables[0]!.table === "archive",
    JSON.stringify(f),
  );
}

// ---------- 动态 / 模板 SQL ----------
{
  const f = first("INSERT INTO orders_${env} (id) VALUES (${id})");
  check(
    "模板拼接 SQL（${var}）：整条标 dynamic",
    f.unresolved.includes("dynamic"),
    JSON.stringify(f),
  );
}

// ---------- 多语句 ----------
{
  const facts = extractSqlFacts("INSERT INTO a (id) VALUES (1); UPDATE b SET x = 1 WHERE id = 1;");
  check(
    "一个 block 内多条语句：各自产出一条 StatementFacts",
    facts.length === 2 && facts[0]!.operation === "insert" && facts[1]!.operation === "update",
    JSON.stringify(facts),
  );
}

// ---------- 其它 / DDL ----------
{
  const f = first("CREATE TABLE orders (id INT)");
  check("DDL：operation=ddl", f.operation === "ddl", JSON.stringify(f));
}

{
  const f = first("SHOW TABLES");
  check("无法识别主动词：operation=other", f.operation === "other", JSON.stringify(f));
}

let failed = 0;
for (const r of results) {
  if (r.ok) {
    console.log(`  ok  ${r.name}`);
  } else {
    failed += 1;
    console.log(`  !!! ${r.name}${r.detail ? `   -> ${r.detail}` : ""}`);
  }
}
console.log(`\nsql-facts.test.ts: ${results.length - failed}/${results.length} passed`);
if (failed > 0) process.exit(1);
