/**
 * Sidebar 仓库头上的 Git 状态徽章（替代旧的 SyncBadge）。
 *
 * 一眼传达"当前 vault 的 Git 状态"，点击打开 [`GitSyncDialog`](./git-sync-dialog.tsx)
 * 做提交 / 推送 / 拉取 / 冲突解决：
 *   - Git 未启用：灰色分叉图标，点击打开 Settings → Git
 *   - 非 repo：灰色分叉，点击打开同步对话框（内含一键 init）
 *   - 干净：低调分叉
 *   - 有变更：分叉 + 变更数 badge
 *   - ahead/behind：箭头提示需要 push / pull
 *   - 冲突：amber 警告
 *   - busy：旋转
 */

import { useEffect, useState } from "react";
import { AlertTriangle, GitBranch, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { useDialogs } from "@/state/dialogs";
import { useSettings } from "@/state/settings";
import { useGitStore } from "@/state/git";
import { useAutoGit } from "@/services/auto-git";
import { useT } from "@/i18n/use-t";
import { GitSyncDialog } from "./git-sync-dialog";

export function GitBadge() {
  const t = useT();
  const gitEnabled = useSettings((s) => s.settings.git.enabled);
  const status = useGitStore((s) => s.status);
  const phase = useGitStore((s) => s.phase);
  const refresh = useGitStore((s) => s.refresh);
  const autoPhase = useAutoGit((s) => s.phase);
  const setSettingsOpen = useDialogs((s) => s.setSettings);
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    if (gitEnabled) void refresh();
  }, [gitEnabled, refresh]);

  if (!gitEnabled) {
    return (
      <button
        type="button"
        onClick={() => setSettingsOpen(true)}
        title={t("git.badge.disabledTitle")}
        aria-label={t("git.badge.disabledLabel")}
        className="rounded-md p-1.5 text-muted-foreground/60 transition-colors hover:bg-sidebar-hover hover:text-muted-foreground"
      >
        <GitBranch className="h-4 w-4" />
      </button>
    );
  }

  const busy = phase === "busy" || autoPhase === "committing";
  const conflict = status.conflictCount > 0;
  const dirty = status.changedCount > 0;
  const needsSync = status.ahead > 0 || status.behind > 0;

  let icon: React.ReactNode = <GitBranch className="h-4 w-4" />;
  let color = "text-muted-foreground hover:text-foreground";
  let title = status.isRepo
    ? t("git.badge.cleanTitle")
    : t("git.badge.notRepoTitle");

  if (busy) {
    icon = <Loader2 className="h-4 w-4 animate-spin" />;
    color = "text-primary";
    title = t("git.badge.busyTitle");
  } else if (conflict) {
    icon = <AlertTriangle className="h-4 w-4" />;
    color = "text-amber-600 hover:text-amber-700";
    title = t("git.badge.conflictTitle", { count: status.conflictCount });
  } else if (dirty || needsSync) {
    color = "text-primary/80 hover:text-primary";
    title = t("git.badge.syncTitle", {
      changed: status.changedCount,
      ahead: status.ahead,
      behind: status.behind,
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setDialogOpen(true)}
        title={title}
        aria-label={title}
        className={cn(
          "relative rounded-md p-1.5 transition-colors hover:bg-sidebar-hover",
          color,
        )}
        data-git-phase={busy ? "busy" : conflict ? "conflict" : dirty ? "dirty" : "clean"}
      >
        {icon}
        {!busy && (dirty || needsSync) && !conflict ? (
          <span className="absolute -right-0.5 -top-0.5 flex h-2 w-2 rounded-full bg-primary" />
        ) : null}
      </button>
      <GitSyncDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  );
}
