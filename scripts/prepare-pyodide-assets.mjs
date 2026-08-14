import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.join(repoRoot, "node_modules", "pyodide");
const cacheRoot = path.join(repoRoot, "node_modules", ".cache", "stela-pyodide");
const packageJson = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
const lock = JSON.parse(await fs.readFile(path.join(packageRoot, "pyodide-lock.json"), "utf8"));
const requested = ["duckdb", "pandas"];
const selected = new Set();

function include(name) {
  if (selected.has(name)) return;
  const entry = lock.packages[name];
  if (!entry) throw new Error(`Pyodide lockfile has no package '${name}'`);
  selected.add(name);
  for (const dependency of entry.depends ?? []) include(dependency);
}
for (const name of requested) include(name);

await fs.mkdir(cacheRoot, { recursive: true });
for (const name of [
  "pyodide.asm.mjs",
  "pyodide.asm.wasm",
  "python_stdlib.zip",
]) {
  await fs.copyFile(path.join(packageRoot, name), path.join(cacheRoot, name));
}

const filteredLock = {
  info: lock.info,
  packages: Object.fromEntries(
    [...selected].sort().map((name) => [name, lock.packages[name]]),
  ),
};
await fs.writeFile(
  path.join(cacheRoot, "pyodide-lock.json"),
  JSON.stringify(filteredLock),
  "utf8",
);

async function sha256(file) {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

const baseUrl = `https://cdn.jsdelivr.net/pyodide/v${packageJson.version}/full/`;
for (const name of [...selected].sort()) {
  const entry = lock.packages[name];
  const target = path.join(cacheRoot, entry.file_name);
  try {
    if ((await sha256(target)) === entry.sha256) continue;
  } catch {
    // Download below.
  }
  const response = await fetch(new URL(entry.file_name, baseUrl));
  if (!response.ok) throw new Error(`download ${name} failed: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== entry.sha256) throw new Error(`download ${name} checksum mismatch`);
  const temp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temp, bytes);
  await fs.rename(temp, target);
}

console.log(`Pyodide assets ready: ${[...selected].sort().join(", ")}`);
