import { useEffect, useMemo } from "react";

import { Sidebar } from "./Sidebar";
import { SidebarResizer } from "./SidebarResizer";
import { TabBar } from "./TabBar";
import { Workspace } from "./Workspace";
import { useWorkspace } from "@/state/workspace";
import { useDialogs } from "@/state/dialogs";
import { useLayout } from "@/state/layout";
import { useTabSwitcher } from "@/state/tab-switcher";
import { ConnectionsDialog } from "@/components/connections-dialog";
import { ExportNoteDialog } from "@/components/export-note-dialog";
import { SettingsDialog } from "@/components/settings-dialog";
import { TabSwitcher } from "@/components/tab-switcher";
import {
  CommandPalette,
  type CommandHandlers,
} from "@/components/command-palette";
import { createNewStelaNote } from "@/services/note-actions";
import { installExternalLinkHandler } from "@/services/opener";
import { installVaultWatcherSubscriber } from "@/services/vault-watcher-subscriber";
import { useFindState } from "@/editor/find-in-file";
import { insertRunSqlIntoActiveEditor } from "@/editor/active-editor";
import { useHotkeys, type HotkeyBinding } from "@/lib/hotkeys";
import { cn } from "@/lib/utils";

export function AppShell() {
  const initialize = useWorkspace((s) => s.initialize);
  const vaultPath = useWorkspace((s) => s.vaultPath);
  const chooseVault = useWorkspace((s) => s.chooseVault);
  const closeTab = useWorkspace((s) => s.closeTab);
  const setActiveTab = useWorkspace((s) => s.setActive);
  const reopenLastClosed = useWorkspace((s) => s.reopenLastClosed);

  const connectionsOpen = useDialogs((s) => s.connectionsOpen);
  const setConnectionsOpen = useDialogs((s) => s.setConnections);
  const settingsOpen = useDialogs((s) => s.settingsOpen);
  const setSettingsOpen = useDialogs((s) => s.setSettings);
  const paletteOpen = useDialogs((s) => s.paletteOpen);
  const setPaletteOpen = useDialogs((s) => s.setPalette);
  const togglePalette = useDialogs((s) => s.togglePalette);
  const exportNoteFilePath = useDialogs((s) => s.exportNoteFilePath);
  const closeExportNote = useDialogs((s) => s.closeExportNote);

  const sidebarCollapsed = useLayout((s) => s.sidebarCollapsed);
  const sidebarWidth = useLayout((s) => s.sidebarWidth);
  const toggleSidebar = useLayout((s) => s.toggleSidebar);
  const focusSearch = useLayout((s) => s.focusSearch);
  const focusFiles = useLayout((s) => s.focusFiles);
  const revealActiveFile = useWorkspace((s) => s.revealActiveFile);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  // 全局拦截外部链接点击，交给 Tauri opener 插件；否则在 WebView 里 <a target="_blank">
  // 不会有任何反应（Milkdown link-preview 小弹窗里的链接、正文 [text](url) 都会失灵）
  useEffect(() => installExternalLinkHandler(), []);

  // 订阅 main 进程 vault watcher 的外部变更事件（v0.2 #7）。一次性安装，
  // installVaultWatcherSubscriber 内部已做幂等。
  useEffect(() => installVaultWatcherSubscriber(), []);

  // Ctrl+Tab 切换器键盘驱动。
  //
  // 不走 useHotkeys：那是"按一次匹配一次"的模式，不能表达"持续按住 Ctrl，
  // 每按一次 Tab 移到下一项，松开 Ctrl 完成切换"这种 hold-key 行为。
  //
  // 关键点：
  //   - capture phase 拦截 keydown：要在 Milkdown / CodeMirror / 输入框之前
  //     吃掉 Tab，否则编辑器会把它当成普通 Tab 键缩进 / 切焦点
  //   - 用 e.code === "Tab" 而不是 e.key（macOS 上 Option 等组合可能改 e.key）
  //   - keyup 只看 Control 物理键松开（Mac/Windows/Linux 三端 e.key 都是 "Control"）
  //   - window blur 时强制 cancel：用户 Cmd+Tab 切走 app 时，Control keyup 不会
  //     在我们这边触发，必须主动收尾，避免回来时弹窗"卡住"
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const sw = useTabSwitcher.getState();
      const isCtrlTab =
        e.code === "Tab" && e.ctrlKey && !e.metaKey && !e.altKey;
      if (isCtrlTab) {
        e.preventDefault();
        e.stopPropagation();
        const direction: 1 | -1 = e.shiftKey ? -1 : 1;
        if (sw.open) sw.move(direction);
        else sw.openSwitcher(direction);
        return;
      }
      if (sw.open && e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        sw.cancel();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const sw = useTabSwitcher.getState();
      if (!sw.open) return;
      // 物理 Control 键松开 → 确认选中
      if (e.key === "Control") sw.confirm();
    };
    const onBlur = () => {
      const sw = useTabSwitcher.getState();
      if (sw.open) sw.cancel();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const handlers: CommandHandlers = {
    openConnections: () => setConnectionsOpen(true),
    openSettings: () => setSettingsOpen(true),
    chooseVault: () => void chooseVault(),
    newStelaNote: () => createNewStelaNote(vaultPath),
    insertRunSqlBlock: () => insertRunSqlIntoActiveEditor(),
  };

  // Hotkeys：key 规则见 docs/keybindings.md
  const bindings: HotkeyBinding[] = useMemo(() => {
    const gotoTab = (idx: number) => {
      const { tabs } = useWorkspace.getState();
      const tab = tabs[idx];
      if (tab) setActiveTab(tab.id);
    };
    return [
      {
        keys: "Mod+K",
        context: "always",
        handler: () => togglePalette(),
      },
      {
        keys: "Mod+N",
        context: "always",
        handler: () => void handlers.newStelaNote(),
      },
      {
        keys: "Mod+W",
        context: "always",
        handler: () => {
          const { activeTabId } = useWorkspace.getState();
          if (activeTabId) closeTab(activeTabId);
        },
      },
      {
        // 恢复最近关闭的 tab。无论焦点在哪里都生效（include 编辑器内）。
        // 与浏览器 / IDE 通用习惯一致。
        keys: "Mod+Shift+T",
        context: "always",
        handler: () => reopenLastClosed(),
      },
      {
        // Mod+Shift+F 仍走 vault 全局搜索（侧栏 SearchPanel）。
        keys: "Mod+Shift+F",
        context: "always",
        handler: () => focusSearch(),
      },
      {
        // Mod+F：当前文档内查找（chrome 风格 find-in-file 浮动 bar）。
        // 编辑器内 host 的 capture-phase keydown 已会拦截这条键位，这里只是兜底
        // 在焦点不在编辑器（如点了 button、focus 落在 body）时也能打开 bar。
        keys: "Mod+F",
        context: "always",
        handler: () => useFindState.getState().open("find"),
      },
      {
        // Mod+Alt+F：当前文档内查找 + 替换（同 IDE 通用约定）。
        keys: "Mod+Alt+F",
        context: "always",
        handler: () => useFindState.getState().open("replace"),
      },
      {
        keys: "Mod+B",
        context: "always",
        handler: () => toggleSidebar(),
      },
      {
        // 定位当前活跃 file tab 到文件树（同 VSCode / Obsidian 的 reveal in
        // explorer）。先把 sidebar 切到 files 模式 + 展开，再让 file-tree
        // useEffect 通过 pendingReveal 滚动并展开祖先。
        keys: "Mod+Shift+E",
        context: "always",
        handler: () => {
          focusFiles();
          revealActiveFile();
        },
      },
      {
        keys: "Mod+,",
        context: "always",
        handler: () => setSettingsOpen(true),
      },
      {
        // Mod+Shift+S：在光标处插入一个空 runsql 块（S=SQL）。context "always"
        // 让它在编辑器内打字时也生效——这正是插入块的使用场景。无打开文件时
        // insertRunSqlIntoActiveEditor() 返回 false，静默 no-op。
        keys: "Mod+Shift+S",
        context: "always",
        handler: () => {
          insertRunSqlIntoActiveEditor();
        },
      },
      {
        // Mod+Enter：runsql 块内在 CM 里有 bridgeKeymap 直接处理（preventDefault
        // 后这里因为 defaultPrevented 检查会跳过，不会双发）。加这条全局 fallback
        // 是为了覆盖"焦点不在 CM 里，但在 runsql 块范围内"的场景——比如用户先
        // 点了 Run 按钮，焦点变成 button；或者点到结果表格；这时按 Cmd+Enter
        // 依然能运行当前块。
        keys: "Mod+Enter",
        context: "always",
        handler: () => {
          const active = document.activeElement as HTMLElement | null;
          // 从当前焦点向上找最近的 runsql 块
          let cb: HTMLElement | null =
            active?.closest(".stela-cb--runsql") as HTMLElement | null;
          // 焦点什么都不在（body）→ 找视口里唯一或最居中的一个 runsql 块
          if (!cb) {
            const all = Array.from(
              document.querySelectorAll<HTMLElement>(".stela-cb--runsql"),
            );
            if (all.length === 1) cb = all[0];
          }
          cb?.querySelector<HTMLButtonElement>(".stela-cb__run")?.click();
        },
      },
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map<HotkeyBinding>((n) => ({
        keys: `Mod+${n}`,
        context: "always",
        handler: () => gotoTab(n - 1),
      })),
    ];
    // handlers is reconstructed each render but referentially unstable keys
    // are only used via getState() — safe to depend only on stable store actions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    togglePalette,
    closeTab,
    reopenLastClosed,
    setActiveTab,
    focusSearch,
    focusFiles,
    revealActiveFile,
    toggleSidebar,
    setSettingsOpen,
    vaultPath,
  ]);
  useHotkeys(bindings);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <aside
        data-sidebar-aside
        style={sidebarCollapsed ? { width: 0 } : { width: sidebarWidth }}
        className={cn(
          "relative flex h-full flex-none flex-col border-r border-border bg-sidebar text-sidebar-foreground transition-[width] duration-150",
          sidebarCollapsed && "overflow-hidden border-r-0",
        )}
      >
        <Sidebar />
        {sidebarCollapsed ? null : <SidebarResizer />}
      </aside>
      <main className="flex h-full flex-1 flex-col overflow-hidden">
        {/*
         * Frameless 窗口拖拽兜底：
         *   - Sidebar 显示时：vault header + TabBar 都已是 drag region，
         *     窗口随便拖；红绿灯落在 Sidebar 顶部，不挡 main 区。
         *   - Sidebar 收起时：sidebar width=0 → Editor 占满整窗，左上角
         *     会被 macOS 红绿灯遮住 / Windows overlay 按钮飘在右上角，且
         *     若同时没有 tab（无 TabBar），整窗找不到任何 drag region。
         *
         * 解决：sidebar 收起时在 main 顶部插一条 h-9 透明 strip，承担
         *   1) drag region；2) 给红绿灯（mac）/ overlay 按钮（win/linux）
         *   让出物理空间，避免它们盖住 EditorView 内容。
         * 高度与 TabBar 一致，视觉上像 TabBar 的延续（即使 TabBar 不渲染）。
         */}
        {sidebarCollapsed ? (
          <div className="stela-app-drag stela-titlebar-safe-right flex h-9 flex-none items-stretch border-b border-border bg-muted/40" />
        ) : null}
        <TabBar />
        <Workspace />
      </main>

      <ConnectionsDialog
        open={connectionsOpen}
        onOpenChange={setConnectionsOpen}
      />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        handlers={handlers}
      />
      <ExportNoteDialog
        filePath={exportNoteFilePath}
        onClose={closeExportNote}
      />
      <TabSwitcher />
    </div>
  );
}
