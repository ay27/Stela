import type { PrivacySession } from './privacy-session';
import { PRIVACY_TOKEN_SOURCE } from '../../shared/ai-privacy';

/** Only whole SQL string literals can resolve identities. Never splice raw code. */
export function restorePrivateSql(sql: string, privacy: PrivacySession, dialect?: string | null): string {
  if (!sql.includes('STELA_PII_')) return sql;
  const token = new RegExp(`^${PRIVACY_TOKEN_SOURCE}$`);
  const mysql = /mysql|starrocks|doris/i.test(dialect ?? '');
  let output = '';
  for (let i = 0; i < sql.length;) {
    if (sql[i] === '"' || sql[i] === '`' || sql[i] === '[') {
      const start = i, close = sql[i] === '[' ? ']' : sql[i]!; i++; let closed = false;
      while (i < sql.length) {
        if (sql[i] === close) { if (sql[i + 1] === close) { i += 2; continue; } i++; closed = true; break; }
        if (sql[i] === '\\') throw new Error('Ambiguous quoted SQL identifier');
        i++;
      }
      if (!closed || sql.slice(start, i).includes('STELA_PII_')) throw new Error('Privacy tokens cannot be SQL identifiers.');
      output += sql.slice(start, i); continue;
    }
    if (/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.test(sql.slice(i))) throw new Error('Rewrite privacy query values using ordinary SQL string literals.');
    if (sql.startsWith('--', i) || sql[i] === '#') {
      const end = sql.indexOf('\n', i); const j = end < 0 ? sql.length : end;
      output += sql.slice(i, j); i = j; continue;
    }
    if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2); if (end < 0) throw new Error('Unclosed SQL comment');
      output += sql.slice(i, end + 2); i = end + 2; continue;
    }
    if (sql[i] !== "'") { output += sql[i++]; continue; }
    const start = i++; let value = ''; let closed = false;
    while (i < sql.length) {
      if (sql[i] === '\\') throw new Error('Privacy query literals with backslash escapes require rewriting.');
      if (sql[i] === "'") {
        if (sql[i + 1] === "'") { value += "'"; i += 2; continue; }
        i++; closed = true; break;
      }
      value += sql[i++];
    }
    if (!closed) throw new Error('Unclosed SQL literal');
    if (token.test(value)) {
      let original = privacy.restore(value);
      if (original.includes('\0')) throw new Error('NUL is not supported in privacy query values');
      if (mysql) original = original.replaceAll('\\', '\\\\');
      else if (original.includes('\\')) throw new Error('Privacy query backslash escaping is not supported for this dialect.');
      output += "'" + original.replaceAll("'", "''") + "'";
    } else {
      if (value.includes('STELA_PII_')) throw new Error('Use a complete privacy token as a SQL string value.');
      output += sql.slice(start, i);
    }
  }
  if (output.includes('STELA_PII_')) throw new Error('Privacy tokens are supported only as complete SQL string literals.');
  return output;
}
