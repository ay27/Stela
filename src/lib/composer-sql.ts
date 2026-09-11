import { format, type SqlLanguage } from "sql-formatter";
import type { SQLDialect } from "@codemirror/lang-sql";

export interface ISqlRegion { from: number; to: number; fenced: boolean }
const start = /^(?:select|with|show|describe|desc|explain|insert|update|delete|create|alter|drop|truncate|replace|sel(?:e(?:c(?:t)?)?)?|wit(?:h)?)\b/i;
const partialStart = /^(?:s|se|w|wi)$/i;
const continuation = /^(?:from|where|and|or|group|order|having|limit|offset|join|left|right|inner|outer|cross|on|union|except|intersect|set|values|returning|when|then|else|end|as|by)\b/i;
/** Deterministic editor affordance only, never an execution classifier. */
export function composerSqlRegions(text: string): ISqlRegion[] {
  const regions: ISqlRegion[] = [];
  const lines = [...text.matchAll(/[^\n]*(?:\n|$)/g)].filter(m => m[0]);
  let fence: { char: string; from: number; sql: boolean } | null = null;
  let region: ISqlRegion | null = null;
  let quote = "", comment = false, depth = 0;
  for (const line of lines) {
    const raw = line[0].replace(/\n$/, ""), offset = line.index!, trimmed = raw.trim();
    const marker = /^(`{3,}|~{3,})(\w*)/.exec(trimmed);
    if (fence) {
      if (marker && marker[1][0] === fence.char && !marker[2]) {
        if (fence.sql) regions.push({ from: fence.from, to: offset > fence.from ? offset - 1 : offset, fenced: true });
        fence = null;
      }
      continue;
    }
    if (marker && !quote && !comment) {
      region = null; fence = { char: marker[1][0], from: offset + line[0].length, sql: /^(sql|runsql)$/i.test(marker[2]) }; continue;
    }
    if (!quote && !comment && (!trimmed || trimmed.includes("\uFFFC"))) { region = null; depth = 0; continue; }
    if (region && !quote && !comment && depth === 0 && !/^\s/.test(raw) && !start.test(trimmed) && !continuation.test(trimmed) && !/[,()]\s*$/.test(trimmed)) region = null;
    if (!region) {
      if (!start.test(trimmed) && !partialStart.test(trimmed)) continue;
      region = { from: offset + raw.indexOf(trimmed), to: offset + raw.length, fenced: false }; regions.push(region);
    }
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i], next = raw[i + 1];
      if (comment) { if (c === "*" && next === "/") { comment = false; i++; } continue; }
      if (quote) { if (c === "\\") { i++; continue; } if (c === quote) { if (next === quote) i++; else quote = ""; } continue; }
      if (c === "-" && next === "-") break;
      if (c === "/" && next === "*") { comment = true; i++; continue; }
      if (c === "'" || c === '"' || c === "`") { quote = c; continue; }
      if (c === "(") depth++; if (c === ")") depth = Math.max(0, depth - 1);
      if (c === ";" && !depth) { region.to = offset + i + 1; region = null; break; }
    }
    if (region) region.to = offset + raw.length;
  }
  if (fence?.sql) regions.push({ from: fence.from, to: text.length, fenced: true });
  return regions;
}
export function composerFormatterLanguage(dialect: SQLDialect): SqlLanguage {
  const name = dialect.spec;
  if (name.doubleQuotedStrings) return "mysql";
  if (name.hashComments) return "mysql";
  if (name.doubleDollarQuotedStrings) return "postgresql";
  return "sql";
}
export function formatComposerSql(text: string, from: number, to: number, dialect: SQLDialect): { from: number; to: number; text: string } | null {
  const region = from !== to ? { from, to } : composerSqlRegions(text).find(r => r.from <= from && r.to >= to);
  if (!region) return null;
  const original = text.slice(region.from, region.to);
  if (!original.trim() || original.includes("\uFFFC")) return null;
  if (from !== to && !start.test(original.trim())) return null;
  try {
    return { ...region, text: format(original, { language: composerFormatterLanguage(dialect), keywordCase: "upper", tabWidth: 2, linesBetweenQueries: 1 }) };
  } catch { return null; }
}
