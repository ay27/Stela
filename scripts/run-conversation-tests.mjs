import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
await build({ entryPoints: ["electron/services/conversation.test.ts"], bundle: true, platform: "node", packages: "external", format: "esm", outfile: "out/tests/conversation-test.mjs", logLevel: "warning" });
const result = spawnSync(require("electron"), ["out/tests/conversation-test.mjs"], { stdio: "inherit", timeout: 60000, env: { ...process.env, ELECTRON_RUN_AS_NODE: "" } });
process.exitCode = result.status ?? 1;
