import assert from "node:assert/strict";

import { applyRowLimit } from "./sql-limit";

// 只读 SELECT 无 LIMIT → 补上
assert.equal(
  applyRowLimit("SELECT * FROM orders", 1000),
  "SELECT * FROM orders\nLIMIT 1000",
);

// 已有 LIMIT → 不重复追加
assert.equal(
  applyRowLimit("SELECT * FROM orders LIMIT 10", 1000),
  "SELECT * FROM orders LIMIT 10",
);

// CTE（WITH ... SELECT）也补
assert.equal(
  applyRowLimit("WITH t AS (SELECT 1) SELECT * FROM t", 50),
  "WITH t AS (SELECT 1) SELECT * FROM t\nLIMIT 50",
);

// SHOW/DESCRIBE 不动
assert.equal(applyRowLimit("SHOW TABLES", 1000), "SHOW TABLES");
assert.equal(applyRowLimit("DESCRIBE orders", 1000), "DESCRIBE orders");
assert.equal(applyRowLimit("EXPLAIN SELECT * FROM orders", 1000), "EXPLAIN SELECT * FROM orders");

// 多语句不动（避免把 LIMIT 拼错语句）
assert.equal(
  applyRowLimit("SELECT 1; SELECT 2", 1000),
  "SELECT 1; SELECT 2",
);

// 结尾分号单语句：LIMIT 插在分号前被去掉、追加到末尾
assert.equal(
  applyRowLimit("SELECT * FROM orders;", 1000),
  "SELECT * FROM orders\nLIMIT 1000",
);

// maxRows <= 0 视为不限制
assert.equal(applyRowLimit("SELECT * FROM orders", 0), "SELECT * FROM orders");
assert.equal(applyRowLimit("SELECT * FROM orders", -1), "SELECT * FROM orders");

// 注释里出现的 LIMIT/分号不误判
assert.equal(
  applyRowLimit("SELECT * FROM orders -- LIMIT hint; ignore", 1000),
  "SELECT * FROM orders -- LIMIT hint; ignore\nLIMIT 1000",
);

// 非 SELECT（如 INSERT）不动——护栏另有 sql-guard 处理改动类语句
assert.equal(
  applyRowLimit("INSERT INTO orders VALUES (1)", 1000),
  "INSERT INTO orders VALUES (1)",
);

console.log("sql-limit tests passed.");
