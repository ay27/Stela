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

const hintQuery = `SELECT /*+ SET_VAR(query_mem_limit = 214748364800) */
 task_name, COUNT(1) AS total, COUNT_IF(err_code = 1) AS ok_rows,
 COUNT_IF(err_code = 1 AND output_blend_path IS NOT NULL) AS ok_with_blend
 FROM downstream_tasks.pbr_refinement_task_v3 GROUP BY task_name ORDER BY total DESC;`;
assert.equal(classifySql(hintQuery, false, "StarRocks").classification, "read-only");
assert.equal(classifySql(hintQuery, false, "PostgreSQL").classification, "unknown");
assert.equal(classifySql(hintQuery, true).classification, "unknown");
assert.equal(classifySql("SELECT /*+ SET_VAR(x=1); DROP TABLE t */ 1", false, "StarRocks").classification, "read-only");
assert.equal(classifySql(hintQuery + " DROP TABLE t", true, "StarRocks").classification, "multi-statement");
for (const sql of ["SELECT /*+ never closed", "SELECT /*! DELETE FROM t */ 1", "SELECT 'unterminated"]) {
  assert.equal(classifySql(sql, true, "StarRocks").classification, "unknown");
}
assert.equal(classifySql("DELETE /*+ SET_VAR(x=1) */ FROM t", true, "StarRocks").classification, "mutation");
assert.equal(classifySql("SELECT /*+ SET_VAR(x=1) */ * INTO OUTFILE 'x' FROM t", true, "StarRocks").classification, "mutation");

assert.equal(classifySql("SELECT /*+ /* nested */ 1; DELETE FROM t -- */", true, "StarRocks").classification, "unknown");
