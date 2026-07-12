import { useCallback, useMemo } from "react";
import {
  Database,
  FileText,
  FolderOpen,
  KeyRound,
  NotebookPen,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";

import { useWorkspace } from "@/state/workspace";
import { useDialogs } from "@/state/dialogs";
import { useLayout } from "@/state/layout";
import { useSettings } from "@/state/settings";
import { createNewStelaNote } from "@/services/note-actions";
import { seedDemoVault } from "@/services/demo-vault";
import { pathExists } from "@/services/fs";
import { useT } from "@/i18n/use-t";
import { formatHotkey } from "@/lib/hotkeys";
import { cn } from "@/lib/utils";

const NEW_NOTE_HINT = formatHotkey("Mod+N");
const PALETTE_HINT = formatHotkey("Mod+K");
const SETTINGS_HINT = formatHotkey("Mod+,");

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function dirname(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (idx <= 0) return p;
  return p.slice(0, idx);
}

function relativeToVault(filePath: string, vaultPath: string): string {
  if (!vaultPath) return filePath;
  if (filePath === vaultPath) return basename(filePath);
  if (filePath.startsWith(vaultPath)) {
    return filePath.slice(vaultPath.length).replace(/^[\\/]+/, "");
  }
  return filePath;
}

function formatRelativeTime(
  ts: number,
  t: ReturnType<typeof useT>,
): string {
  const diffMs = Date.now() - ts;
  if (diffMs < 60_000) return t("welcome.time.justNow");
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return t("welcome.time.minutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("welcome.time.hours", { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t("welcome.time.days", { count: days });
  const months = Math.floor(days / 30);
  if (months < 12) return t("welcome.time.months", { count: months });
  const years = Math.floor(days / 365);
  return t("welcome.time.years", { count: years });
}

export function WelcomeView() {
  const t = useT();
  const vaultPath = useWorkspace((s) => s.vaultPath);
  const chooseVault = useWorkspace((s) => s.chooseVault);
  const openVaultByPath = useWorkspace((s) => s.openVaultByPath);
  const openFile = useWorkspace((s) => s.openFile);

  const setConnectionsOpen = useDialogs((s) => s.setConnections);
  const setSettingsOpen = useDialogs((s) => s.setSettings);
  const togglePalette = useDialogs((s) => s.togglePalette);
  const sidebarCollapsed = useLayout((s) => s.sidebarCollapsed);

  // recentVaults / lastVault 走 user-cache（跨 vault）；recentFiles 走 local 文件
  const recentVaultsAll = useSettings((s) => s.recentVaults);
  const recentFiles = useSettings((s) => s.settings.vault.recentFiles);
  const removeRecentVault = useSettings((s) => s.removeRecentVault);
  const removeRecentFile = useSettings((s) => s.removeRecentFile);

  const recentVaults = useMemo(
    () => recentVaultsAll.filter((p) => p !== vaultPath),
    [recentVaultsAll, vaultPath],
  );

  // recentFiles 已隐含归属当前 vault（持久化在 {vault}/.stela/recent-files.local.json）
  const recentFilesInVault = vaultPath ? recentFiles : [];

  const onOpenRecentFile = useCallback(
    async (path: string) => {
      const exists = await pathExists(path).catch(() => false);
      if (!exists) {
        await removeRecentFile(path);
        window.alert(t("welcome.fileMissing", { path }));
        return;
      }
      openFile(path);
    },
    [openFile, removeRecentFile],
  );

  const onTryDemoVault = useCallback(async () => {
    try {
      const parent = await window.stela.dialog.pickDirectory({
        title: t("welcome.demo.pickParent"),
      });
      if (!parent) return;
      const target = await seedDemoVault(parent);
      await openVaultByPath(target);
    } catch (err) {
      console.error("[stela] seedDemoVault failed", err);
      window.alert(
        t("welcome.demo.failed", {
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }, [openVaultByPath, t]);

  return (
    // 不要把 stela-app-drag 放在 overflow-auto 容器上：Electron 在「可滚动
    // drag region」滚到底后 hit-test 会坏掉，整页点不了（侧栏/DockBar 不在
    // 该区域内所以仍可点）。拖窗只放在不可滚动的顶条；内容区正常滚动点击。
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-background">
      {sidebarCollapsed ? (
        <div
          className="stela-app-drag stela-titlebar-safe-left absolute inset-x-0 top-0 z-10 h-9"
          aria-hidden
        />
      ) : null}
      <div
        className={cn(
          "min-h-0 flex-1 overflow-auto px-10 py-10",
          sidebarCollapsed && "pt-12",
        )}
      >
        <div className="mx-auto w-full max-w-3xl">
        <header className="mb-8 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-lg font-bold text-primary-foreground">
            S
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {t("welcome.title")}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t("welcome.slogan")}
            </p>
          </div>
        </header>

        <VaultCard
          vaultPath={vaultPath}
          onChange={() => void chooseVault()}
          onTryDemo={() => void onTryDemoVault()}
        />

        <QuickActions
          vaultPath={vaultPath}
          onNewNote={() => void createNewStelaNote(vaultPath)}
          onOpenConnections={() => setConnectionsOpen(true)}
          onOpenPalette={() => togglePalette()}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        {recentFilesInVault.length > 0 ? (
          <Section title={t("welcome.recentFiles")} icon={<FileText className="h-3.5 w-3.5" />}>
            <ul className="divide-y divide-border/60 rounded-lg border border-border">
              {recentFilesInVault.map((f) => (
                <li key={f.path}>
                  <RecentFileRow
                    name={basename(f.path)}
                    rel={relativeToVault(f.path, vaultPath ?? "")}
                    openedAt={f.openedAt}
                    onOpen={() => void onOpenRecentFile(f.path)}
                    onRemove={() => void removeRecentFile(f.path)}
                  />
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        {recentVaults.length > 0 ? (
          <Section title={t("welcome.recentVaults")} icon={<FolderOpen className="h-3.5 w-3.5" />}>
            <ul className="divide-y divide-border/60 rounded-lg border border-border">
              {recentVaults.map((p) => (
                <li key={p}>
                  <RecentVaultRow
                    name={basename(p)}
                    parent={dirname(p)}
                    onOpen={() => void openVaultByPath(p)}
                    onRemove={() => void removeRecentVault(p)}
                  />
                </li>
              ))}
            </ul>
          </Section>
        ) : null}
      </div>
      </div>
    </div>
  );
}

function VaultCard({
  vaultPath,
  onChange,
  onTryDemo,
}: {
  vaultPath: string | null;
  onChange: () => void;
  onTryDemo: () => void;
}) {
  const t = useT();
  if (vaultPath) {
    return (
      <div className="mb-6 flex items-center justify-between gap-3 rounded-xl border border-border bg-muted/30 p-4">
        <div className="min-w-0">
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {t("welcome.currentVault")}
          </div>
          <div
            className="mt-0.5 truncate font-mono text-[13px]"
            title={vaultPath}
          >
            {vaultPath}
          </div>
        </div>
        <button
          type="button"
          onClick={onChange}
          className="flex-none rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent"
        >
          {t("welcome.switchVault")}
        </button>
      </div>
    );
  }
  return (
    <div className="mb-6 rounded-xl border border-primary/30 bg-primary/5 p-4">
      <div className="flex items-start gap-3">
        <Sparkles className="mt-0.5 h-4 w-4 flex-none text-primary" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{t("welcome.noVault.title")}</div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("welcome.noVault.description")}
          </p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onChange}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
        >
          <FolderOpen className="h-3.5 w-3.5" />
          {t("welcome.openVault")}
        </button>
        <button
          type="button"
          onClick={onTryDemo}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent"
        >
          <Sparkles className="h-3.5 w-3.5" />
          {t("welcome.tryDemo")}
        </button>
      </div>
    </div>
  );
}

function QuickActions({
  vaultPath,
  onNewNote,
  onOpenConnections,
  onOpenPalette,
  onOpenSettings,
}: {
  vaultPath: string | null;
  onNewNote: () => void;
  onOpenConnections: () => void;
  onOpenPalette: () => void;
  onOpenSettings: () => void;
}) {
  const t = useT();
  return (
    <Section title={t("welcome.quickActions")} icon={<KeyRound className="h-3.5 w-3.5" />}>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <ActionTile
          icon={<NotebookPen className="h-4 w-4" />}
          label={t("welcome.newNote")}
          hint={vaultPath ? NEW_NOTE_HINT : t("welcome.needVault")}
          onClick={onNewNote}
          disabled={!vaultPath}
        />
        <ActionTile
          icon={<Database className="h-4 w-4" />}
          label={t("welcome.connections")}
          hint={t("welcome.connectionsHint")}
          onClick={onOpenConnections}
        />
        <ActionTile
          icon={<Search className="h-4 w-4" />}
          label={t("welcome.commandPalette")}
          hint={PALETTE_HINT}
          onClick={onOpenPalette}
        />
        <ActionTile
          icon={<SettingsIcon className="h-4 w-4" />}
          label={t("welcome.settings")}
          hint={SETTINGS_HINT}
          onClick={onOpenSettings}
        />
      </div>
    </Section>
  );
}

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-6">
      <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

function ActionTile({
  icon,
  label,
  hint,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "group flex items-center gap-3 rounded-lg border border-border bg-background px-3 py-2.5 text-left transition-colors",
        disabled
          ? "cursor-not-allowed opacity-60"
          : "hover:border-primary/40 hover:bg-accent",
      )}
    >
      <div
        className={cn(
          "flex h-8 w-8 flex-none items-center justify-center rounded-md bg-muted text-muted-foreground",
          !disabled && "group-hover:bg-primary/10 group-hover:text-primary",
        )}
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{label}</div>
        {hint ? (
          <div className="truncate text-[11px] text-muted-foreground">
            {hint}
          </div>
        ) : null}
      </div>
    </button>
  );
}

function RecentFileRow({
  name,
  rel,
  openedAt,
  onOpen,
  onRemove,
}: {
  name: string;
  rel: string;
  openedAt: number;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  return (
    <div className="group flex items-center gap-2 px-3 py-2 hover:bg-accent/50">
      <FileText className="h-3.5 w-3.5 flex-none text-muted-foreground" />
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <span className="truncate text-[13px] font-medium">{name}</span>
        <span className="truncate text-[11px] text-muted-foreground" title={rel}>
          {rel === name ? "" : rel}
        </span>
      </button>
      <span className="flex-none text-[10px] text-muted-foreground">
        {formatRelativeTime(openedAt, t)}
      </span>
      <button
        type="button"
        onClick={onRemove}
        title={t("welcome.removeRecent")}
        className="flex h-5 w-5 flex-none items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function RecentVaultRow({
  name,
  parent,
  onOpen,
  onRemove,
}: {
  name: string;
  parent: string;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  return (
    <div className="group flex items-center gap-2 px-3 py-2 hover:bg-accent/50">
      <FolderOpen className="h-3.5 w-3.5 flex-none text-muted-foreground" />
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <span className="truncate text-[13px] font-medium">{name}</span>
        <span
          className="truncate font-mono text-[11px] text-muted-foreground"
          title={parent}
        >
          {parent}
        </span>
      </button>
      <button
        type="button"
        onClick={onRemove}
        title={t("welcome.removeRecent")}
        className="flex h-5 w-5 flex-none items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}
