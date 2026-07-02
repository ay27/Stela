/**
 * recent-files-store 自运行测试。
 *
 *     npx tsx electron/services/recent-files-store.test.ts
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  FILE_NAME,
  loadRecentFiles,
  migrateFromSettingsIfNeeded,
  saveRecentFiles,
} from "./recent-files-store";
import { loadAppSettings } from "./settings-store";
import { ensureVaultConfigDir, vaultFilePath } from "./vault-paths";

async function makeVault(): Promise<{
  vaultPath: string;
  cleanup: () => Promise<void>;
}> {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "stela-recent-files-"));
  return {
    vaultPath,
    cleanup: async () => {
      await rm(vaultPath, { recursive: true, force: true });
    },
  };
}

async function run(): Promise<void> {
  {
    const { vaultPath, cleanup } = await makeVault();
    try {
      const saved = await saveRecentFiles(vaultPath, [
        { path: "notes/a.md", openedAt: 100 },
        { path: "notes/b.md", openedAt: 200 },
      ]);
      assert.deepEqual(saved, [
        { path: "notes/a.md", openedAt: 100 },
        { path: "notes/b.md", openedAt: 200 },
      ]);
      assert.deepEqual(await loadRecentFiles(vaultPath), saved);
    } finally {
      await cleanup();
    }
  }

  {
    const { vaultPath, cleanup } = await makeVault();
    try {
      const migrated = await migrateFromSettingsIfNeeded(vaultPath, [
        { path: "legacy.md", openedAt: 42 },
      ]);
      assert.equal(migrated, true);
      assert.deepEqual(await loadRecentFiles(vaultPath), [
        { path: "legacy.md", openedAt: 42 },
      ]);
      assert.equal(
        await migrateFromSettingsIfNeeded(vaultPath, [
          { path: "other.md", openedAt: 99 },
        ]),
        false,
      );
    } finally {
      await cleanup();
    }
  }

  {
    const { vaultPath, cleanup } = await makeVault();
    try {
      const settingsPath = vaultFilePath(vaultPath, "settings.json");
      await ensureVaultConfigDir(vaultPath);
      await import("node:fs/promises").then((fs) =>
        fs.writeFile(
          settingsPath,
          JSON.stringify(
            {
              ui: { editorWidth: "wide" },
              vault: {
                recentFiles: [{ path: "notes/old.md", openedAt: 7 }],
              },
            },
            null,
            2,
          ),
        ),
      );

      const settings = await loadAppSettings(vaultPath);
      assert.deepEqual(settings.vault.recentFiles, [
        { path: "notes/old.md", openedAt: 7 },
      ]);

      const settingsText = await readFile(settingsPath, "utf-8");
      assert.equal(settingsText.includes("recentFiles"), false);

      const localPath = vaultFilePath(vaultPath, FILE_NAME);
      const localText = await readFile(localPath, "utf-8");
      assert.ok(localText.includes("notes/old.md"));
    } finally {
      await cleanup();
    }
  }
}

await run();
console.log("recent-files-store tests passed.");
