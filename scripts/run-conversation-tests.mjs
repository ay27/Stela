import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
for (const [name, entry] of [
  ["conversation", "electron/services/conversation.test.ts"],
  ["dashboard-sessions", "electron/services/ai/agent-dashboard-sessions.test.ts"],
]) {
  const outfile = `out/tests/${name}-test.mjs`;
  await build({ entryPoints: [entry], bundle: true, platform: "node", packages: "external", format: "esm", outfile, logLevel: "warning" });
  const result = spawnSync(require("electron"), [outfile], { stdio: "inherit", timeout: 60000, env: { ...process.env, ELECTRON_RUN_AS_NODE: "" } });
  if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
}
