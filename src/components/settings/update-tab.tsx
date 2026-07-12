import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Download,
  ExternalLink,
  Loader2,
  RefreshCw,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";

import type { UpdaterState, UpdaterStatus } from "@shared/types";

import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";

import { Row, Section, TabContainer } from "./atoms";

const RELEASES_URL = "https://github.com/ay27/Stela/releases";

function isBusy(status: UpdaterStatus | null): boolean {
  return status?.state === "checking" || status?.state === "downloading";
}

function statusKey(status: UpdaterStatus | null): string {
  if (!status) return "updates.status.loading";
  return `updates.status.${status.state}`;
}

function formatDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatCheckedAt(value: number | null): string | null {
  if (!value) return null;
  return new Date(value).toLocaleString();
}

function showVersionCard(state: UpdaterState | undefined): boolean {
  return state === "available" || state === "downloading" || state === "downloaded";
}

export function UpdateTab() {
  const t = useT();
  const [status, setStatus] = useState<UpdaterStatus | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState<"check" | "download" | "install" | null>(
    null,
  );

  const refresh = async (): Promise<void> => {
    setStatus(await window.stela.updater.getStatus());
  };

  useEffect(() => {
    void refresh().catch((err) => {
      setActionError((err as Error).message);
    });
  }, []);

  // check/download 的 IPC 要等整段结束才返回；中间态只在 main 里变。
  // 进行中轮询 getStatus，才能看到 checking / 下载进度。
  useEffect(() => {
    if (!inFlight && !isBusy(status)) return;
    const id = window.setInterval(() => {
      void refresh().catch((err) => {
        setActionError((err as Error).message);
      });
    }, 400);
    return () => window.clearInterval(id);
  }, [inFlight, status?.state]);

  const releaseDate = useMemo(
    () => formatDate(status?.releaseDate ?? null),
    [status?.releaseDate],
  );
  const lastChecked = useMemo(
    () => formatCheckedAt(status?.lastCheckedAt ?? null),
    [status?.lastCheckedAt],
  );

  const runAction = async (
    kind: "check" | "download" | "install",
    action: () => Promise<UpdaterStatus> | UpdaterStatus,
    optimistic?: UpdaterState,
  ): Promise<void> => {
    setActionError(null);
    setInFlight(kind);
    if (optimistic) {
      setStatus((prev) =>
        prev
          ? {
              ...prev,
              state: optimistic,
              error: null,
              progress: optimistic === "downloading" ? prev.progress : null,
              lastCheckedAt:
                optimistic === "checking" ? Date.now() : prev.lastCheckedAt,
            }
          : prev,
      );
    }
    try {
      setStatus(await action());
    } catch (err) {
      setActionError((err as Error).message);
      try {
        await refresh();
      } catch {
        // keep actionError
      }
    } finally {
      setInFlight(null);
    }
  };

  const progressPercent = status?.progress?.percent ?? 0;
  const busy = Boolean(inFlight) || isBusy(status);
  const canDownload = status?.state === "available" && !busy;
  const canInstall = status?.state === "downloaded" && inFlight !== "install";
  const state = status?.state;

  return (
    <TabContainer>
      <Section
        title={t("updates.title")}
        description={t("updates.description")}
      >
        <Row
          label={t("updates.currentVersion")}
          description={t("updates.currentVersion.description")}
        >
          <span className="rounded-md border border-border bg-muted/40 px-2 py-1 text-xs tabular-nums text-muted-foreground">
            {status?.currentVersion ?? t("updates.unknownVersion")}
          </span>
        </Row>

        <div
          className={cn(
            "rounded-md border px-3 py-2.5",
            state === "error" || actionError
              ? "border-destructive/40 bg-destructive/10"
              : state === "downloaded" || state === "available"
                ? "border-primary/30 bg-primary/5"
                : "border-border/60 bg-card/40",
          )}
        >
          <div className="flex items-start gap-2">
            <StatusIcon state={state} busy={busy} />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-foreground">
                {t("updates.status.title")}
              </div>
              <div
                className={cn(
                  "mt-0.5 text-xs",
                  state === "error" || actionError
                    ? "text-destructive"
                    : "text-muted-foreground",
                )}
              >
                {t(statusKey(status))}
              </div>
              {lastChecked ? (
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {t("updates.lastChecked", { time: lastChecked })}
                </div>
              ) : (
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {t("updates.lastChecked.never")}
                </div>
              )}
            </div>
          </div>
        </div>

        {status?.state === "downloading" ? (
          <div className="rounded-md border border-border/60 bg-card/40 px-3 py-2.5">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{t("updates.downloadProgress")}</span>
              <span className="tabular-nums">{Math.round(progressPercent)}%</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${Math.min(100, Math.max(0, progressPercent))}%` }}
              />
            </div>
          </div>
        ) : null}

        {showVersionCard(state) && status?.version ? (
          <div className="rounded-md border border-border/60 bg-card/40 px-3 py-2.5 text-xs">
            <div className="font-medium text-foreground">
              {t("updates.availableVersion", { version: status.version })}
            </div>
            {releaseDate ? (
              <div className="mt-1 text-muted-foreground">
                {t("updates.releaseDate", { date: releaseDate })}
              </div>
            ) : null}
            {status.releaseNotes ? (
              <p className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap text-muted-foreground">
                {status.releaseNotes}
              </p>
            ) : null}
            <button
              type="button"
              onClick={() => void window.stela.shell.openExternal(RELEASES_URL)}
              className="mt-2 inline-flex items-center gap-1 text-primary hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              {t("updates.openReleaseNotes")}
            </button>
          </div>
        ) : null}

        {status?.error || actionError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {status?.error ?? actionError}
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy || state === "disabled"}
            onClick={() =>
              void runAction(
                "check",
                () => window.stela.updater.checkForUpdates(),
                "checking",
              )
            }
            className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
          >
            {inFlight === "check" || state === "checking" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {t("updates.check")}
          </button>
          <button
            type="button"
            disabled={!canDownload}
            onClick={() =>
              void runAction(
                "download",
                () => window.stela.updater.downloadUpdate(),
                "downloading",
              )
            }
            className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
          >
            {inFlight === "download" || state === "downloading" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            {t("updates.download")}
          </button>
          <button
            type="button"
            disabled={!canInstall}
            onClick={() =>
              void runAction("install", () =>
                window.stela.updater.quitAndInstall(),
              )
            }
            className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {inFlight === "install" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RotateCcw className="h-3.5 w-3.5" />
            )}
            {t("updates.restart")}
          </button>
        </div>
      </Section>
    </TabContainer>
  );
}

function StatusIcon({
  state,
  busy,
}: {
  state: UpdaterState | undefined;
  busy: boolean;
}) {
  if (busy || state === "checking" || state === "downloading") {
    return <Loader2 className="mt-0.5 h-4 w-4 flex-none animate-spin text-primary" />;
  }
  if (state === "error") {
    return <TriangleAlert className="mt-0.5 h-4 w-4 flex-none text-destructive" />;
  }
  if (state === "downloaded" || state === "available" || state === "not-available") {
    return <CheckCircle2 className="mt-0.5 h-4 w-4 flex-none text-primary" />;
  }
  if (state === "disabled") {
    return <TriangleAlert className="mt-0.5 h-4 w-4 flex-none text-amber-600" />;
  }
  return <RefreshCw className="mt-0.5 h-4 w-4 flex-none text-muted-foreground" />;
}
