/**
 * Heading slug：GitHub 风格，保留 CJK。
 *
 * 步骤（与 GitHub jekyll-toc / gfm-autolink-headings 基本对齐）：
 *   1. 全文小写（ASCII 部分）
 *   2. 丢弃 emoji、常见标点（`!@#$%^&*()`, `[]{}`, `<>`, `?,.:;'"` 等），保留中文 / 日文 / 韩文 /
 *      字母 / 数字 / 空格 / `-` / `_`
 *   3. 连续空白/空格合并为单个 `-`
 *   4. 首尾修剪 `-`
 *
 * 空字符串兜底为 `"section"`，调用方再用 `slug-2/3/...` 做同名消歧。
 */

const STRIP_PUNCT_RE = /[!@#$%^&*()+=\[\]{}\\|<>?,.:;'"`~/]/g;

export function slugify(text: string): string {
  const base = text
    .toLowerCase()
    .replace(STRIP_PUNCT_RE, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "section";
}

/**
 * 给一组 heading 文本按顺序生成不重名 slug：
 *   - 第一次命中：原 slug
 *   - 第 N 次（N >= 2）：`slug-(N-1)`
 *
 * 对齐 GitHub 行为。返回与输入等长的 slug 数组。
 */
export function buildSlugs(texts: readonly string[]): string[] {
  const counts = new Map<string, number>();
  const out: string[] = [];
  for (const t of texts) {
    const base = slugify(t);
    const seen = counts.get(base) ?? 0;
    out.push(seen === 0 ? base : `${base}-${seen}`);
    counts.set(base, seen + 1);
  }
  return out;
}
