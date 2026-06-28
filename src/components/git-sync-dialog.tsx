/**
 * Git 同步对话框：提交 + 推送 / 拉取 + 冲突解决。
 *
 * 把 Tolaria 的 CommitDialog / ConflictResolver 收敛成一个轻量对话框：
 *   - 非冲突态：展示变更文件列表 + 提交信息输入 + "提交并同步" / "拉取" 按钮
 *   - 冲突态：逐文件选择「用我的 / 用对方」→ "标记已解决并提交"
 *   - 非 git repo：提示一键 `git init`
 *
 * 所有操作走 [`useGitStore`](../state/git.ts) + `window.stela.git.*`。
 */

import { useCallback, useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertTriangle,
  Check,
  CloudUpload,
  Download,
  GitBranch,
  Loader2,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useGitStore } from "@/state/git";
import { useT } from "@/i18n/use-t";
import type { GitModifiedFile } from "@shared/types";
import { GitPulse } from "./git-pulse";

interface GitSyncDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const STATUS_LABEL: Record<GitModifiedFile["status"], string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "?",
  conflict: "U",
};

const STATUS_COLOR: Record<GitModifiedFile["status"], string> = {
  modified: "text-amber-600",
  added: "text-emerald-600",
  deleted: "text-destructive",
  renamed: "text-primary",
  untracked: "text-muted-foreground",
  conflict: "text-destructive",
};

export function GitSyncDialog({ open, onOpenChange }: GitSyncDialogProps) {
  const t = useT();
  const status = useGitStore((s) => s.status);
  const phase = useGitStore((s) => s.phase);
  const lastError = useGitStore((s) => s.lastError);
  const lastMessage = useGitStore((s) => s.lastMessage);
  const conflicted = useGitStore((s) => s.conflicted);
  const refresh = useGitStore((s) => s.refresh);
  const syncPush = useGitStore((s) => s.syncPush);
  const syncPull = useGitStore((s) => s.syncPull);

  const [message, setMessage] = useState("");
  const [files, setFiles] = useState<GitModifiedFile[]>([]);
  const [conflictFiles, setConflictFiles] = useState<string[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  const [view, setView] = useState<"sync" | "history">("sync");
  const busy = phase === "busy" || phase === "loading";

  const reloadFiles = useCallback(async () => {
    try {
      const [mod, conflicts] = await Promise.all([
        window.stela.git.modifiedFiles(false),
        window.stela.git.conflictFiles(),
      ]);
      setFiles(mod);
      setConflictFiles(conflicts);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setLocalError(null);
    setView("sync");
    void refresh();
    void reloadFiles();
  }, [open, refresh, reloadFiles]);

  const onInit = async () => {
    setLocalError(null);
    try {
      await window.stela.git.initRepo();
      await refresh();
      await reloadFiles();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    }
  };

  const onCommitSync = async () => {
    const r = await syncPush(message.trim() || undefined);
    if (r) {
      setMessage("");
      await reloadFiles();
    }
  };

  const onPull = async () => {
    await syncPull();
    await reloadFiles();
  };

  const onResolve = async (file: string, strategy: "ours" | "theirs") => {
    setLocalError(null);
    try {
      await window.stela.git.resolveConflict(file, strategy);
      await reloadFiles();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    }
  };

  const onFinishConflict = async () => {
    setLocalError(null);
    try {
      await window.stela.git.commitConflictResolution();
      useGitStore.getState().clearConflict();
      await refresh();
      await reloadFiles();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    }
  };

  const err = localError ?? lastError;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[80vh] w-[560px] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-border bg-background shadow-xl"
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <Dialog.Title className="flex items-center gap-2 text-sm font-semibold">
              <GitBranch className="h-4 w-4" />
              {t("git.syncDialog.title")}
              {status.branch ? (
                <span className="text-[11px] font-normal text-muted-foreground">
                  {status.branch}
                </span>
              ) : null}
            </Dialog.Title>
            <Dialog.Close className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>

          {status.isRepo ? (
            <div className="flex gap-1 border-b border-border px-4 py-2">
              {(["sync", "history"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors",
                    view === v
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {v === "sync"
                    ? t("git.syncDialog.tab.sync")
                    : t("git.syncDialog.tab.history")}
                </button>
              ))}
            </div>
          ) : null}

          <div className="flex-1 overflow-y-auto px-4 py-3">
            {status.isRepo && view === "history" ? (
              <GitPulse />
            ) : !status.isRepo ? (
              <div className="space-y-3 text-center">
                <p className="text-[13px] text-muted-foreground">
                  {t("git.syncDialog.notRepo.description")}
                </p>
                <button
                  type="button"
                  onClick={() => void onInit()}
                  disabled={busy}
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-[13px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {t("git.syncDialog.notRepo.init")}
                </button>
              </div>
            ) : conflicted || conflictFiles.length > 0 ? (
              <ConflictSection
                files={conflictFiles}
                busy={busy}
                onResolve={onResolve}
                onFinish={onFinishConflict}
              />
            ) : (
              <CommitSection
                files={files}
                message={message}
                setMessage={setMessage}
                ahead={status.ahead}
                behind={status.behind}
                hasRemote={status.hasRemote}
                busy={busy}
                onCommitSync={onCommitSync}
                onPull={onPull}
              />
            )}

            {err ? (
              <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-none" />
                <span className="break-words">{err}</span>
              </div>
            ) : lastMessage ? (
              <p className="mt-3 text-[11px] text-muted-foreground">
                {lastMessage}
              </p>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function CommitSection(props: {
  files: GitModifiedFile[];
  message: string;
  setMessage: (v: string) => void;
  ahead: number;
  behind: number;
  hasRemote: boolean;
  busy: boolean;
  onCommitSync: () => void;
  onPull: () => void;
}) {
  const t = useT();
  const {
    files,
    message,
    setMessage,
    ahead,
    behind,
    hasRemote,
    busy,
    onCommitSync,
    onPull,
  } = props;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
        <span>{t("git.syncDialog.changedCount", { count: files.length })}</span>
        {hasRemote ? (
          <>
            <span>↑ {ahead}</span>
            <span>↓ {behind}</span>
          </>
        ) : (
          <span className="text-amber-600">
            {t("git.syncDialog.remoteMissing")}
          </span>
        )}
      </div>

      <div className="max-h-44 overflow-y-auto rounded-md border border-border/60">
        {files.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px] text-muted-foreground">
            {t("git.syncDialog.clean")}
          </div>
        ) : (
          <ul className="divide-y divide-border/50">
            {files.map((f) => (
              <li
                key={f.path}
                className="flex items-center gap-2 px-3 py-1.5 text-[12px]"
              >
                <span
                  className={cn(
                    "w-4 flex-none font-mono font-semibold",
                    STATUS_COLOR[f.status],
                  )}
                >
                  {STATUS_LABEL[f.status]}
                </span>
                <span className="truncate" title={f.path}>
                  {f.path}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder={t("git.syncDialog.commitPlaceholder")}
        rows={2}
        className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-ring"
      />

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onPull}
          disabled={busy || !hasRemote}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-[13px] font-medium hover:bg-muted disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          {t("git.syncDialog.pull")}
        </button>
        <button
          type="button"
          onClick={onCommitSync}
          disabled={busy || files.length === 0}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-[13px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <CloudUpload className="h-3.5 w-3.5" />
          )}
          {hasRemote
            ? t("git.syncDialog.commitAndSync")
            : t("git.syncDialog.commit")}
        </button>
      </div>
    </div>
  );
}

function ConflictSection(props: {
  files: string[];
  busy: boolean;
  onResolve: (file: string, strategy: "ours" | "theirs") => void;
  onFinish: () => void;
}) {
  const t = useT();
  const { files, busy, onResolve, onFinish } = props;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-700">
        <AlertTriangle className="h-3.5 w-3.5 flex-none" />
        {t("git.syncDialog.conflict.description")}
      </div>
      <div className="max-h-52 overflow-y-auto rounded-md border border-border/60">
        {files.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px] text-muted-foreground">
            {t("git.syncDialog.conflict.empty")}
          </div>
        ) : (
          <ul className="divide-y divide-border/50">
            {files.map((f) => (
              <li key={f} className="px-3 py-2 text-[12px]">
                <div className="truncate font-medium" title={f}>
                  {f}
                </div>
                <div className="mt-1 flex gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onResolve(f, "ours")}
                    className="rounded border border-border px-2 py-1 text-[11px] hover:bg-muted disabled:opacity-50"
                  >
                    {t("git.syncDialog.conflict.useOurs")}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onResolve(f, "theirs")}
                    className="rounded border border-border px-2 py-1 text-[11px] hover:bg-muted disabled:opacity-50"
                  >
                    {t("git.syncDialog.conflict.useTheirs")}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onFinish}
          disabled={busy || files.length > 0}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-[13px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Check className="h-3.5 w-3.5" />
          )}
          {t("git.syncDialog.conflict.finish")}
        </button>
      </div>
    </div>
  );
}
