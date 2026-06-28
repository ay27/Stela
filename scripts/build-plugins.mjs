import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

const DEFAULT_PUBLIC_PLUGINS = [
  "connector-mysql",
  "connector-postgresql",
  "connector-http-sample",
];

function parsePluginList(raw) {
  if (!raw || !raw.trim()) return DEFAULT_PUBLIC_PLUGINS;
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

const plugins = parsePluginList(process.env.STELA_BUNDLED_PLUGINS);

for (const id of plugins) {
  if (!/^[a-z0-9][a-z0-9-_]*$/.test(id)) {
    throw new Error(`Invalid plugin id in STELA_BUNDLED_PLUGINS: ${id}`);
  }
  const buildScript = path.join(repoRoot, "plugins", id, "build.mjs");
  const result = spawnSync(process.execPath, [buildScript], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
