/**
 * Stela 的 markdown 薄封装层。
 *
 * Plate 时代这里塞了一堆 Slate 转换 + 正则切段，是为了绕开 plate-markdown / remark-mdx
 * 把 HTML 注释改写成 MDX 表达式的怪现象。换到 Milkdown（markdown-first）后，md ⇄ ProseMirror
 * 由 Milkdown 内部的 remark 管线负责，本文件只剩两个职责：
 *  - 把磁盘 raw 切成 `frontmatter` 与 `body` 两部分（Milkdown 的 commonmark/gfm 不解析 YAML
 *    frontmatter，需要我们自己把它剥出来，保存时再拼回去）
 *  - 把"老格式"里裸露的 `\n---\n---\n` 块分隔符吃掉（避免 Milkdown 把它渲染成两条水平线）
 *  - runsql/detail 块的吸附与反吸附统一放在 `src/editor/runsql/` 目录里，由 Milkdown 自定义
 *    remark 插件接管，本文件不再参与
 */

import { escapeFrontmatterKey, splitFrontmatter as sharedSplitFrontmatter } from "@shared/frontmatter";

export type { SplitRaw } from "@shared/frontmatter";
export { parseFrontmatterField } from "@shared/frontmatter";

// splitFrontmatter / parseFrontmatterField 的规范实现已抽到 `@shared/frontmatter`
// 供 main 进程的 SQL 索引服务复用（读 `connection_name`）；这里重导出保留既有导入路径。
export const splitFrontmatter = sharedSplitFrontmatter;

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---(?:\n|$)/;
const escapeReg = escapeFrontmatterKey;

/**
 * 在 raw 里把 frontmatter 的某个 scalar 字段设为 `value`。
 *
 * 规则：
 *   - 无 frontmatter 时，生成一段 `---\n<key>: <value>\n---\n` 插入开头
 *   - 有 frontmatter 且字段存在：就地替换（保持其它字段顺序）
 *   - 有 frontmatter 但字段不存在：在 frontmatter 末尾追加一行
 *   - value 为 null / 空串：删除该字段所在行
 *
 * value 统一按原样写入（不加引号），Stela 连接名约定都是简单 ASCII，不走 YAML escape 逻辑。
 */
export function updateFrontmatterField(
  raw: string,
  key: string,
  value: string | null,
): string {
  const text = raw.replace(/\r\n/g, "\n");
  const m = text.match(FRONTMATTER_RE);
  if (!m) {
    // 全新 frontmatter
    if (value == null || value.length === 0) return text;
    const fm = `---\n${key}: ${value}\n---\n`;
    return text.length === 0 ? fm : `${fm}${text.startsWith("\n") ? "" : "\n"}${text}`;
  }
  const fmRaw = m[0];
  // 分离 frontmatter 内部行
  const inner = fmRaw.replace(/^---\n/, "").replace(/\n---(?:\n|$)$/, "");
  const lines = inner.split("\n");
  const fieldRe = new RegExp(`^\\s*${escapeReg(key)}\\s*:`);
  const existIdx = lines.findIndex((ln) => fieldRe.test(ln));
  if (value == null || value.length === 0) {
    if (existIdx < 0) return text;
    lines.splice(existIdx, 1);
  } else if (existIdx >= 0) {
    lines[existIdx] = `${key}: ${value}`;
  } else {
    lines.push(`${key}: ${value}`);
  }
  const rebuilt =
    lines.length === 0 ? "" : `---\n${lines.join("\n")}\n---\n`;
  // 保留原 frontmatter 结尾是否换行的风格：原 block 最后总以 `\n` 结尾（被 FRONTMATTER_RE 吸收），
  // 所以直接拼接剩余 body 即可。
  const body = text.slice(fmRaw.length);
  return rebuilt + body;
}

export function joinFrontmatter(frontmatter: string, body: string): string {
  if (!frontmatter) return body.endsWith("\n") ? body : body + "\n";
  // splitFrontmatter 把 frontmatter 的 `---\n` 收进了 frontmatter 段，剩下的 body
  // 通常自带一个前导 `\n`，所以这里直接拼接，不再额外补 `\n`，否则 join → split 会出现
  // body 头部多 `\n` 的不幂等。
  const head = frontmatter.endsWith("\n") ? frontmatter : frontmatter + "\n";
  const trimmedBody = body.replace(/\n+$/, "");
  return head + trimmedBody + "\n";
}
