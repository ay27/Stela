/**
 * 新建文件模板。
 *
 * 目前只有一个：Stela 数据笔记。文件本质就是 Markdown，我们只是扩展了 ```runsql
 * 围栏语法。新文件统一使用 `.md`，这样文件在任何 Markdown 工具里都能直接打开/预览。
 */

import { DEFAULT_STELA_EXTENSION } from "@/core/stela-file";

export interface FileTemplate {
  /** 文件后缀，包含点 */
  extension: string;
  defaultName: string;
  build: () => string;
}

export const STELA_NOTE_TEMPLATE: FileTemplate = {
  extension: DEFAULT_STELA_EXTENSION,
  defaultName: "untitled",
  build: () => {
    // 只保留 frontmatter，不再插入空 ```runsql 块。
    //
    // 历史：早期模板默认带一个空 runsql 块当作"教程性提示"，但用户也可能就是
    // 想写一篇纯 markdown 笔记，多出来的空块需要先手动删掉很烦。frontmatter 里
    // 的 connection_name 仍保留 —— 用户后续插入 runsql 块时已有字段，不需要再
    // 编辑 frontmatter；纯文本场景下它是无害的元数据。
    const now = new Date().toISOString();
    return `---\ntype: stela-data-note\nconnection_name: ""\ncreated_at: "${now}"\n---\n\n`;
  },
};

/**
 * 在已存在的 `existingNames`（同目录下的 basename 列表）中找一个不冲突的名字，
 * 例如 `untitled.md`、`untitled-1.md`、`untitled-2.md` ...
 */
export function nextAvailableName(
  base: string,
  extension: string,
  existingNames: ReadonlySet<string>,
): string {
  const first = `${base}${extension}`;
  if (!existingNames.has(first)) return first;
  for (let i = 1; i < 10_000; i++) {
    const candidate = `${base}-${i}${extension}`;
    if (!existingNames.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}${extension}`;
}

/**
 * 重命名时校验新文件名是否合法。空字符串、含分隔符、控制字符直接 reject。
 * 返回 null 表示校验通过；返回字符串表示错误信息。
 */
export function validateFileName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "名称不能为空";
  if (/[\\/:\0]/.test(trimmed)) return "名称包含非法字符 (\\ / : \\0)";
  if (trimmed === "." || trimmed === "..") return "名称无效";
  return null;
}
