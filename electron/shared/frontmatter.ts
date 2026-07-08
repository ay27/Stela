/**
 * Frontmatter 解析（只读部分）。main / renderer 共用的规范实现——
 * `src/core/markdown.ts` 直接重导出本模块的 `splitFrontmatter` / `parseFrontmatterField`。
 *
 * main 侧的 SQL 索引服务（`electron/services/sql-index.ts`）用它读出笔记
 * frontmatter 的 `connection_name`，据此解析出 SQL 方言。
 *
 * 只读：写入逻辑（`updateFrontmatterField`）绑定编辑器 round-trip 的换行/空
 * 行约定，留在 `src/core/markdown.ts`，main 侧不需要写 frontmatter。
 */

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---(?:\n|$)/;
const LEGACY_SEPARATOR_RE = /(?:^|\n)---\n---(?:\n|$)/g;
// 代码块结束符 ``` 紧贴 <detail>：CommonMark 允许，但加空行更稳，且能让 stringify 回写时
// 与吸附后的 mdast 结构对齐
const FENCE_TO_DETAIL_RE = /(\n```[ \t]*)\n(<detail[\s>])/g;
// </detail> 后必须有空行，否则 HTML block (type 7) 不会终止，会把后续内容吞进 HTML 块
const DETAIL_END_NO_BLANK_RE = /(<\/detail>[ \t]*)\n(?!\n|$)/g;

export interface SplitRaw {
  /** 含两个 `---\n` 包夹的完整 frontmatter 块（可能带尾随 `\n`），无 frontmatter 时为空串。 */
  frontmatter: string;
  /** 剥掉 frontmatter、折叠掉 legacy `---\n---` 分隔符的正文。 */
  body: string;
}

export function splitFrontmatter(raw: string): SplitRaw {
  const text = raw.replace(/\r\n/g, "\n");
  const m = text.match(FRONTMATTER_RE);
  const frontmatter = m ? m[0] : "";
  const after = text.slice(frontmatter.length);

  const body = after
    .replace(LEGACY_SEPARATOR_RE, "\n\n")
    .replace(FENCE_TO_DETAIL_RE, "$1\n\n$2")
    .replace(DETAIL_END_NO_BLANK_RE, "$1\n\n");

  return { frontmatter, body };
}

/**
 * 从 frontmatter 文本里抓单行 `key: value` 形式的字段值。
 *
 * 极简实现，刻意不引 yaml parser：Stela 的 frontmatter 字段就是一组 scalar，
 * 不存在嵌套或多行 string。无匹配返回 null。
 *
 * 兼容值带引号的写法，如 `key: "value"` / `key: 'value'`。
 */
export function parseFrontmatterField(
  frontmatter: string,
  key: string,
): string | null {
  if (!frontmatter) return null;
  const re = new RegExp(`(?:^|\\n)\\s*${escapeFrontmatterKey(key)}\\s*:\\s*([^\\n]*)`);
  const m = frontmatter.match(re);
  if (!m) return null;
  let v = m[1]!.trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1);
  }
  return v.length === 0 ? null : v;
}

export function escapeFrontmatterKey(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
