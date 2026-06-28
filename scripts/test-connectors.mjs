import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.STELA_CONNECTOR_INTEGRATION !== "1") {
  console.log("connector integration tests skipped (set STELA_CONNECTOR_INTEGRATION=1)");
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const require = createRequire(import.meta.url);

function loadPlugin(id) {
  const mod = require(path.join(repoRoot, "plugins", id, "dist/index.cjs"));
  const plugin = mod.default ?? mod;
  return plugin.create({
    pluginDir: path.join(repoRoot, "plugins", id),
    log: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
  });
}

async function check(name, fn) {
  try {
    await fn();
    console.log(`[ok]   ${name}`);
  } catch (err) {
    console.error(`[FAIL] ${name}: ${(err && err.message) || err}`);
    process.exitCode = 1;
  }
}

const mysql = loadPlugin("connector-mysql");
const postgres = loadPlugin("connector-postgresql");

await check("mysql SELECT 1", async () => {
  const result = await mysql.execute(
    {
      host: "127.0.0.1",
      port: 3306,
      user: "demo",
      password: "demo",
      database: "stela_demo",
    },
    "SELECT 1 AS ok",
  );
  if (result.kind !== "query" || result.rows[0]?.[0] !== 1) {
    throw new Error(`unexpected result: ${JSON.stringify(result)}`);
  }
});

await check("mysql listTables", async () => {
  const tables = await mysql.listTables({
    host: "127.0.0.1",
    port: 3306,
    user: "demo",
    password: "demo",
    database: "stela_demo",
  });
  if (!tables.includes("demo_tasks")) {
    throw new Error(`demo_tasks missing: ${tables.join(", ")}`);
  }
});

await check("postgresql SELECT 1", async () => {
  const result = await postgres.execute(
    {
      host: "127.0.0.1",
      port: 5432,
      user: "demo",
      password: "demo",
      database: "stela_demo",
    },
    "SELECT 1 AS ok",
  );
  if (result.kind !== "query" || result.rows[0]?.[0] !== 1) {
    throw new Error(`unexpected result: ${JSON.stringify(result)}`);
  }
});

await check("postgresql listTables", async () => {
  const tables = await postgres.listTables({
    host: "127.0.0.1",
    port: 5432,
    user: "demo",
    password: "demo",
    database: "stela_demo",
  });
  if (!tables.includes("public.demo_tasks")) {
    throw new Error(`public.demo_tasks missing: ${tables.join(", ")}`);
  }
});

await mysql.dispose?.();
await postgres.dispose?.();

if (process.exitCode) process.exit(process.exitCode);
console.log("connector integration tests passed.");
