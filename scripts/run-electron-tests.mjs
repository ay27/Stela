import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electron = require("electron");

const tests = [
  "electron/services/result-store.test.ts",
  "electron/services/history-journal.test.ts",
];

for (const file of tests) {
  const result = spawnSync(
    electron,
    ["--import", "tsx", file],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: "inherit",
    },
  );
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
