/**
 * 「当前激活编辑器」模块级单例。
 *
 * 同一时刻只有 active tab 的 EditorView 被 mount（见 src/layout/Workspace.tsx），
 * 所以全局只需持有一个 PM EditorView。MilkdownEditor 的视图捕获插件在 `view()`
 * 时 setActiveEditorView、`destroy()` 时按引用 clearActiveEditorView，避免热更新 /
 * StrictMode double-invoke 时悬挂旧实例。
 *
 * 用途：让不持有 editorRef 的全局入口（命令面板）也能对当前编辑器下命令，
 * 例如「插入 RunSQL 块」。
 */
import type { EditorView as PMView } from "@milkdown/prose/view";

import { insertRunSqlBlock } from "./runsql/execution";

let activeView: PMView | null = null;

export function setActiveEditorView(view: PMView): void {
  activeView = view;
}

export function clearActiveEditorView(view: PMView): void {
  if (activeView === view) activeView = null;
}

export function getActiveEditorView(): PMView | null {
  return activeView;
}

/**
 * 往当前激活编辑器插入一个空 runsql 块。没有激活编辑器（无打开文件）时返回 false。
 */
export function insertRunSqlIntoActiveEditor(): boolean {
  if (!activeView) return false;
  return insertRunSqlBlock(activeView);
}
