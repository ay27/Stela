import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
// Keep package resolution in this checkout; all test Vault writes use a separate tempdir.
const dir = await mkdtemp(join(process.cwd(), ".maintenance-test-"));
try {
  const outfile = join(dir, "test.mjs");
  await build({
    entryPoints: ["electron/services/ai/skill-maintenance.integration.test.ts"],
    outfile, bundle: true, platform: "node", format: "esm", packages: "external",
    plugins: [{ name: "electron-test-boundary", setup(build) {
      build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "test" }));
      build.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: `
        export const app = {
          getPath() { throw new Error("Host userData is unavailable in this test"); },
          getAppPath() { return process.cwd(); }, isPackaged: false
        };
      ` }));
    } }],
  });
  const result = spawnSync(require("electron"), [outfile], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "inherit", timeout: 60_000,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
