import { app } from "electron";
import electronUpdater from "electron-updater";

import type { UpdaterStatus } from "../shared/types";

import { createAutoUpdaterService } from "./auto-updater-core";
import { getLogger } from "./logger";

const { autoUpdater } = electronUpdater;

const runtime = createAutoUpdaterService({
  updater: autoUpdater,
  isDev: !!process.env.ELECTRON_RENDERER_URL,
  platform: process.platform,
  version: app.getVersion(),
  logger: getLogger("auto-updater"),
});

export function configure(): void {
  runtime.configure();
}

export function getStatus(): UpdaterStatus {
  return runtime.getStatus();
}

export function checkForUpdates(): Promise<UpdaterStatus> {
  return runtime.checkForUpdates();
}

export function downloadUpdate(): Promise<UpdaterStatus> {
  return runtime.downloadUpdate();
}

export function quitAndInstall(): UpdaterStatus {
  return runtime.quitAndInstall();
}
