import { useEffect, useMemo, useState } from "react";
import { Download, ExternalLink, Loader2, RefreshCw, RotateCcw } from "lucide-react";

import type { UpdaterStatus } from "@shared/types";

import { useT } from "@/i18n/use-t";

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

export function UpdateTab() {
  const t = useT();
  const [status, setStatus] = useState<UpdaterStatus | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    setStatus(await window.stela.updater.getStatus());
  };

  useEffect(() => {
    void refresh().catch((err) => {
      setActionError((err as Error).message);
    });
  }, []);

  useEffect(() => {
    if (!isBusy(status)) return;
    const id = window.setInterval(() => {
      void refresh().catch((err) => {
        setActionError((err as Error).message);
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [status?.state]);

  const releaseDate = useMemo(
    () => formatDate(status?.releaseDate ?? null),
    [status?.releaseDate],
  );

  const runAction = async (
    action: () => Promise<UpdaterStatus> | UpdaterStatus,
  ): Promise<void> => {
    setActionError(null);
    try {
      setStatus(await action());
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  const progressPercent = status?.progress?.percent ?? 0;
  const busy = isBusy(status);
  const canDownload = status?.state === "available";
  const canInstall = status?.state === "downloaded";

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

        <Row label={t("updates.status.title")}>
          <span className="text-xs text-muted-foreground">
            {t(statusKey(status))}
          </span>
        </Row>

        {status?.state === "downloading" ? (
          <div className="rounded-md border border-border/60 bg-card/40 px-3 py-2.5">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{t("updates.downloadProgress")}</span>
              <span>{Math.round(progressPercent)}%</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${Math.min(100, Math.max(0, progressPercent))}%` }}
              />
            </div>
          </div>
        ) : null}

        {status?.version ? (
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
            disabled={busy}
            onClick={() =>
              void runAction(() => window.stela.updater.checkForUpdates())
            }
            className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
          >
            {status?.state === "checking" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {t("updates.check")}
          </button>
          <button
            type="button"
            disabled={!canDownload || busy}
            onClick={() =>
              void runAction(() => window.stela.updater.downloadUpdate())
            }
            className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Download className="h-3.5 w-3.5" />
            {t("updates.download")}
          </button>
          <button
            type="button"
            disabled={!canInstall}
            onClick={() =>
              void runAction(() => window.stela.updater.quitAndInstall())
            }
            className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {t("updates.restart")}
          </button>
        </div>
      </Section>
    </TabContainer>
  );
}
