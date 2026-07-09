/**
 * 核心层行数上限：对所有走 `connector registry` 的只读查询自动追加 LIMIT。
 *
 * 这不是 AI/agent 专属的护栏——用户手写的 `SELECT *` 一样常见地会拉爆内存/
 * 触发天价查询成本，所以收敛到 registry.execute 这个唯一入口，编辑器 RunSQL
 * 与未来的 agent 一视同仁地被兜住。
 *
 * ponytail: 关键字启发式而非真 SQL parser，够覆盖 SELECT/WITH...SELECT 且不
 * 误伤 SHOW/DESCRIBE/多语句。上限：不支持 `LIMIT` 语法的方言（MSSQL 用
 * `TOP`、Oracle 用 `ROWNUM`）不会被这里兜住；升级路径是按 dialect 分派后缀
 * 语法，目前只覆盖 LIMIT 方言（MySQL/Postgres/SQLite/StarRocks 等主流connector）。
 */

function stripComments(sql: string): string {
  return sql.replace(/--.*$/gm, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
}

/** 去掉首尾空白 + 末尾分号，便于关键字匹配与判断"是否已有 LIMIT"。 */
function trimTrailingSemicolon(sql: string): string {
  return sql.trim().replace(/;\s*$/, "");
}

/** 多条语句（去注释后仍含内部 `;`）不动——避免把 LIMIT 拼到错误的语句上。 */
function isSingleStatement(sql: string): boolean {
  return !/;\s*\S/.test(sql.trim());
}

function isReadOnlySelect(sql: string): boolean {
  const s = sql.trimStart();
  // WITH ... SELECT（CTE）与裸 SELECT 都算只读查询；SHOW/DESCRIBE/EXPLAIN
  // 不需要（也不支持）LIMIT。
  return /^(select|with)\b/i.test(s) && /\bfrom\b/i.test(s);
}

function hasTopLevelLimit(sql: string): boolean {
  return /\blimit\b/i.test(sql);
}

/**
 * 仅对单条只读查询、且没有已有 LIMIT 时追加 `LIMIT maxRows`。
 * `maxRows <= 0` 视为"不限制"，原样返回。任何不确定的情况（多语句、非
 * SELECT/WITH、已有 LIMIT）都不改写，保持保守。
 */
export function applyRowLimit(sql: string, maxRows: number): string {
  if (!Number.isFinite(maxRows) || maxRows <= 0) return sql;
  const withoutComments = stripComments(sql);
  if (!isSingleStatement(withoutComments)) return sql;
  if (!isReadOnlySelect(withoutComments)) return sql;
  if (hasTopLevelLimit(withoutComments)) return sql;

  const trimmed = trimTrailingSemicolon(sql);
  return `${trimmed}\nLIMIT ${Math.floor(maxRows)}`;
}
