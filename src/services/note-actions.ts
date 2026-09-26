/**
 * 跨入口共享的笔记操作。
 *
 * 行为变更（v0.1 文件浏览器二期）：
 *   旧版"Cmd+N 直接在 vault 根创建 untitled-N.md"已被废弃。新版统一通过
 *   FileTree 的 inline draft 流程：选择父目录后向 `useFileTree` 投入
 *   pendingDraft，FileTree useEffect 拿到后展开父目录并渲染 InlineNameInput，
 *   用户敲回车才真正落盘。这样 Cmd+N 与右键"新建笔记"行为一致，且尊重当前
 *   用户在文件树 / 活跃 tab 里的位置上下文。
 *
 * 父目录选择优先级：
 *   1. fileTree.selectedPath（文件取父目录、目录取自身）
 *   2. workspace.activeTabId 对应 file tab 的父目录
 *   3. vaultPath 自身（兜底）
 */

import { useFileTree } from "@/state/file-tree";
import { useLayout } from "@/state/layout";
import { useWorkspace } from "@/state/workspace";

function dirname(p: string): string {
  const idx = p.lastIndexOf("/");
  if (idx <= 0) return p;
  return p.slice(0, idx);
}

/**
 * 计算"在哪个目录新建笔记"。返回的路径必然落在 `vaultPath` 内（包括 vault
 * 根本身）。`vaultPath` 为空（未打开 vault）时返回 null。
 */
export function pickParentDir(vaultPath: string | null): string | null {
  if (!vaultPath) return null;
  const ft = useFileTree.getState();
  const sel = ft.selectedPath;
  if (sel && (sel === vaultPath || sel.startsWith(`${vaultPath}/`))) {
    // 目录还是文件？目录直接用，文件取父目录
    const parent = dirname(sel);
    if (sel === vaultPath || ft.children[sel] !== undefined ||
      ft.children[parent]?.some(node => node.path === sel && node.isDir)) {
      return sel;
    }
    return parent;
  }

  const ws = useWorkspace.getState();
  const active = ws.activeTabId
    ? ws.tabs.find((t) => t.id === ws.activeTabId)
    : null;
  if (active?.kind === "file" && active.path?.startsWith(`${vaultPath}/`)) {
    return dirname(active.path);
  }
  return vaultPath;
}

/**
 * Cmd+N / 命令面板"新建笔记" 入口。计算父目录后向 file-tree store 投递
 * pendingDraft；FileTree useEffect 接管后展开目录并渲染 inline 输入框。
 *
 * 副作用：自动把 sidebar 切到 files 模式（如果之前在 search / schema），
 * 并展开 sidebar，确保用户能立刻看到输入框。
 */
export async function createNewStelaNote(
  vaultPath: string | null,
): Promise<void> {
  const parent = pickParentDir(vaultPath);
  if (!parent) return;
  useLayout.getState().focusFiles();
  useFileTree.getState().requestDraft({ kind: "newNote", parentPath: parent });
}
