/**
 * Agent 侧 SQL 护栏：只读放行，改动类默认拦截，禁止多语句堆叠。
 *
 * 行数上限不在这里——connector registry 只截断保存/展示的结果行，
 * 不改写用户 SQL，编辑器手写 SQL 与 agent 通用。
 *
 * ponytail: 关键字分类是启发式（取首个有效关键字），不是真 SQL parser。
 * 上限：动态拼接 / 存储过程调用等复杂语句可能分类不准。升级路径：接入真正
 * 的 SQL parser（如 node-sql-parser）按 AST 分类。
 */

export type SqlGuardClassification = "read-only" | "mutation" | "multi-statement";

export interface SqlGuardResult {
  classification: SqlGuardClassification;
  /** 首个识别出的关键字（大写），用于日志 / 报错文案。 */
  keyword: string | null;
  /** classification !== "read-only" 时的人类可读原因；read-only 时为 null。 */
  blockedReason: string | null;
}

const READ_ONLY_KEYWORDS = new Set(["SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXPLAIN"]);
const MUTATION_KEYWORDS = new Set([
  "INSERT",
  "UPDATE",
  "DELETE",
  "DROP",
  "TRUNCATE",
  "ALTER",
  "CREATE",
  "REPLACE",
  "MERGE",
  "GRANT",
  "REVOKE",
]);

function stripComments(sql: string): string {
  return sql.replace(/--.*$/gm, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
}

function isMultiStatement(sql: string): boolean {
  return /;\s*\S/.test(sql.trim());
}

function firstKeyword(sql: string): string | null {
  const match = /^\s*([A-Za-z]+)/.exec(sql);
  return match ? match[1].toUpperCase() : null;
}

/** 对单条语句分类；调用方应先用 `classifySql`（自带多语句检测）。 */
function classifyStatement(keyword: string | null): "read-only" | "mutation" | "unknown" {
  if (!keyword) return "unknown";
  if (READ_ONLY_KEYWORDS.has(keyword)) return "read-only";
  if (MUTATION_KEYWORDS.has(keyword)) return "mutation";
  return "unknown";
}

/**
 * 分类 + 护栏决策入口。`allowMutations` 对应设置里的
 * `AiSettings.agentAllowMutations`：
 *   - false（默认）：改动类语句直接拦截，`blockedReason` 解释给模型让它改走只读。
 *   - true：改动类语句仍标记 `blockedReason`，但由调用方决定是否走 confirm
 *     proposal（v1 harness 循环里始终发 proposal 等用户 approve，而不是自动放行）。
 */
export function classifySql(sql: string, allowMutations: boolean): SqlGuardResult {
  const cleaned = stripComments(sql);
  if (isMultiStatement(cleaned)) {
    return {
      classification: "multi-statement",
      keyword: firstKeyword(cleaned),
      blockedReason: "Multiple SQL statements in one call are not allowed. Run one statement at a time.",
    };
  }
  const keyword = firstKeyword(cleaned);
  const kind = classifyStatement(keyword);
  if (kind === "read-only") {
    return { classification: "read-only", keyword, blockedReason: null };
  }
  if (kind === "mutation") {
    return {
      classification: "mutation",
      keyword,
      blockedReason: allowMutations
        ? `${keyword} statements require user approval before running.`
        : `${keyword} statements are blocked by default. Rewrite as a read-only SELECT, or ask the user to enable mutation SQL in AI settings.`,
    };
  }
  // 未识别关键字（如存储过程调用、方言专属语句）保守地当改动处理，走同样的拦截路径。
  return {
    classification: "mutation",
    keyword,
    blockedReason: allowMutations
      ? "Unrecognized statement type requires user approval before running."
      : "Unrecognized statement type is blocked by default. Rewrite as a read-only SELECT.",
  };
}
