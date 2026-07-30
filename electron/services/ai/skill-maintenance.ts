import { extractSqlFacts } from "@shared/sql-facts";

const TRANSIENT_FAILURE = /\b(timeout|timed out|network|econnreset|econnrefused|rate limit|429|temporar(?:y|ily)|unavailable)\b/i;

export type SkillMaintenanceEvidenceKind = "success" | "failed_attempt" | "transient_failure";

export interface SkillMaintenanceEvidence {
  tool: string;
  kind: SkillMaintenanceEvidenceKind;
  source: string[];
  tables?: string[];
  errorCategory?: "schema_mismatch" | "syntax_error" | "type_mismatch" | "permission_denied" | "tool_error";
}

function stringValues(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function tablesFromSql(sql: unknown): string[] {
  if (typeof sql !== "string" || !sql.trim()) return [];
  try {
    return Array.from(
      new Set(
        extractSqlFacts(sql)
          .flatMap((statement) => [...statement.readTables, ...statement.writeTables])
          .map((table) => table.db ? `${table.db}.${table.table}` : table.table),
      ),
    );
  } catch {
    return [];
  }
}

function errorCategory(result: unknown): SkillMaintenanceEvidence["errorCategory"] {
  const message = String(result);
  if (/\b(unknown|missing|does not exist).*(column|table)|\b(column|table).*(unknown|missing|does not exist)\b/i.test(message)) {
    return "schema_mismatch";
  }
  if (/\bsyntax\b/i.test(message)) return "syntax_error";
  if (/\b(type|cast|convert)\b/i.test(message)) return "type_mismatch";
  if (/\b(permission|access denied|unauthori[sz]ed)\b/i.test(message)) return "permission_denied";
  return "tool_error";
}

export function buildSkillMaintenanceEvidence(
  tool: string,
  args: unknown,
  result: unknown,
  isError: boolean,
): SkillMaintenanceEvidence {
  const params = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const tables = tool === "run_sql" ? tablesFromSql(params.sql) : [];
  const source = [
    ...stringValues(params.tables),
    ...stringValues(params.path),
    ...tables,
  ];
  const transient = isError && TRANSIENT_FAILURE.test(String(result));
  const diagnostics = isError && !transient ? { errorCategory: errorCategory(result) } : {};
  return {
    tool,
    kind: transient
      ? "transient_failure"
      : isError
        ? "failed_attempt"
        : "success",
    source,
    ...(tables.length > 0 ? { tables } : {}),
    ...diagnostics,
  };
}

export function hasSkillMaintenanceEvidence(evidence: SkillMaintenanceEvidence[]): boolean {
  return evidence.some((item) => item.kind === "success");
}

export function formatSkillMaintenanceEvidence(evidence: SkillMaintenanceEvidence[]): string {
  return evidence.map((item, index) => {
    const source = item.source.length > 0 ? `; source: ${item.source.join(", ")}` : "";
    const error = item.errorCategory ? `; error: ${item.errorCategory}` : "";
    return `${index + 1}. ${item.kind}: ${item.tool}${source}${error}`;
  }).join("\n");
}
