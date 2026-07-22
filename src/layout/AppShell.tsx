import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";

import { WindowsTitleBar } from "./WindowsTitleBar";
import { Sidebar } from "./Sidebar";
import { SidebarResizer } from "./SidebarResizer";
import { AgentSidebar } from "./AgentSidebar";
import { AppDockBar } from "./AppDockBar";
import { TabBar } from "./TabBar";
import { Workspace } from "./Workspace";
import { useWorkspace } from "@/state/workspace";
import { useDialogs } from "@/state/dialogs";
import { useLayout } from "@/state/layout";
import { useTabSwitcher } from "@/state/tab-switcher";
import { ConnectionsDialog } from "@/components/connections-dialog";
import { ExportNoteDialog } from "@/components/export-note-dialog";
import { SettingsDialog } from "@/components/settings-dialog";
import { AiModal } from "@/components/ai/ai-modal";
import { addFocusedContextToChat } from "@/components/ai/add-to-chat";
import { TabSwitcher } from "@/components/tab-switcher";
import {
  CommandPalette,
  type CommandHandlers,
} from "@/components/command-palette";
import { createNewStelaNote } from "@/services/note-actions";
import { installExternalLinkHandler } from "@/services/opener";
import { installVaultWatcherSubscriber } from "@/services/vault-watcher-subscriber";
import { installSqlIndexSubscriber } from "@/state/sql-search";
import { useFindState } from "@/editor/find-in-file";
import { insertRunSqlIntoActiveEditor } from "@/editor/active-editor";
import { useHotkeys, type HotkeyBinding } from "@/lib/hotkeys";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n/use-t";

export function AppShell() {
  const t = useT();
  const [quitting, setQuitting] = useState(false);
  const [exportToast, setExportToast] = useState<{
    fileName: string;
    revealToken: string;
  } | null>(null);
  const initialize = useWorkspace((s) => s.initialize);
  const vaultPath = useWorkspace((s) => s.vaultPath);
  const chooseVault = useWorkspace((s) => s.chooseVault);
  const closeTab = useWorkspace((s) => s.closeTab);
  const setActiveTab = useWorkspace((s) => s.setActive);
  const reopenLastClosed = useWorkspace((s) => s.reopenLastClosed);
  const goBack = useWorkspace((s) => s.goBack);
  const goForward = useWorkspace((s) => s.goForward);

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
  const focusSearch = useLayout((s) => s.focusSearch);
  const focusFiles = useLayout((s) => s.focusFiles);
  const focusAgentPanel = useLayout((s) => s.focusAgentPanel);
  const revealActiveFile = useWorkspace((s) => s.revealActiveFile);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  useEffect(
    () => window.stela.app.onQuitCheckpointStarted(() => setQuitting(true)),
    [],
  );

  useEffect(() => {
    if (!exportToast) return;
    const timer = window.setTimeout(() => setExportToast(null), 10_000);
    return () => window.clearTimeout(timer);
  }, [exportToast]);

  // 全局拦截外部链接点击，交给 Tauri opener 插件；否则在 WebView 里 <a target="_blank">
  // 不会有任何反应（Milkdown link-preview 小弹窗里的链接、正文 [text](url) 都会失灵）
  useEffect(() => installExternalLinkHandler(), []);

  // 订阅 main 进程 vault watcher 的外部变更事件（v0.2 #7）。一次性安装，
  // installVaultWatcherSubscriber 内部已做幂等。
  useEffect(() => installVaultWatcherSubscriber(), []);

  // 订阅 main 进程 SQL 事实索引的状态变化（建库进度 / 就绪 / 增量更新）。
  useEffect(() => installSqlIndexSubscriber(), []);

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
    openAgent: () => focusAgentPanel(),
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
        // 文档导航后退（浏览器式历史，含 wikilink / 搜索定位）。
        keys: "Mod+[",
        context: "always",
        handler: () => goBack(),
      },
      {
        keys: "Mod+]",
        context: "always",
        handler: () => goForward(),
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
        keys: "Mod+Shift+A",
        context: "always",
        handler: () => focusAgentPanel(),
      },
      {
        keys: "Mod+I",
        context: "always",
        handler: () => {
          addFocusedContextToChat();
        },
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
    goBack,
    goForward,
    setActiveTab,
    focusSearch,
    focusFiles,
    focusAgentPanel,
    revealActiveFile,
    setSettingsOpen,
    vaultPath,
  ]);
  useHotkeys(bindings);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      <WindowsTitleBar />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside
          data-sidebar-aside
          style={sidebarCollapsed ? { width: 0 } : { width: sidebarWidth }}
          className={cn(
            "relative flex h-full flex-none flex-col border-r border-border bg-sidebar text-sidebar-foreground transition-[width] duration-150",
            sidebarCollapsed && "overflow-hidden border-r-0",
          )}
        >
          {sidebarCollapsed ? null : <Sidebar />}
          {sidebarCollapsed ? null : <SidebarResizer />}
        </aside>
        <main className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
          {/*
           * Frameless 拖拽：WindowsTitleBar / SidebarTopChrome / TabBar / Welcome 空白区。
           * 侧栏收起时展开入口在 AppDockBar 最左；Welcome 自带 drag + 红绿灯安全区（仅 mac）。
           */}
          <TabBar />
          <Workspace />
        </main>
        <AgentSidebar />
      </div>

      <AppDockBar />

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
        onSaved={(fileName, revealToken) => setExportToast({ fileName, revealToken })}
      />
      <TabSwitcher />
      <AiModal />
      {quitting ? (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-background/70 backdrop-blur-sm">
          <div className="flex items-center gap-3 rounded-lg border border-border bg-popover px-5 py-4 text-sm shadow-xl">
            <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden="true" />
            <span>{t("app.quitCheckpoint")}</span>
          </div>
        </div>
      ) : null}
      {exportToast ? (
        <div className="fixed bottom-5 right-5 z-[150] max-w-[min(32rem,calc(100vw-2.5rem))] rounded-lg border border-border bg-popover px-3 py-2 shadow-lg">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 flex-none text-emerald-500" aria-hidden="true" />
            <span className="flex-none text-sm font-medium">{t("common.saved")}</span>
            <button
              type="button"
              onClick={() => void window.stela.export.revealSavedFile(exportToast.revealToken)}
              className="min-w-0 truncate text-left text-sm text-foreground underline decoration-primary underline-offset-2 transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title={exportToast.fileName}
            >
              {exportToast.fileName}
            </button>
            <button
              type="button"
              onClick={() => setExportToast(null)}
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label={t("exportNote.close")}
            >
              ×
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
