/**
 * Stela 数据笔记的文件扩展名定义。
 *
 * Stela 数据笔记现在统一使用 `.md`，与通用 Markdown 工具互通
 * （GitHub / VSCode / Obsidian 都能预览）。
 *
 * 所有"这是不是一个 Stela 笔记"的判定都应当使用这里的常量；
 * 不要在业务代码里散落字符串字面量。
 */

/** Stela 数据笔记可被识别的所有扩展名（含点，小写）。顺序仅用于默认列表展示。 */
export const STELA_EXTENSIONS: readonly string[] = [".md"] as const;

/** 新建笔记使用的默认扩展名。 */
export const DEFAULT_STELA_EXTENSION = ".md";

/**
 * 判断给定路径是否匹配 Stela 笔记扩展名（扩展名不区分大小写）。
 */
export function isStelaFilePath(path: string): boolean {
  const lower = path.toLowerCase();
  return STELA_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * 判断字符串是否以任一 Stela 扩展名结尾（主要给"用户输入文件名时该不该自动补扩展名"用）。
 */
export function endsWithStelaExtension(name: string): boolean {
  return isStelaFilePath(name);
}
