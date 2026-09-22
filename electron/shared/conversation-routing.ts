import { extractSqlFacts } from "./sql-facts";
/** Conservative routing only; execution authority is always checked separately. */
export function directConversationSql(input: string): string | null {
  const trimmed = input.trim();
  const fenced = /^```(?:sql|runsql)\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  const sql = fenced ? fenced[1]!.trim() : trimmed;
  if (!/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*(SELECT|WITH|SHOW|DESCRIBE|DESC|EXPLAIN|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|REPLACE)\b/i.test(sql)) return null;
  const facts = extractSqlFacts(sql);
  if (facts.length !== 1 || facts[0]!.unresolved.includes("dynamic")) return null;
  return sql;
}
