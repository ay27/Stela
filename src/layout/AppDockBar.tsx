/**
 * App 级全宽常驻 DockBar。
 *
 * 不属于文件树：Welcome / 侧栏收起 / AgentPanel 展开时都在。
 * 分区：
 *   左 — 按内容自然撑开：侧栏开关 | Settings | Vault | Git(分支)
 *   中 — 文档状态：有 file tab 时从左显示静态「反向链接(N)」
 *   右 — 版本号（有更新时蓝点）+ Agent 占位
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { FolderSync, Link2, Settings as SettingsIcon, Tag } from "lucide-react";

import type { UpdaterStatus } from "@shared/types";

import { GitBadge } from "@/components/git-badge";
import { useT } from "@/i18n/use-t";
import { formatHotkey } from "@/lib/hotkeys";
import { useDialogs } from "@/state/dialogs";
import { useLayout } from "@/state/layout";
import { useWorkspace } from "@/state/workspace";
import { SidebarToggleButton } from "./SidebarToggleButton";

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** 文字高度竖线，不顶满 Dock 上下边 */
function DockSep() {
  return <span className="mx-1 h-3 w-px flex-none self-center bg-border" aria-hidden />;
}

const dockItem =
  "inline-flex flex-none items-center gap-1 rounded-sm px-2 hover:bg-accent hover:text-foreground";

function updateAvailable(status: UpdaterStatus | null): boolean {
  return status?.state === "available" || status?.state === "downloaded";
}

export function AppDockBar() {
  const t = useT();
  const vaultPath = useWorkspace((s) => s.vaultPath);
  const chooseVault = useWorkspace((s) => s.chooseVault);
  const tabs = useWorkspace((s) => s.tabs);
  const activeTabId = useWorkspace((s) => s.activeTabId);
  const sidebarCollapsed = useLayout((s) => s.sidebarCollapsed);
  const agentPanelCollapsed = useLayout((s) => s.agentPanelCollapsed);
  const agentPanelWidth = useLayout((s) => s.agentPanelWidth);
  const setSettingsOpen = useDialogs((s) => s.setSettings);
  const settingsHint = formatHotkey("Mod+,");

  const active = activeTabId ? tabs.find((tab) => tab.id === activeTabId) : undefined;
  const activeFilePath =
    active?.kind === "file" && active.path ? active.path : null;

  return (
    <div className="box-border flex h-8 flex-none items-center border-t border-border bg-muted/30 text-[12px] font-medium text-muted-foreground px-1.5">
      {/* 左侧控制组：宽度跟内容走，禁止 overflow 裁切 */}
      <div className="flex h-full flex-none items-center overflow-visible">
        <SidebarToggleButton
          collapsed={sidebarCollapsed}
          className={dockItem}
        />
        <DockSep />
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className={dockItem}
          title={`${t("sidebar.settings")} (${settingsHint})`}
        >
          <SettingsIcon className="h-3.5 w-3.5 flex-none" />
          <span className="whitespace-nowrap">{t("sidebar.settings")}</span>
        </button>
        <DockSep />
        <button
          type="button"
          onClick={() => void chooseVault()}
          className={`${dockItem} max-w-[180px]`}
          title={vaultPath ? t("sidebar.changeVault") : t("sidebar.openVault")}
        >
          <FolderSync className="h-3.5 w-3.5 flex-none" />
          <span className="truncate">
            {vaultPath ? basename(vaultPath) : t("sidebar.noVault")}
          </span>
        </button>
        {vaultPath ? (
          <>
            <DockSep />
            <GitBadge showBranch className={`${dockItem} max-w-[120px]`} />
          </>
        ) : null}
      </div>

      <DockSep />

      <div className="flex h-full min-w-0 flex-1 items-center overflow-hidden">
        {activeFilePath ? <BacklinkStatus path={activeFilePath} /> : null}
      </div>

      {!agentPanelCollapsed ? (
        <div className="h-full flex-none" style={{ width: agentPanelWidth }} />
      ) : null}

<DockSep />
      <VersionBadge />
    </div>
  );
}

/** Dock 最右：当前版本；有更新时小蓝点（对齐 GitBadge） */
function VersionBadge() {
  const t = useT();
  const setSettings = useDialogs((s) => s.setSettings);
  const [status, setStatus] = useState<UpdaterStatus | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !window.stela?.updater) return;
    let cancelled = false;
    let slowId: number | null = null;
    const refresh = async () => {
      try {
        const next = await window.stela.updater.getStatus();
        if (!cancelled) setStatus(next);
      } catch {
        // keep last known
      }
    };
    void refresh();
    // 启动检查约 10s；前 20s 密轮询，之后 30s 一次
    const fast = window.setInterval(() => void refresh(), 3_000);
    const slowDelay = window.setTimeout(() => {
      window.clearInterval(fast);
      if (cancelled) return;
      slowId = window.setInterval(() => void refresh(), 30_000);
    }, 20_000);
    return () => {
      cancelled = true;
      window.clearInterval(fast);
      window.clearTimeout(slowDelay);
      if (slowId !== null) window.clearInterval(slowId);
    };
  }, []);

  const version = status?.currentVersion?.trim() || t("updates.unknownVersion");
  const hasUpdate = updateAvailable(status);
  const title = hasUpdate
    ? t("dock.version.updateAvailable", { version })
    : t("dock.version.title", { version });

  return (
    <button
      type="button"
      onClick={() => setSettings(true, "updates")}
      className={`${dockItem} pr-2`}
      title={title}
      aria-label={title}
    >
      <Tag className="h-3.5 w-3.5 flex-none" />
      <span className="whitespace-nowrap tabular-nums">{version}</span>
      {hasUpdate ? (
        <span className="h-1.5 w-1.5 flex-none rounded-full bg-primary" />
      ) : null}
    </button>
  );
}

function BacklinkStatus({ path }: { path: string }) {
  const t = useT();
  const vaultPath = useWorkspace((s) => s.vaultPath);
  const [count, setCount] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const reqIdRef = useRef(0);

  const target = useMemo(() => {
    if (!vaultPath) return path;
    const norm = (p: string) => p.replace(/\\/g, "/");
    const v = norm(vaultPath).replace(/\/$/, "");
    const p = norm(path);
    const rel = p.startsWith(`${v}/`) ? p.slice(v.length + 1) : p;
    return rel.replace(/\.(md|mdstela)$/i, "");
  }, [path, vaultPath]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.stela?.index) return;
    let cancelled = false;
    const fetchBacklinks = async () => {
      const reqId = ++reqIdRef.current;
      try {
        const result = await window.stela.index.getBacklinks(target);
        if (cancelled || reqIdRef.current !== reqId) return;
        setCount(result.length);
        setFailed(false);
      } catch {
        if (cancelled || reqIdRef.current !== reqId) return;
        setCount(null);
        setFailed(true);
      }
    };
    setCount(null);
    setFailed(false);
    void fetchBacklinks();
    const unsub = window.stela.index.onChanged(() => {
      void fetchBacklinks();
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [target]);

  const label =
    failed ? "—" : count === null ? "…" : String(count);

  return (
    <div className="inline-flex items-center gap-1 rounded-sm px-2 select-none">
      <Link2 className="h-3.5 w-3.5 flex-none" />
      <span className="whitespace-nowrap">
        {t("backlinks.title")}({label})
      </span>
    </div>
  );
}
