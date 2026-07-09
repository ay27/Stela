import assert from "node:assert/strict";

import { classifySql } from "./sql-guard";

// 只读放行
for (const sql of [
  "SELECT * FROM orders",
  "WITH t AS (SELECT 1) SELECT * FROM t",
  "SHOW TABLES",
  "DESCRIBE orders",
  "EXPLAIN SELECT * FROM orders",
]) {
  const r = classifySql(sql, false);
  assert.equal(r.classification, "read-only", sql);
  assert.equal(r.blockedReason, null, sql);
}

// 改动类默认拦截
{
  const r = classifySql("DELETE FROM orders WHERE id = 1", false);
  assert.equal(r.classification, "mutation");
  assert.match(r.blockedReason ?? "", /blocked by default/);
}

// 改动类 allowMutations=true 时仍标记，但文案变成"需要确认"而不是"拦截"
{
  const r = classifySql("UPDATE orders SET status = 'x'", true);
  assert.equal(r.classification, "mutation");
  assert.match(r.blockedReason ?? "", /require user approval/);
}

// 多语句一律拒绝，无论内容
{
  const r = classifySql("SELECT 1; DROP TABLE orders", false);
  assert.equal(r.classification, "multi-statement");
  assert.match(r.blockedReason ?? "", /one statement at a time/);
}

// 注释里的分号不误判为多语句
{
  const r = classifySql("SELECT * FROM orders -- drop; truncate", false);
  assert.equal(r.classification, "read-only");
}

// 未识别关键字保守拦截
{
  const r = classifySql("CALL some_procedure()", false);
  assert.equal(r.classification, "mutation");
}

console.log("sql-guard tests passed.");
