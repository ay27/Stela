/**
 * module-loader 自运行测试。
 *
 * 覆盖：
 *   - 加载一个手写 fixture echo 插件（CJS 单文件 + plugin.json），调 meta/execute
 *   - 插件抛带 code 的错误 → 经 toIpcError 鸭子类型归一化后保留 code
 *   - 修改 entry 后重新 loadModulePlugin → require.cache 被 bust，拿到新行为（热重载）
 *   - copyPluginPackage 只拷 plugin.json + entry，并能从拷贝目录加载
 *   - 非法 manifest（缺 entry / 越界 entry）→ 抛 AppError
 *
 * 轻量 expect() 风格，沿用 vault-fs.test.ts。
 *
 *     npx tsx electron/services/connectors/module-loader.test.ts
 */

import { mkdtemp, mkdir, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { toIpcError } from "@shared/errors";

import {
  copyPluginPackage,
  loadModulePlugin,
  readManifest,
} from "./module-loader";

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}
function expect(name: string, ok: boolean, detail?: string): Check {
  return { name, ok, detail };
}

const MANIFEST = JSON.stringify({
  id: "fixture-echo",
  kind: "echo",
  displayName: "Echo Fixture",
  apiVersion: 1,
  entry: "dist/index.cjs",
});

/** 生成 fixture 插件 entry 源码；marker 影响 execute 返回，用于验证热重载。 */
function entrySource(marker: string): string {
  return `
const mod = {
  apiVersion: 1,
  create(ctx) {
    return {
      meta() {
        return {
          kind: "echo",
          displayName: "Echo Fixture",
          configSchema: { type: "object", properties: {} },
          defaultConfig: {},
          subprocess: false,
        };
      },
      async test() { return { ok: true, message: ${JSON.stringify(marker)} }; },
      async execute(cfg, sql) {
        if (sql === "BOOM") {
          const e = new Error("boom from plugin");
          e.code = "plugin_boom";
          e.retryable = true;
          throw e;
        }
        return {
          kind: "query",
          columns: [{ name: "marker", typeName: "VARCHAR" }],
          rows: [[${JSON.stringify(marker)}, sql]],
          elapsedMs: 1,
        };
      },
      async listDatabases() { return ["db1"]; },
      async listTables() { return ["t1"]; },
      async dispose() { /* noop */ },
    };
  },
};
module.exports = mod;
module.exports.default = mod;
`;
}

async function makePlugin(
  marker: string,
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "stela-modplugin-"));
  await mkdir(path.join(dir, "dist"), { recursive: true });
  await writeFile(path.join(dir, "plugin.json"), MANIFEST, "utf-8");
  await writeFile(
    path.join(dir, "dist/index.cjs"),
    entrySource(marker),
    "utf-8",
  );
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function runLoadAndExecute(): Promise<Check[]> {
  const out: Check[] = [];
  const { dir, cleanup } = await makePlugin("v1");
  try {
    const conn = await loadModulePlugin(dir);
    out.push(expect("meta.kind === echo", conn.meta().kind === "echo"));
    out.push(
      expect("manifest.id surfaced", conn.manifest.id === "fixture-echo"),
    );
    const r = await conn.execute({}, "SELECT 1");
    out.push(
      expect(
        "execute returns marker v1",
        r.kind === "query" && r.rows[0]?.[0] === "v1",
        JSON.stringify(r),
      ),
    );
    const dbs = await conn.listDatabases({});
    out.push(expect("listDatabases", dbs[0] === "db1"));
    await conn.dispose();
  } finally {
    await cleanup();
  }
  return out;
}

async function runErrorCodeNormalization(): Promise<Check[]> {
  const out: Check[] = [];
  const { dir, cleanup } = await makePlugin("v1");
  try {
    const conn = await loadModulePlugin(dir);
    let payload: ReturnType<typeof toIpcError> | null = null;
    try {
      await conn.execute({}, "BOOM");
    } catch (err) {
      payload = toIpcError(err);
    }
    out.push(
      expect(
        "plugin error code preserved via duck-typing",
        payload?.code === "plugin_boom",
        `got code=${payload?.code ?? "<none>"}`,
      ),
    );
    out.push(
      expect(
        "plugin error retryable preserved",
        payload?.retryable === true,
        `got retryable=${String(payload?.retryable)}`,
      ),
    );
  } finally {
    await cleanup();
  }
  return out;
}

async function runHotReload(): Promise<Check[]> {
  const out: Check[] = [];
  const { dir, cleanup } = await makePlugin("v1");
  try {
    const c1 = await loadModulePlugin(dir);
    const r1 = await c1.execute({}, "X");
    // rewrite entry with new marker
    await writeFile(
      path.join(dir, "dist/index.cjs"),
      entrySource("v2"),
      "utf-8",
    );
    const c2 = await loadModulePlugin(dir);
    const r2 = await c2.execute({}, "X");
    out.push(
      expect(
        "reload busts require.cache (v1 -> v2)",
        r1.kind === "query" &&
          r1.rows[0]?.[0] === "v1" &&
          r2.kind === "query" &&
          r2.rows[0]?.[0] === "v2",
        `${JSON.stringify(r1.kind === "query" ? r1.rows[0] : r1)} / ${JSON.stringify(r2.kind === "query" ? r2.rows[0] : r2)}`,
      ),
    );
  } finally {
    await cleanup();
  }
  return out;
}

async function runCopyPackage(): Promise<Check[]> {
  const out: Check[] = [];
  const { dir, cleanup } = await makePlugin("v1");
  const destRoot = await mkdtemp(path.join(tmpdir(), "stela-modplugin-dest-"));
  const dest = path.join(destRoot, "fixture-echo");
  try {
    const m = await copyPluginPackage(dir, dest);
    out.push(expect("copy returns manifest", m.id === "fixture-echo"));
    const entryStat = await stat(path.join(dest, "dist/index.cjs")).catch(
      () => null,
    );
    out.push(expect("entry copied", !!entryStat && entryStat.isFile()));
    const conn = await loadModulePlugin(dest);
    out.push(expect("loads from copied dir", conn.meta().kind === "echo"));
    await conn.dispose();
  } finally {
    await cleanup();
    await rm(destRoot, { recursive: true, force: true });
  }
  return out;
}

async function runBadManifest(): Promise<Check[]> {
  const out: Check[] = [];
  const dir = await mkdtemp(path.join(tmpdir(), "stela-modplugin-bad-"));
  try {
    await writeFile(
      path.join(dir, "plugin.json"),
      JSON.stringify({ id: "x", kind: "x", apiVersion: 1, entry: "../evil.js" }),
      "utf-8",
    );
    let code: string | undefined;
    try {
      await readManifest(dir);
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    out.push(
      expect(
        "entry escaping plugin dir rejected",
        code === "bad_manifest",
        `got code=${code ?? "<none>"}`,
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return out;
}

async function main(): Promise<void> {
  const checks: Check[] = [
    ...(await runLoadAndExecute()),
    ...(await runErrorCodeNormalization()),
    ...(await runHotReload()),
    ...(await runCopyPackage()),
    ...(await runBadManifest()),
  ];
  let failed = 0;
  for (const c of checks) {
    if (c.ok) {
      console.log(`[ok]   ${c.name}`);
    } else {
      failed += 1;
      console.log(`[FAIL] ${c.name}${c.detail ? `\n       ${c.detail}` : ""}`);
    }
  }
  if (failed > 0) {
    console.error(`\nmodule-loader tests FAILED (${failed}).`);
    process.exit(1);
  }
  console.log("\nmodule-loader tests passed.");
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  fileURLToPath(import.meta.url) === process.argv[1]
) {
  void main();
}
