/**
 * Vault 文件树。
 *
 * 行为概览：
 *   - 懒加载：点击目录展开时才 list_dir，其它目录保持折叠 / 未拉取
 *   - 右键菜单（[@radix-ui/react-context-menu](https://radix-ui.com)）：新建笔记 /
 *     新建子目录 / 在 Finder 中显示 / 重命名 / 删除到回收站；目录与文件的菜单项不同
 *   - inline 重命名：行内文本变 input，Enter 提交、Esc 取消；命中合法性走
 *     [validateFileName](../services/templates.ts)
 *   - HTML5 拖拽：文件/目录可拖到任意目录（包括 vault 根空白），调用 rename_path
 *     完成移动；禁止拖到自身或自身子目录。**外部文件**拖入会调
 *     [importFile](../services/fs.ts) 复制进 vault，同名自动加 `(1)` 后缀。
 *   - 写操作完成后调 `refresh(parentPath)` 重拉对应目录子项；同时通知 workspace store
 *     更新涉及的 tab 状态（[closeTabsForPath](../state/workspace.ts) /
 *     [renameTabsForPath](../state/workspace.ts)）
 *   - 自动 reveal：`activeTabId` / `pendingReveal` 变化时，展开该文件所有祖先目录
 *     并把对应行滚到可见区域
 *   - **选中状态**：单击文件 / 目录都会更新 `useFileTree.selectedPath`，Cmd+N
 *     新建笔记会以它为父目录基准。视觉上目录的"被选中"会有浅色背景；文件
 *     被点击会同时变成 activeTab，以更醒目的 primary 色高亮。
 *   - **pendingDraft**：AppShell 的 Cmd+N 把 `{kind:"newNote", parentPath}` 投到
 *     store；本组件 useEffect 拿到后展开父目录 + 渲染 inline 输入行。
 *   - **快速过滤**：`useFileTree.filter` 非空时，只渲染名称命中的节点 + 其祖先；
 *     祖先目录强制展开。仅过滤已 listDir 过的目录（懒加载语义）。
 *
 * 状态：展开 / 子节点缓存 / loading / error / selected / filter / pendingDraft
 * 都在 [useFileTree](../state/file-tree.ts) 全局 store 里，跨 Files ↔ Search
 * 侧栏切换不会坍塌。本组件自身只持 `draft` / `dropTarget` 这类短生命期 UI 状态。
 */

import {
  KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  Crosshair,
  Download,
  ExternalLink,
  File as FileIcon,
  Folder,
  FolderOpen,
  FolderPlus,
  NotebookPen,
  Pencil,
  RefreshCw,
  Trash2,
  X as XIcon,
} from "lucide-react";

import {
  createDir,
  createFile,
  deletePath,
  importFile,
  listDir,
  renamePath,
  type FileNode,
} from "@/services/fs";
import {
  STELA_NOTE_TEMPLATE,
  validateFileName,
} from "@/services/templates";
import { endsWithStelaExtension } from "@/core/stela-file";
import { useWorkspace } from "@/state/workspace";
import { useFileTree } from "@/state/file-tree";
import { useDialogs } from "@/state/dialogs";
import { cn } from "@/lib/utils";
import { formatHotkey } from "@/lib/hotkeys";
import { useT } from "@/i18n/use-t";

type DraftAction =
  | { kind: "newNote"; parentPath: string }
  | { kind: "newDir"; parentPath: string }
  | { kind: "rename"; node: FileNode };

/** 平台文案，决定"在 Finder / 资源管理器 / 文件管理器中显示"的提示词。 */
function revealMenuLabel(t: ReturnType<typeof useT>): string {
  const p = typeof window !== "undefined" ? window.stela?.platform : undefined;
  if (p === "win32") return t("fileTree.platform.showInExplorer");
  if (p === "linux") return t("fileTree.platform.showInFileManager");
  return t("fileTree.platform.showInFinder");
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function dirname(p: string): string {
  const idx = p.lastIndexOf("/");
  if (idx < 0) return p;
  return p.slice(0, idx);
}

function joinPath(a: string, b: string): string {
  if (a.endsWith("/")) return a + b;
  return `${a}/${b}`;
}

/**
 * 在 visibleSet 里查找是否存在 dirPath 的任意后代节点。线性扫描足够——典型
 * vault 几百到几千节点，不会成为热点。
 */
function hasVisibleDescendant(dirPath: string, vis: Set<string>): boolean {
  const prefix = `${dirPath}/`;
  for (const p of vis) {
    if (p.startsWith(prefix)) return true;
  }
  return false;
}

/** 取得某路径在 rootPath 下的祖先目录链（不含 rootPath 自身、不含 path 自身）。
 *  e.g. rootPath="/vault", path="/vault/a/b/c.md" → ["/vault/a", "/vault/a/b"] */
function ancestorDirsUnder(rootPath: string, path: string): string[] {
  if (!path.startsWith(`${rootPath}/`)) return [];
  const rel = path.slice(rootPath.length + 1);
  const parts = rel.split("/").filter(Boolean);
  parts.pop(); // 丢掉文件名本身
  const out: string[] = [];
  let cur = rootPath;
  for (const p of parts) {
    cur = `${cur}/${p}`;
    out.push(cur);
  }
  return out;
}

export function FileTree({ rootPath }: { rootPath: string }) {
  const t = useT();
  const closeTabsForPath = useWorkspace((s) => s.closeTabsForPath);
  const renameTabsForPath = useWorkspace((s) => s.renameTabsForPath);
  const openFile = useWorkspace((s) => s.openFile);

  const bindVault = useFileTree((s) => s.bindVault);
  const rootChildren = useFileTree((s) => s.children[rootPath]);
  const rootError = useFileTree((s) => s.errors[rootPath]);
  const filter = useFileTree((s) => s.filter);
  const pendingDraft = useFileTree((s) => s.pendingDraft);
  const allChildren = useFileTree((s) => s.children);

  const [draft, setDraft] = useState<DraftAction | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  // 过滤态 derived sets。filter 为空时 visible / forceExpanded 是 null，渲染层
  // 走原始懒加载路径。filter 非空时，visible 包含命中节点 + 它们的所有祖先目录
  // （用于让父链可见）；forceExpanded 是这些祖先目录，让子树即使未手动展开也展开。
  // 仅在已 listDir 过的目录里查找——未展开过的子目录不会被探查（懒加载语义）。
  const { visible, forceExpanded } = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return { visible: null as Set<string> | null, forceExpanded: null as Set<string> | null };
    const vis = new Set<string>();
    const force = new Set<string>();
    const walk = (dirPath: string) => {
      const list = allChildren[dirPath];
      if (!list) return;
      for (const node of list) {
        if (node.isDir) walk(node.path);
        const matchSelf = node.name.toLowerCase().includes(q);
        if (matchSelf || (node.isDir && hasVisibleDescendant(node.path, vis))) {
          vis.add(node.path);
          // 把 node 的所有祖先目录加入 force-expanded（不含 rootPath 自身，root 永远展开）
          let cursor = node.path;
          while (true) {
            const parent = cursor.lastIndexOf("/") > rootPath.length
              ? cursor.slice(0, cursor.lastIndexOf("/"))
              : rootPath;
            if (parent === rootPath) break;
            force.add(parent);
            vis.add(parent);
            cursor = parent;
          }
        }
      }
    };
    walk(rootPath);
    return { visible: vis, forceExpanded: force };
  }, [filter, allChildren, rootPath]);

  // 把 rootPath 当成一棵子树的虚拟父节点；所有 refresh 都走同一份逻辑
  const refresh = useCallback(async (dirPath: string) => {
    const store = useFileTree.getState();
    try {
      const rows = await listDir(dirPath);
      store.setChildren(dirPath, rows);
    } catch (err) {
      store.setError(dirPath, String(err));
    }
  }, []);

  // root 切换：绑定 vault（清空运行时缓存，从 localStorage 读回 expanded），拉一次 root
  useEffect(() => {
    bindVault(rootPath);
    setDraft(null);
    // 如果是首次绑定这个 vault，children[rootPath] 为 undefined，需要拉一次；
    // 如果是切回来的（理论上 bindVault 同一 path 会 early-return，但这里 rootPath
    // 依然是触发点），没有缓存也要拉。
    const s = useFileTree.getState();
    if (!s.children[rootPath]) void refresh(rootPath);
  }, [rootPath, bindVault, refresh]);

  const toggle = useCallback(async (node: FileNode) => {
    if (!node.isDir) return;
    const store = useFileTree.getState();
    const wasExpanded = store.expanded[node.path] === true;
    store.setExpanded(node.path, !wasExpanded);
    if (wasExpanded) return;
    if (store.children[node.path]) return;
    store.setLoading(node.path, true);
    try {
      const rows = await listDir(node.path);
      useFileTree.getState().setChildren(node.path, rows);
    } catch (err) {
      useFileTree.getState().setError(node.path, String(err));
    } finally {
      useFileTree.getState().setLoading(node.path, false);
    }
  }, []);

  const ensureExpanded = useCallback(
    async (dirPath: string) => {
      const store = useFileTree.getState();
      if (store.expanded[dirPath] !== true) store.setExpanded(dirPath, true);
      if (dirPath !== rootPath && !store.children[dirPath]) {
        await refresh(dirPath);
      }
    },
    [rootPath, refresh],
  );

  // 自动 reveal：activeTabId / pendingReveal.token 变化时，展开祖先 + 滚到目标行
  const activeTabId = useWorkspace((s) => s.activeTabId);
  const pendingReveal = useWorkspace((s) => s.pendingReveal);
  const revealToken = pendingReveal?.token ?? 0;
  useEffect(() => {
    if (!activeTabId || !activeTabId.startsWith("file:")) return;
    const targetPath = activeTabId.slice("file:".length);
    if (!targetPath.startsWith(`${rootPath}/`) && targetPath !== rootPath) {
      return;
    }
    let cancelled = false;
    (async () => {
      const ancestors = ancestorDirsUnder(rootPath, targetPath);
      for (const dir of ancestors) {
        if (cancelled) return;
        await ensureExpanded(dir);
      }
      if (cancelled) return;
      // 等一个 frame 让 DOM 把新展开的行渲染出来
      requestAnimationFrame(() => {
        if (cancelled) return;
        const el = document.querySelector<HTMLElement>(
          `[data-filetree-row="${cssEscape(targetPath)}"]`,
        );
        el?.scrollIntoView({ block: "nearest" });
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [activeTabId, revealToken, rootPath, ensureExpanded]);

  const startNewNote = useCallback(
    async (parentPath: string) => {
      await ensureExpanded(parentPath);
      setDraft({ kind: "newNote", parentPath });
    },
    [ensureExpanded],
  );
  const startNewDir = useCallback(
    async (parentPath: string) => {
      await ensureExpanded(parentPath);
      setDraft({ kind: "newDir", parentPath });
    },
    [ensureExpanded],
  );
  const startRename = useCallback((node: FileNode) => {
    setDraft({ kind: "rename", node });
  }, []);

  const cancelDraft = useCallback(() => setDraft(null), []);

  // 消费来自 AppShell hotkey（Cmd+N）/ 命令面板 / Welcome 等入口的 pendingDraft
  // 信号。父目录已经由 createNewStelaNote 选好，这里只负责展开 + 渲染输入框。
  useEffect(() => {
    if (!pendingDraft) return;
    const draftReq = useFileTree.getState().consumeDraft();
    if (!draftReq) return;
    // parentPath 必须在当前 vault 内才执行，跨 vault 的旧请求直接丢弃
    if (
      draftReq.parentPath !== rootPath &&
      !draftReq.parentPath.startsWith(`${rootPath}/`)
    ) {
      return;
    }
    void (async () => {
      await ensureExpanded(draftReq.parentPath);
      setDraft(draftReq);
    })();
  }, [pendingDraft, rootPath, ensureExpanded]);

  const commitDraft = useCallback(
    async (input: string) => {
      if (!draft) return;
      const trimmed = input.trim();
      // 静默取消：空输入或仅剩一个 .md 扩展名（用户没敲 stem 就回车 / blur）
      // 都视为放弃，不弹错误。提交真正进 createFile 之前再做严格校验。
      if (
        draft.kind !== "rename" &&
        (trimmed === "" || trimmed === STELA_NOTE_TEMPLATE.extension)
      ) {
        setDraft(null);
        return;
      }
      const validation = validateFileName(trimmed);
      if (validation) {
        window.alert(validation);
        return;
      }
      try {
        if (draft.kind === "newNote") {
          // newNote 提交时：如果用户已经输入了任一 Stela 扩展名（.md）就保留，
          // 否则补上默认扩展名（.md）
          const finalName = endsWithStelaExtension(trimmed)
            ? trimmed
            : `${trimmed}${STELA_NOTE_TEMPLATE.extension}`;
          const target = joinPath(draft.parentPath, finalName);
          await createFile(rootPath, target, STELA_NOTE_TEMPLATE.build());
          await refresh(draft.parentPath);
          openFile(target);
        } else if (draft.kind === "newDir") {
          const target = joinPath(draft.parentPath, trimmed);
          await createDir(rootPath, target);
          await refresh(draft.parentPath);
        } else if (draft.kind === "rename") {
          if (trimmed === draft.node.name) {
            setDraft(null);
            return;
          }
          const parent = dirname(draft.node.path);
          const target = joinPath(parent, trimmed);
          await renamePath(rootPath, draft.node.path, target);
          renameTabsForPath(draft.node.path, target);
          await refresh(parent);
        }
        setDraft(null);
      } catch (err) {
        window.alert(
          t("fileTree.operationFailed", {
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    },
    [draft, openFile, refresh, renameTabsForPath, rootPath, t],
  );

  const onDelete = useCallback(
    async (node: FileNode) => {
      const ok = window.confirm(
        t("fileTree.deleteConfirm", { name: node.name }),
      );
      if (!ok) return;
      try {
        await deletePath(rootPath, node.path);
        closeTabsForPath(node.path);
        await refresh(dirname(node.path));
      } catch (err) {
        window.alert(
          t("fileTree.deleteFailed", {
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    },
    [closeTabsForPath, refresh, rootPath, t],
  );

  const onDropTo = useCallback(
    async (sourcePath: string, destDir: string) => {
      setDropTarget(null);
      // 自身或子目录 → 拒绝
      if (sourcePath === destDir) return;
      if (destDir.startsWith(`${sourcePath}/`)) {
        window.alert(t("fileTree.moveIntoChild"));
        return;
      }
      const fromParent = dirname(sourcePath);
      if (fromParent === destDir) return; // 同目录无操作
      const target = joinPath(destDir, basename(sourcePath));
      try {
        await renamePath(rootPath, sourcePath, target);
        renameTabsForPath(sourcePath, target);
        await refresh(fromParent);
        await refresh(destDir);
      } catch (err) {
        window.alert(
          t("fileTree.moveFailed", {
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    },
    [refresh, renameTabsForPath, rootPath, t],
  );

  /**
   * 外部文件（OS 拖入）落入文件树。逐个文件复制；目录拖入暂不支持（v1
   * 复杂度可控，DataTransfer 上的 webkitGetAsEntry 体验也不一致）。
   * 同名走 main 端 `pickAvailableName` 自动加 ` (1)` 后缀。
   */
  const onDropExternal = useCallback(
    async (files: File[], destDir: string) => {
      setDropTarget(null);
      if (files.length === 0) return;
      const failures: string[] = [];
      for (const f of files) {
        try {
          const src = window.stela.shell.getPathForFile(f);
          if (!src) {
            failures.push(t("fileTree.externalNoPath", { name: f.name }));
            continue;
          }
          await importFile(rootPath, src, destDir);
        } catch (err) {
          failures.push(
            `${f.name}：${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      await refresh(destDir);
      if (failures.length > 0) {
        window.alert(
          t("fileTree.importPartialFailed", {
            failures: failures.join("\n"),
          }),
        );
      }
    },
    [refresh, rootPath, t],
  );

  const draftRow = useMemo(() => {
    if (!draft) return null;
    if (draft.kind === "rename") return null;
    return draft;
  }, [draft]);

  if (rootError) {
    return <div className="px-3 py-2 text-xs text-destructive">{rootError}</div>;
  }
  if (rootChildren === undefined) {
    return (
      <div className="px-3 py-2 text-xs text-muted-foreground">Loading…</div>
    );
  }

  return (
    <DirSubtree
      dirPath={rootPath}
      depth={0}
      isRoot
      rootPath={rootPath}
      draft={draft}
      draftRowForDir={draftRow}
      onToggle={toggle}
      onContextNew={{
        note: startNewNote,
        dir: startNewDir,
      }}
      onRename={startRename}
      onDelete={onDelete}
      onCommitDraft={commitDraft}
      onCancelDraft={cancelDraft}
      onDropTo={onDropTo}
      onDropExternal={onDropExternal}
      dropTarget={dropTarget}
      setDropTarget={setDropTarget}
      visible={visible}
      forceExpanded={forceExpanded}
      filterActive={filter.trim().length > 0}
    />
  );
}

/** CSS.escape polyfill 的简化版：只把 DOM 选择器里的危险字符转义掉。 */
function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(s);
  }
  return s.replace(/["\\]/g, "\\$&");
}

interface SubtreeProps {
  dirPath: string;
  depth: number;
  isRoot?: boolean;
  rootPath: string;
  draft: DraftAction | null;
  draftRowForDir: DraftAction | null;
  onToggle: (node: FileNode) => void;
  onContextNew: {
    note: (parentPath: string) => void;
    dir: (parentPath: string) => void;
  };
  onRename: (node: FileNode) => void;
  onDelete: (node: FileNode) => void;
  onCommitDraft: (name: string) => void;
  onCancelDraft: () => void;
  onDropTo: (source: string, destDir: string) => void;
  onDropExternal: (files: File[], destDir: string) => void;
  dropTarget: string | null;
  setDropTarget: (p: string | null) => void;
  /** 过滤后允许渲染的节点路径集合；null 表示无过滤（全部可见） */
  visible: Set<string> | null;
  /** 过滤命中节点的祖先目录集合（强制展开），null 表示无过滤 */
  forceExpanded: Set<string> | null;
  filterActive: boolean;
}

function DirSubtree(props: SubtreeProps) {
  const t = useT();
  const {
    dirPath,
    depth,
    isRoot,
    draft,
    onDropTo,
    onDropExternal,
    dropTarget,
    setDropTarget,
    onContextNew,
    visible,
  } = props;
  const list = useFileTree((s) => s.children[dirPath]);
  const showDraft =
    draft &&
    draft.kind !== "rename" &&
    draft.parentPath === dirPath;

  const filteredList = useMemo(() => {
    if (!list) return list;
    if (!visible) return list;
    return list.filter((n) => visible.has(n.path));
  }, [list, visible]);

  const handleDragOver = (ev: React.DragEvent) => {
    const types = ev.dataTransfer.types;
    const acceptable =
      types.includes("application/x-stela-path") || types.includes("Files");
    if (!acceptable) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = types.includes("application/x-stela-path")
      ? "move"
      : "copy";
    setDropTarget(dirPath);
  };
  const handleDragLeave = () => {
    if (dropTarget === dirPath) setDropTarget(null);
  };
  const handleDrop = (ev: React.DragEvent) => {
    ev.preventDefault();
    // 内部 path 优先；只有当不是 stela 内部拖拽时才尝试当外部文件处理
    const src = ev.dataTransfer.getData("application/x-stela-path");
    if (src) {
      void onDropTo(src, dirPath);
      return;
    }
    if (ev.dataTransfer.files && ev.dataTransfer.files.length > 0) {
      void onDropExternal(Array.from(ev.dataTransfer.files), dirPath);
    }
  };

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          className={cn(
            isRoot && "h-full overflow-y-auto py-1",
            dropTarget === dirPath && "rounded-sm ring-1 ring-primary/40",
          )}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {filteredList?.map((n) => (
            <TreeRow key={n.path} {...props} node={n} depth={depth} />
          ))}
          {showDraft ? (
            <DraftInputRow
              kind={draft!.kind}
              parentPath={dirPath}
              depth={depth}
              onCommit={props.onCommitDraft}
              onCancel={props.onCancelDraft}
            />
          ) : null}
          {isRoot && list && list.length === 0 && !showDraft ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              Folder is empty.
            </div>
          ) : null}
          {isRoot &&
          list &&
          list.length > 0 &&
          filteredList?.length === 0 &&
          !showDraft ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              {t("fileTree.emptyFilter")}
            </div>
          ) : null}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className="z-[60] min-w-[180px] overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
          // 阻止 Radix 关闭菜单后把焦点 "恢复" 到 trigger（被右键的行）。
          // 否则我们的 inline 输入框会在 mount 后立刻被 blur，触发空名提交 → 静默
          // 取消，整条菜单项看起来 "没反应"。新建笔记 / 新建子目录 / 重命名都
          // 依赖输入框拿到焦点，这里统一 preventDefault。
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <CtxItem
            icon={<NotebookPen className="h-3.5 w-3.5" />}
            label={t("fileTree.newNote")}
            hotkey="Mod+N"
            onSelect={() => onContextNew.note(dirPath)}
          />
          <CtxItem
            icon={<FolderPlus className="h-3.5 w-3.5" />}
            label={t("fileTree.newFolder")}
            onSelect={() => onContextNew.dir(dirPath)}
          />
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function TreeRow({
  node,
  depth,
  ...props
}: SubtreeProps & {
  node: FileNode;
}) {
  const t = useT();
  const {
    draft,
    onToggle,
    onContextNew,
    onRename,
    onDelete,
    onDropTo,
    onDropExternal,
    onCommitDraft,
    onCancelDraft,
    dropTarget,
    setDropTarget,
    forceExpanded,
  } = props;
  const openFile = useWorkspace((s) => s.openFile);
  const activeTabId = useWorkspace((s) => s.activeTabId);
  const isActive = !node.isDir && activeTabId === `file:${node.path}`;
  const setSelected = useFileTree((s) => s.setSelected);
  const isSelected = useFileTree((s) => s.selectedPath === node.path);
  const storeExpanded = useFileTree((s) => s.expanded[node.path] === true);
  const expanded = storeExpanded || forceExpanded?.has(node.path) === true;
  const loading = useFileTree((s) => s.loading[node.path] === true);
  const err = useFileTree((s) => s.errors[node.path]);
  const hasChildren = useFileTree(
    (s) => s.children[node.path] !== undefined,
  );
  const isRenaming = draft?.kind === "rename" && draft.node.path === node.path;
  const isDropHere = dropTarget === node.path && node.isDir;

  // 首开 / 从 localStorage 恢复时，expanded 已经是 true 但 children 还没加载 ——
  // 箭头显示为展开但目录内是空的。这里补一次 listDir 把状态对齐。
  // 正常点击展开的路径是 toggle() 里同步 setLoading + listDir，走不到这里；
  // 只有 "expanded 先到位、children 后缺失" 的冷启动情况才命中。
  useEffect(() => {
    if (!node.isDir) return;
    if (!expanded) return;
    if (hasChildren) return;
    if (loading) return;
    if (err) return;
    const store = useFileTree.getState();
    // 再拿一次最新值，防止 selector 订阅到旧快照后并发点击导致重复加载
    if (store.loading[node.path]) return;
    if (store.children[node.path] !== undefined) return;
    store.setLoading(node.path, true);
    void (async () => {
      try {
        const rows = await listDir(node.path);
        useFileTree.getState().setChildren(node.path, rows);
      } catch (e) {
        useFileTree.getState().setError(node.path, String(e));
      } finally {
        useFileTree.getState().setLoading(node.path, false);
      }
    })();
  }, [node.isDir, node.path, expanded, hasChildren, loading, err]);

  // Obsidian 风格的单/双击：
  //   - 单击文件 → ephemeral 预览（连续单击会复用同一个 ephemeral tab 的位置）
  //   - 双击文件 → 永久 tab。浏览器会先派发 click 再派发 dblclick，所以这里
  //     单击会先把当前 ephemeral 切到该路径，紧接着 dblclick 命中已开 tab 升级。
  //   - 目录 → 展开/折叠（单击即可，不区分单双击）
  const onClick = () => {
    if (isRenaming) return;
    setSelected(node.path);
    if (node.isDir) onToggle(node);
    else openFile(node.path, { ephemeral: true });
  };
  const onDoubleClick = () => {
    if (isRenaming || node.isDir) return;
    openFile(node.path);
  };

  const handleDragStart = (ev: React.DragEvent) => {
    ev.dataTransfer.setData("application/x-stela-path", node.path);
    ev.dataTransfer.effectAllowed = "move";
  };
  const handleDragOver = (ev: React.DragEvent) => {
    if (!node.isDir) return;
    const types = ev.dataTransfer.types;
    const acceptable =
      types.includes("application/x-stela-path") || types.includes("Files");
    if (!acceptable) return;
    ev.preventDefault();
    ev.stopPropagation();
    ev.dataTransfer.dropEffect = types.includes("application/x-stela-path")
      ? "move"
      : "copy";
    setDropTarget(node.path);
  };
  const handleDragLeave = () => {
    if (dropTarget === node.path) setDropTarget(null);
  };
  const handleDrop = (ev: React.DragEvent) => {
    if (!node.isDir) return;
    ev.preventDefault();
    ev.stopPropagation();
    const src = ev.dataTransfer.getData("application/x-stela-path");
    if (src) {
      void onDropTo(src, node.path);
      return;
    }
    if (ev.dataTransfer.files && ev.dataTransfer.files.length > 0) {
      void onDropExternal(Array.from(ev.dataTransfer.files), node.path);
    }
  };

  return (
    <div>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div
            draggable={!isRenaming}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <button
              type="button"
              onClick={onClick}
              onDoubleClick={onDoubleClick}
              data-filetree-row={node.path}
              className={cn(
                "relative flex w-full items-center gap-1.5 rounded-sm px-1.5 py-[3px] text-[13px] text-left",
                "hover:bg-sidebar-hover",
                // 选中（点击过但非当前 active tab）：浅色背景，区别于 active 的 primary
                isSelected && !isActive && "bg-sidebar-hover",
                // 当前打开的文件：填色 + primary 文字色 + 左侧 2px accent bar
                isActive &&
                  "bg-primary/10 text-primary font-medium before:absolute before:left-0 before:top-1/2 before:-translate-y-1/2 before:h-4 before:w-[2px] before:rounded-r before:bg-primary",
                isDropHere && "ring-1 ring-primary/50",
              )}
              style={{ paddingLeft: 6 + depth * 14 }}
            >
              {node.isDir ? (
                expanded ? (
                  <ChevronDown className="h-3.5 w-3.5 flex-none text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 flex-none text-muted-foreground" />
                )
              ) : (
                <span className="w-3.5 flex-none" />
              )}
              {node.isDir ? (
                expanded ? (
                  <FolderOpen className="h-3.5 w-3.5 flex-none text-muted-foreground" />
                ) : (
                  <Folder className="h-3.5 w-3.5 flex-none text-muted-foreground" />
                )
              ) : (
                <FileIcon
                  className={cn(
                    "h-3.5 w-3.5 flex-none",
                    isActive ? "text-primary" : "text-muted-foreground",
                  )}
                />
              )}
              {isRenaming ? (
                <InlineNameInput
                  initial={node.name}
                  onCommit={onCommitDraft}
                  onCancel={onCancelDraft}
                />
              ) : (
                <span className="truncate">{node.name}</span>
              )}
            </button>
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content
            className="z-[60] min-w-[180px] overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
            // 同 DirSubtree 的根菜单：阻止焦点回到 trigger，避免 inline 输入框
            // 立刻被 blur。新建笔记 / 新建子目录 / 重命名 都依赖此项才能拿到焦点。
            onCloseAutoFocus={(e) => e.preventDefault()}
          >
            {node.isDir ? (
              <>
                <CtxItem
                  icon={<NotebookPen className="h-3.5 w-3.5" />}
                  label={t("fileTree.newNote")}
                  hotkey="Mod+N"
                  onSelect={() => onContextNew.note(node.path)}
                />
                <CtxItem
                  icon={<FolderPlus className="h-3.5 w-3.5" />}
                  label={t("fileTree.newFolder")}
                  onSelect={() => onContextNew.dir(node.path)}
                />
                <ContextMenu.Separator className="my-1 h-px bg-border" />
              </>
            ) : null}
            <CtxItem
              icon={<ExternalLink className="h-3.5 w-3.5" />}
              label={revealMenuLabel(t)}
              onSelect={() => {
                const op = node.isDir
                  ? window.stela.shell.openPath(node.path)
                  : window.stela.shell.showItemInFolder(node.path);
                void op.catch((err) => {
                  window.alert(
                    t("fileTree.openFailed", {
                      message: err instanceof Error ? err.message : String(err),
                    }),
                  );
                });
              }}
            />
            {!node.isDir && endsWithStelaExtension(node.path) ? (
              <>
                <ContextMenu.Separator className="my-1 h-px bg-border" />
                <CtxItem
                  icon={<Download className="h-3.5 w-3.5" />}
                  label={t("fileTree.exportMarkdown")}
                  onSelect={() =>
                    useDialogs.getState().openExportNote(node.path)
                  }
                />
              </>
            ) : null}
            <ContextMenu.Separator className="my-1 h-px bg-border" />
            <CtxItem
              icon={<Pencil className="h-3.5 w-3.5" />}
              label={t("fileTree.rename")}
              onSelect={() => onRename(node)}
            />
            <CtxItem
              icon={<Trash2 className="h-3.5 w-3.5" />}
              label={t("fileTree.moveToTrash")}
              destructive
              onSelect={() => onDelete(node)}
            />
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>

      {node.isDir && expanded ? (
        loading ? (
          <div
            className="px-2 py-1 text-[11px] text-muted-foreground"
            style={{ paddingLeft: 6 + (depth + 1) * 14 }}
          >
            {t("common.loading")}
          </div>
        ) : err ? (
          <div
            className="px-2 py-1 text-[11px] text-destructive"
            style={{ paddingLeft: 6 + (depth + 1) * 14 }}
          >
            {err}
          </div>
        ) : (
          <DirSubtree
            {...props}
            dirPath={node.path}
            depth={depth + 1}
            isRoot={false}
          />
        )
      ) : null}
    </div>
  );
}

function CtxItem({
  icon,
  label,
  hotkey,
  onSelect,
  destructive,
}: {
  icon: React.ReactNode;
  label: string;
  /** 快捷键表达式（如 `"Mod+N"`），右对齐展示；不会注册键位，仅做视觉提示 */
  hotkey?: string;
  onSelect: () => void;
  destructive?: boolean;
}) {
  return (
    <ContextMenu.Item
      onSelect={onSelect}
      className={cn(
        "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-xs outline-none",
        "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
        destructive && "text-destructive data-[highlighted]:text-destructive",
      )}
    >
      {icon}
      <span className="flex-1">{label}</span>
      {hotkey ? (
        <span className="font-mono text-[10px] text-muted-foreground">
          {formatHotkey(hotkey)}
        </span>
      ) : null}
    </ContextMenu.Item>
  );
}

function DraftInputRow({
  kind,
  depth,
  onCommit,
  onCancel,
}: {
  kind: "newNote" | "newDir";
  parentPath: string;
  depth: number;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  // 新建笔记 → 预填扩展名 ".md"，光标置于 stem 位置（开头），让用户立刻打名字；
  // 新建子目录 → 留空。这样用户敲回车 / blur 时空 stem 会被静默取消。
  const initial = kind === "newNote" ? STELA_NOTE_TEMPLATE.extension : "";
  const Icon = kind === "newDir" ? Folder : FileIcon;
  return (
    <div
      className="flex items-center gap-1.5 px-1.5 py-[3px] text-[13px]"
      style={{ paddingLeft: 6 + (depth + 1) * 14 }}
    >
      <span className="w-3.5 flex-none" />
      <Icon className="h-3.5 w-3.5 flex-none text-muted-foreground" />
      <InlineNameInput
        initial={initial}
        onCommit={onCommit}
        onCancel={onCancel}
        autoSelectStem={kind === "newNote"}
      />
    </div>
  );
}

function InlineNameInput({
  initial,
  onCommit,
  onCancel,
  autoSelectStem,
}: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
  autoSelectStem?: boolean;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    if (autoSelectStem) {
      const dot = initial.lastIndexOf(".");
      if (dot > 0) {
        el.setSelectionRange(0, dot);
      } else if (dot === 0) {
        // 形如 ".md" —— 把光标停在最前，让用户从零打名字
        el.setSelectionRange(0, 0);
      } else {
        el.select();
      }
    } else {
      el.select();
    }
  }, [autoSelectStem, initial]);

  const onKeyDown = (ev: KeyboardEvent<HTMLInputElement>) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      onCommit(value);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      onCancel();
    }
  };

  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => onCommit(value)}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      className="min-w-0 flex-1 rounded-sm border border-primary/40 bg-background px-1 py-px text-[13px] focus:outline-none"
    />
  );
}

/**
 * Files 侧栏的容器：顶部一行小工具（折叠 / 刷新 / 定位 / 过滤），下方是 FileTree。
 *
 * 抽出来主要是把"工具栏"语义从 FileTree 主体中分离——FileTree 内部只关心
 * 树结构本身；分页 / 选区 / 工具栏由外层管理，方便未来加更多控件。
 */
export function FilesPanel({ rootPath }: { rootPath: string }) {
  return (
    <div className="flex h-full flex-col">
      <FileTreeToolbar rootPath={rootPath} />
      <div className="min-h-0 flex-1">
        <FileTree rootPath={rootPath} />
      </div>
    </div>
  );
}

function FileTreeToolbar({ rootPath }: { rootPath: string }) {
  const t = useT();
  const filter = useFileTree((s) => s.filter);
  const setFilter = useFileTree((s) => s.setFilter);
  const collapseAll = useFileTree((s) => s.collapseAll);
  const revealActive = useWorkspace((s) => s.revealActiveFile);

  const refresh = useCallback(async () => {
    const store = useFileTree.getState();
    try {
      const rows = await listDir(rootPath);
      store.setChildren(rootPath, rows);
    } catch (err) {
      store.setError(rootPath, String(err));
    }
  }, [rootPath]);

  return (
    <div className="flex items-center gap-1 border-b border-border px-2 py-1">
      <ToolButton
        icon={<Crosshair className="h-3.5 w-3.5" />}
        label={t("fileTree.locateCurrent")}
        hotkey="Mod+Shift+E"
        onClick={() => revealActive()}
      />
      <ToolButton
        icon={<ChevronsDownUp className="h-3.5 w-3.5" />}
        label={t("fileTree.collapseAll")}
        onClick={() => collapseAll()}
      />
      <ToolButton
        icon={<RefreshCw className="h-3.5 w-3.5" />}
        label={t("common.refresh")}
        onClick={() => void refresh()}
      />
      <div className="relative ml-1 min-w-0 flex-1">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t("fileTree.filterPlaceholder")}
          spellCheck={false}
          className={cn(
            "w-full min-w-0 rounded-sm border border-border bg-background px-1.5 py-px text-[12px]",
            "placeholder:text-muted-foreground focus:border-primary/50 focus:outline-none",
            filter ? "pr-5" : "",
          )}
        />
        {filter ? (
          <button
            type="button"
            onClick={() => setFilter("")}
            title={t("fileTree.clearFilter")}
            className="absolute right-0.5 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:bg-sidebar-hover"
          >
            <XIcon className="h-3 w-3" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ToolButton({
  icon,
  label,
  hotkey,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hotkey?: string;
  onClick: () => void;
}) {
  const hint = hotkey ? formatHotkey(hotkey) : null;
  const title = hint ? `${label} (${hint})` : label;
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="rounded-sm p-1 text-muted-foreground hover:bg-sidebar-hover hover:text-foreground"
    >
      {icon}
    </button>
  );
}
