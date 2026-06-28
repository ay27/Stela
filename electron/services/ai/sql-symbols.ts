export interface SqlSymbols {
  tables: string[];
  aliases: Record<string, string>;
  ctes: string[];
  selectedColumns: string[];
  referencedColumns: string[];
  dialectHints: string[];
}

const SQL_KEYWORDS = new Set(
  "select from where join inner left right full outer cross on using group by order having limit offset union with as and or not in is null case when then else end distinct all over partition insert update delete create alter drop truncate into values set returning"
    .split(/\s+/),
);

function cleanIdentifier(value: string): string {
  return value.replace(/^[`"[]|[`"\]]$/g, "").trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function collectAll(regex: RegExp, sql: string, group = 1): string[] {
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(sql))) {
    const value = match[group];
    if (value) out.push(cleanIdentifier(value));
  }
  return out;
}

export function extractSqlSymbols(sql: string): SqlSymbols {
  const normalized = sql.replace(/--.*$/gm, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
  const tables = unique([
    ...collectAll(/\bfrom\s+([`"\[]?[\w.]+[`"\]]?)/gi, normalized),
    ...collectAll(/\bjoin\s+([`"\[]?[\w.]+[`"\]]?)/gi, normalized),
    ...collectAll(/\bupdate\s+([`"\[]?[\w.]+[`"\]]?)/gi, normalized),
    ...collectAll(/\binto\s+([`"\[]?[\w.]+[`"\]]?)/gi, normalized),
  ]);

  const aliases: Record<string, string> = {};
  const aliasRegex = /\b(?:from|join)\s+([`"\[]?[\w.]+[`"\]]?)(?:\s+(?:as\s+)?([`"\[]?\w+[`"\]]?))?/gi;
  let aliasMatch: RegExpExecArray | null;
  while ((aliasMatch = aliasRegex.exec(normalized))) {
    const table = cleanIdentifier(aliasMatch[1] ?? "");
    const alias = cleanIdentifier(aliasMatch[2] ?? "");
    if (alias && !SQL_KEYWORDS.has(alias.toLowerCase())) aliases[alias] = table;
  }

  const ctes = unique(collectAll(/\bwith\s+([`"\[]?\w+[`"\]]?)\s+as\s*\(/gi, normalized));
  const selectedSegment = /\bselect\b([\s\S]*?)\bfrom\b/i.exec(normalized)?.[1] ?? "";
  const selectedColumns = unique(
    selectedSegment
      .split(",")
      .map((part) => part.trim().split(/\s+as\s+|\s+/i)[0] ?? "")
      .map(cleanIdentifier)
      .filter((part) => part.length > 0 && part !== "*"),
  );
  const referencedColumns = unique(collectAll(/\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)\b/g, normalized, 2));
  const lower = normalized.toLowerCase();
  const dialectHints = unique([
    lower.includes("limit ") ? "limit" : "",
    lower.includes("::") ? "postgres-cast" : "",
    lower.includes("show ") ? "mysql-show" : "",
    lower.includes("date_trunc") ? "postgres-date" : "",
  ]);

  return { tables, aliases, ctes, selectedColumns, referencedColumns, dialectHints };
}

