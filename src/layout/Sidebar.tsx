import {
  FolderOpen,
  FolderTree,
  Search,
  Database,
  FolderSync,
  History,
  Settings as SettingsIcon,
  Sun,
  Moon,
  Monitor,
  Table as TableIcon,
} from "lucide-react";
import { useWorkspace } from "@/state/workspace";
import { useSettings } from "@/state/settings";
import { useDialogs } from "@/state/dialogs";
import { useLayout } from "@/state/layout";
import type { ThemeMode } from "@/contracts/settings";
import { FilesPanel } from "./FileTree";
import { SearchPanel } from "./SearchPanel";
import { SchemaBrowserPanel } from "./SchemaBrowserPanel";
import { RunHistoryPanel } from "./RunHistoryPanel";
import { GitBadge } from "@/components/git-badge";
import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";
import { formatHotkey } from "@/lib/hotkeys";

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function Sidebar() {
  const t = useT();
  const vaultPath = useWorkspace((s) => s.vaultPath);
  const chooseVault = useWorkspace((s) => s.chooseVault);
  const themeMode = useSettings((s) => s.settings.appearance.theme);
  const patchSettings = useSettings((s) => s.patch);
  const setConnOpen = useDialogs((s) => s.setConnections);
  const setSettingsOpen = useDialogs((s) => s.setSettings);
  const mode = useLayout((s) => s.sidebarMode);
  const setMode = useLayout((s) => s.setSidebarMode);

  const cycleTheme = () => {
    const order: ThemeMode[] = ["light", "dark", "system"];
    const next = order[(order.indexOf(themeMode) + 1) % order.length];
    void patchSettings({ appearance: { theme: next } });
  };

  return (
    <div className="flex h-full flex-col">
      {/*
       * Vault header 同时承担：
       *   1. 显示 vault 名 / 路径 / 切换按钮
       *   2. frameless 窗口的拖拽区（stela-app-drag）
       *   3. macOS 红绿灯安全区（stela-titlebar-safe-left → pl-[78px]）
       * 子元素里所有可点击控件必须显式 stela-app-no-drag，否则点击会被
       * 系统识别为拖窗起手，按下不响应 click。
       */}
      <div className="stela-app-drag stela-titlebar-safe-left flex items-center gap-2 border-b border-border px-3 py-2.5">
        <div className="flex h-6 w-6 flex-none items-center justify-center rounded-md bg-primary text-primary-foreground text-xs font-semibold">
          S
        </div>
        <div className="flex-1 min-w-0">
          <div className="truncate text-sm font-medium">
            {vaultPath ? basename(vaultPath) : t("sidebar.noVault")}
          </div>
          {vaultPath ? (
            <div
              className="truncate text-[11px] text-muted-foreground"
              title={vaultPath}
            >
              {vaultPath}
            </div>
          ) : (
            <div className="text-[11px] text-muted-foreground">
              {t("sidebar.pickFolder")}
            </div>
          )}
        </div>
        {vaultPath ? (
          <div className="stela-app-no-drag flex">
            <GitBadge />
          </div>
        ) : null}
        <button
          type="button"
          onClick={() => void chooseVault()}
          className="stela-app-no-drag rounded-md p-1.5 hover:bg-sidebar-hover transition-colors"
          title={vaultPath ? t("sidebar.changeVault") : t("sidebar.openVault")}
        >
          {vaultPath ? (
            <FolderSync className="h-4 w-4" />
          ) : (
            <FolderOpen className="h-4 w-4" />
          )}
        </button>
      </div>

      {vaultPath ? (
        <div className="flex border-b border-border px-2 py-1">
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

      <div className="border-t border-border px-2 py-1.5">
        <SidebarAction
          icon={<Database className="h-4 w-4" />}
          label={t("sidebar.connections")}
          onClick={() => setConnOpen(true)}
        />
        <SidebarAction
          icon={<SettingsIcon className="h-4 w-4" />}
          label={t("sidebar.settings")}
          hotkey="Mod+,"
          onClick={() => setSettingsOpen(true)}
        />
        <ThemeToggleAction mode={themeMode} onCycle={cycleTheme} />
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
        "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-[12px]",
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

function ThemeToggleAction({
  mode,
  onCycle,
}: {
  mode: ThemeMode;
  onCycle: () => void;
}) {
  const t = useT();
  const Icon = mode === "light" ? Sun : mode === "dark" ? Moon : Monitor;
  const label =
    mode === "light"
      ? t("sidebar.theme.light")
      : mode === "dark"
        ? t("sidebar.theme.dark")
        : t("sidebar.theme.system");
  return (
    <button
      type="button"
      onClick={onCycle}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px]",
        "hover:bg-sidebar-hover",
      )}
      title={t("sidebar.theme.title", { label })}
    >
      <Icon className="h-4 w-4" />
      <span>{label}</span>
    </button>
  );
}

function SidebarAction({
  icon,
  label,
  hotkey,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  /** 快捷键表达式（如 `"Mod+,"`）。会在 title 中按平台显示，并在按钮右侧显示 kbd hint。 */
  hotkey?: string;
  disabled?: boolean;
  onClick?: () => void;
}) {
  const hint = hotkey ? formatHotkey(hotkey) : null;
  const title = disabled
    ? `${label} (M4)`
    : hint
      ? `${label} (${hint})`
      : label;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px]",
        disabled
          ? "cursor-not-allowed text-muted-foreground"
          : "hover:bg-sidebar-hover",
      )}
      title={title}
    >
      {icon}
      <span>{label}</span>
      {disabled ? (
        <span className="ml-auto text-[10px] text-muted-foreground">M4</span>
      ) : hint ? (
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
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
