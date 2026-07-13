import { createAutoUpdaterService } from "./auto-updater-core";

interface FakeUpdater {
  autoDownload: boolean;
  checkForUpdates: () => Promise<void>;
  downloadUpdate: () => Promise<void>;
  quitAndInstall: () => void;
  on: (event: string, cb: (...args: unknown[]) => void) => void;
}

function assert(name: string, ok: boolean, detail = ""): void {
  if (!ok) {
    console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS  ${name}${detail ? ` - ${detail}` : ""}`);
}

function makeFakeUpdater(): FakeUpdater & {
  emit: (event: string, ...args: unknown[]) => void;
  calls: string[];
} {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const calls: string[] = [];
  return {
    autoDownload: true,
    calls,
    on: (event, cb) => {
      listeners.set(event, [...(listeners.get(event) ?? []), cb]);
    },
    emit: (event, ...args) => {
      for (const cb of listeners.get(event) ?? []) cb(...args);
    },
    checkForUpdates: async () => {
      calls.push("check");
    },
    downloadUpdate: async () => {
      calls.push("download");
    },
    quitAndInstall: () => {
      calls.push("quit");
    },
  };
}

async function main(): Promise<void> {
  const updater = makeFakeUpdater();
  const service = createAutoUpdaterService({
    updater,
    isDev: false,
    platform: "darwin",
    version: "0.6.0",
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  service.configure();
  assert("configure disables autoDownload", updater.autoDownload === false);

  await service.checkForUpdates();
  assert("checkForUpdates delegates to updater", updater.calls.includes("check"));
  assert("status moves to checking", service.getStatus().state === "checking");

  updater.emit("update-available", {
    version: "0.6.1",
    releaseNotes: "Bug fixes",
    releaseDate: "2026-06-28T00:00:00.000Z",
  });
  assert("available state recorded", service.getStatus().state === "available");
  assert("available version recorded", service.getStatus().version === "0.6.1");

  await service.downloadUpdate();
  assert("downloadUpdate delegates to updater", updater.calls.includes("download"));
  assert("status moves to downloading", service.getStatus().state === "downloading");

  updater.emit("download-progress", { percent: 42.5, bytesPerSecond: 1024 });
  assert("download progress recorded", service.getStatus().progress?.percent === 42.5);

  updater.emit("update-downloaded", { version: "0.6.1" });
  assert("downloaded state recorded", service.getStatus().state === "downloaded");

  service.quitAndInstall();
  assert("quitAndInstall delegates to updater", updater.calls.includes("quit"));

  const dev = createAutoUpdaterService({
    updater: makeFakeUpdater(),
    isDev: true,
    platform: "darwin",
    version: "0.6.0",
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  await dev.checkForUpdates();
  assert("dev check is disabled", dev.getStatus().state === "disabled");

  const linux = createAutoUpdaterService({
    updater: makeFakeUpdater(),
    isDev: false,
    platform: "linux",
    version: "0.6.0",
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  await linux.checkForUpdates();
  assert("linux check is disabled", linux.getStatus().state === "disabled");

  const win = createAutoUpdaterService({
    updater: makeFakeUpdater(),
    isDev: false,
    platform: "win32",
    version: "0.6.0",
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  await win.checkForUpdates();
  assert("win32 check is enabled", win.getStatus().state === "checking");
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
