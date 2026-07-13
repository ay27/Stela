import type { UpdaterProgress, UpdaterStatus } from "../shared/types";

interface UpdateInfoLike {
  version?: string;
  releaseDate?: string;
  releaseNotes?: unknown;
}

interface ProgressInfoLike {
  percent?: number;
  bytesPerSecond?: number;
  transferred?: number;
  total?: number;
}

export interface UpdaterLike {
  autoDownload: boolean;
  checkForUpdates: () => Promise<unknown>;
  downloadUpdate: () => Promise<unknown>;
  quitAndInstall: () => void;
  on: (event: string, cb: (...args: unknown[]) => void) => void;
}

interface LoggerLike {
  info: (message: string, meta?: unknown) => void;
  warn: (message: string, meta?: unknown) => void;
  error: (message: string, meta?: unknown) => void;
}

export interface AutoUpdaterServiceOptions {
  updater: UpdaterLike;
  isDev: boolean;
  platform: NodeJS.Platform;
  version: string;
  logger: LoggerLike;
}

const AUTO_UPDATE_PLATFORMS = new Set<NodeJS.Platform>(["darwin", "win32"]);

const DISABLED_MESSAGE =
  "Auto update is only available in packaged macOS and Windows builds";

function isAutoUpdatePlatform(platform: NodeJS.Platform): boolean {
  return AUTO_UPDATE_PLATFORMS.has(platform);
}

function releaseNotesText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "note" in item) {
          const note = (item as { note?: unknown }).note;
          return typeof note === "string" ? note : "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n\n");
  }
  return null;
}

function statusFromInfo(
  current: UpdaterStatus,
  info: UpdateInfoLike,
): UpdaterStatus {
  return {
    ...current,
    version: info.version ?? null,
    releaseDate: info.releaseDate ?? null,
    releaseNotes: releaseNotesText(info.releaseNotes),
    progress: null,
    error: null,
  };
}

export function createAutoUpdaterService(opts: AutoUpdaterServiceOptions) {
  let configured = false;
  let status: UpdaterStatus = {
    state: opts.isDev || !isAutoUpdatePlatform(opts.platform) ? "disabled" : "idle",
    currentVersion: opts.version,
    version: null,
    releaseDate: null,
    releaseNotes: null,
    progress: null,
    lastCheckedAt: null,
    error: opts.isDev || !isAutoUpdatePlatform(opts.platform) ? DISABLED_MESSAGE : null,
  };

  const isEnabled = () => !opts.isDev && isAutoUpdatePlatform(opts.platform);

  const setError = (err: unknown): void => {
    const message = err instanceof Error ? err.message : String(err);
    status = { ...status, state: "error", error: message };
    opts.logger.error("auto update failed", { err: message });
  };

  const configure = (): void => {
    if (configured) return;
    configured = true;
    opts.updater.autoDownload = false;

    opts.updater.on("checking-for-update", () => {
      status = { ...status, state: "checking", error: null };
    });
    opts.updater.on("update-available", (info) => {
      status = {
        ...statusFromInfo(status, info as UpdateInfoLike),
        state: "available",
      };
      opts.logger.info("update available", { version: status.version });
    });
    opts.updater.on("update-not-available", (info) => {
      status = {
        ...statusFromInfo(status, info as UpdateInfoLike),
        state: "not-available",
      };
      opts.logger.info("update not available", { version: status.version });
    });
    opts.updater.on("download-progress", (progress) => {
      const p = progress as ProgressInfoLike;
      const next: UpdaterProgress = {
        percent: p.percent ?? 0,
        bytesPerSecond: p.bytesPerSecond ?? 0,
      };
      if (p.transferred !== undefined) next.transferred = p.transferred;
      if (p.total !== undefined) next.total = p.total;
      status = { ...status, state: "downloading", progress: next };
    });
    opts.updater.on("update-downloaded", (info) => {
      status = {
        ...statusFromInfo(status, info as UpdateInfoLike),
        state: "downloaded",
        progress: null,
      };
      opts.logger.info("update downloaded", { version: status.version });
    });
    opts.updater.on("error", setError);
  };

  const disabledStatus = (): UpdaterStatus => {
    status = { ...status, state: "disabled", error: DISABLED_MESSAGE };
    return status;
  };

  return {
    configure,
    getStatus: (): UpdaterStatus => status,
    checkForUpdates: async (): Promise<UpdaterStatus> => {
      configure();
      if (!isEnabled()) return disabledStatus();
      status = {
        ...status,
        state: "checking",
        lastCheckedAt: Date.now(),
        error: null,
      };
      try {
        await opts.updater.checkForUpdates();
      } catch (err) {
        setError(err);
      }
      return status;
    },
    downloadUpdate: async (): Promise<UpdaterStatus> => {
      configure();
      if (!isEnabled()) return disabledStatus();
      status = { ...status, state: "downloading", progress: null, error: null };
      try {
        await opts.updater.downloadUpdate();
      } catch (err) {
        setError(err);
      }
      return status;
    },
    quitAndInstall: (): UpdaterStatus => {
      configure();
      if (!isEnabled()) return disabledStatus();
      opts.updater.quitAndInstall();
      return status;
    },
  };
}
