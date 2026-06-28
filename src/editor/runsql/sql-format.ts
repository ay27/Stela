/**
 * SQL 格式化封装。
 *
 * 用 `sql-formatter` 库做格式化（dialect=mysql 兼容主流方言；MariaDB / TiDB /
 * 大部分 DataLake SQL 也能通）。封装的目的：
 *   - 统一处理空 SQL（直接返回原文，不替换 → 不污染 undo 栈）
 *   - 抓 formatter 抛出的 parse error，吞掉并返回原文（典型场景：用户写到一半
 *     语法残缺，不应让快捷键把窗口炸掉）
 *   - 给 CodeMirror 提供一个 command，绑 `Mod-Alt-l`（JetBrains 风格）：
 *       1. 取整段 doc 文本
 *       2. format 后若与原文不同 → dispatch 一次 changes 替换
 *       3. 把光标尽量留在 doc 末尾（格式化后位置无意义；用户通常想继续往后写）
 *
 * 有意不保留 selection / 光标偏移：sql-formatter 会重排空白和换行，旧 offset
 * 在新文本里几乎一定指错位置；强行映射反而比"贴到末尾"更刺眼。
 */

import type { Command, EditorView } from "@codemirror/view";
import { format as formatSql } from "sql-formatter";

/**
 * 格式化一段 SQL 文本。
 *
 * 失败时返回原文，方便 caller 直接 `next === input ? skip : replace`。
 */
export function formatSqlSafe(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return input;
  try {
    return formatSql(input, {
      language: "mysql",
      keywordCase: "upper",
      tabWidth: 2,
      useTabs: false,
      linesBetweenQueries: 1,
    });
  } catch {
    return input;
  }
}

/**
 * CodeMirror 命令：格式化整段 doc。绑 `Mod-Alt-l`（macOS ⌥⌘L、Win/Linux Ctrl+Alt+L）。
 *
 * 返回 true 表示 keymap 命中（即使 formatter 没改文本也返回 true，避免快捷键
 * 落到下层处理器；空文档时返回 false 让默认行为接手）。
 */
export const formatSqlCommand: Command = (view: EditorView): boolean => {
  const original = view.state.doc.toString();
  if (!original.trim()) return false;
  const next = formatSqlSafe(original);
  if (next === original) return true;
  view.dispatch({
    changes: { from: 0, to: original.length, insert: next },
    selection: { anchor: next.length },
    scrollIntoView: true,
  });
  return true;
};
