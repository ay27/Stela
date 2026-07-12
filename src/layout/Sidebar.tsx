import {
  FolderOpen,
  FolderTree,
  Search,
  History,
  Table as TableIcon,
} from "lucide-react";
import { useWorkspace } from "@/state/workspace";
import { useLayout } from "@/state/layout";
import { FilesPanel } from "./FileTree";
import { SearchPanel } from "./SearchPanel";
import { SchemaBrowserPanel } from "./SchemaBrowserPanel";
import { RunHistoryPanel } from "./RunHistoryPanel";
import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";
import { formatHotkey } from "@/lib/hotkeys";

/**
 * 左侧栏：顶栏 / 模式 / 面板。底部应用级 chrome 见 [AppDockBar]。
 */
export function Sidebar() {
  const t = useT();
  const vaultPath = useWorkspace((s) => s.vaultPath);
  const chooseVault = useWorkspace((s) => s.chooseVault);
  const mode = useLayout((s) => s.sidebarMode);
  const setMode = useLayout((s) => s.setSidebarMode);

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      {/*
       * SidebarTopChrome：纯留白顶栏。
       *   - frameless 窗口拖拽区（stela-app-drag）
       *   - macOS 红绿灯安全区（stela-titlebar-safe-left → pl-[78px]）
       */}
      <div className="stela-app-drag stela-titlebar-safe-left h-9 flex-none border-b border-border" />

      {vaultPath ? (
        <div className="flex h-8 flex-none items-center border-b border-border px-2">
          <div className="flex min-w-0 flex-1">
            <ModeButton
              label={t("sidebar.files")}
              icon={<FolderTree className="h-3.5 w-3.5" />}
              active={mode === "files"}
              onClick={() => setMode("files")}
            />
            <ModeButton
              label={t("sidebar.search")}
              icon={<Search className="h-3.5 w-3.5" />}
              active={mode === "search"}
              hotkey="Mod+Shift+F"
              iconOnly
              onClick={() => setMode("search")}
            />
            <ModeButton
              label={t("sidebar.schema")}
              icon={<TableIcon className="h-3.5 w-3.5" />}
              active={mode === "schema"}
              iconOnly
              onClick={() => setMode("schema")}
            />
            <ModeButton
              label={t("sidebar.runs")}
              icon={<History className="h-3.5 w-3.5" />}
              active={mode === "runs"}
              iconOnly
              onClick={() => setMode("runs")}
            />
          </div>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-hidden">
        {vaultPath ? (
          mode === "files" ? (
            <FilesPanel rootPath={vaultPath} />
          ) : mode === "search" ? (
            <SearchPanel vaultPath={vaultPath} />
          ) : mode === "schema" ? (
            <SchemaBrowserPanel />
          ) : (
            <RunHistoryPanel />
          )
        ) : (
          <EmptyState onPick={() => void chooseVault()} />
        )}
      </div>
    </div>
  );
}

function ModeButton({
  label,
  icon,
  active,
  hotkey,
  iconOnly,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  hotkey?: string;
  /** true 时只渲染图标，label 通过 title hover 显示。用于超出 2 个按钮时省空间。 */
  iconOnly?: boolean;
  onClick: () => void;
}) {
  const hint = hotkey ? formatHotkey(hotkey) : null;
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint ? `${label} (${hint})` : label}
      className={cn(
        "flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md px-2 text-[12px]",
        active
          ? "bg-sidebar-hover text-foreground font-medium"
          : "text-muted-foreground hover:bg-sidebar-hover/60",
      )}
    >
      {icon}
      {!iconOnly ? <span>{label}</span> : null}
      {hint && !iconOnly ? (
        <span
          className="font-mono text-[10px] text-muted-foreground"
          aria-hidden
        >
          {hint}
        </span>
      ) : null}
    </button>
  );
}

function EmptyState({ onPick }: { onPick: () => void }) {
  const t = useT();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <FolderOpen className="h-10 w-10 text-muted-foreground" />
      <div className="text-sm text-muted-foreground">
        {t("sidebar.empty")}
      </div>
      <button
        type="button"
        onClick={onPick}
        className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
      >
        {t("welcome.openVault")}
      </button>
    </div>
  );
}
