/** Replace quoted text and comments with whitespace, preserving statement delimiters.
 * Unclosed lexical constructs are ambiguous and must never receive read authority.
 */
export function sqlStructuralText(sql: string): string | null {
  let out = "";
  for (let i = 0; i < sql.length;) {
    if (sql.startsWith("--", i) || sql[i] === "#") {
      const end = sql.indexOf("\n", i); i = end < 0 ? sql.length : end; out += " "; continue;
    }
    if (sql.startsWith("/*", i)) {
      // MySQL executable comments are code, not ordinary comments.
      if (/^\/\*[!+]/.test(sql.slice(i))) return null;
      let depth = 1; i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith("/*", i)) { depth++; i += 2; }
        else if (sql.startsWith("*/", i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) return null;
      out += " "; continue;
    }
    const dollar = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(sql.slice(i));
    if (dollar) {
      const end = sql.indexOf(dollar[0], i + dollar[0].length);
      if (end < 0) return null;
      i = end + dollar[0].length; out += " quoted "; continue;
    }
    const quote = sql[i];
    if (quote === "'" || quote === '"' || quote === "`" || quote === "[") {
      const close = quote === "[" ? "]" : quote; let closed = false; i++;
      while (i < sql.length) {
        if (sql[i] === "\\" && close !== "]") { i += 2; continue; }
        if (sql[i] === close) { if (sql[i + 1] === close) { i += 2; continue; } i++; closed = true; break; }
        i++;
      }
      if (!closed) return null;
      out += " quoted "; continue;
    }
    out += sql[i++];
  }
  return out;
}
