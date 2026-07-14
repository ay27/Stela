import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

/**
 * 公开仓库硬门禁（仅通用泄露形态，不含内部标识）。
 * 私有关键词：
 *   - 本地：`scripts/internal/release-gate.local.json` → forbiddenPatternSources
 *   - CI：环境变量 `STELA_RELEASE_FORBIDDEN_PATTERNS`（GitHub Secret）
 */
const FORBIDDEN_PATTERNS = [/Bearer\s+sk-/i];

const ALLOWED_PLUGIN_DIRS = new Set([
  "connector-mysql",
  "connector-postgresql",
  "connector-http-sample",
]);

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "out",
  "release",
  ".worktrees",
  "worktrees",
  "scripts/internal",
]);

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".json",
  ".md",
  ".yml",
  ".yaml",
  ".gitignore",
]);

function loadLocalGate() {
  const defaults = {
    forbiddenPatternSources: [],
    privatePluginDirs: [],
    skipPathPrefixes: [],
  };
  const p = path.join(here, "internal", "release-gate.local.json");
  if (!existsSync(p)) return defaults;
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    return {
      forbiddenPatternSources: Array.isArray(raw.forbiddenPatternSources)
        ? raw.forbiddenPatternSources.filter((s) => typeof s === "string")
        : [],
      privatePluginDirs: Array.isArray(raw.privatePluginDirs)
        ? raw.privatePluginDirs.filter((s) => typeof s === "string")
        : [],
      skipPathPrefixes: Array.isArray(raw.skipPathPrefixes)
        ? raw.skipPathPrefixes.filter((s) => typeof s === "string")
        : [],
    };
  } catch {
    return defaults;
  }
}

/**
 * GitHub Secret / env：JSON 数组，或按行分隔的 regex source（一律加 `i`）。
 * 例：`["acme_","corp-internal"]` 或换行列表。
 */
function loadEnvForbiddenSources() {
  const raw = process.env.STELA_RELEASE_FORBIDDEN_PATTERNS?.trim();
  if (!raw) return [];
  if (raw.startsWith("[")) {
    let arr;
    try {
      arr = JSON.parse(raw);
    } catch {
      console.error(
        "STELA_RELEASE_FORBIDDEN_PATTERNS must be JSON array or newline-separated regex sources",
      );
      process.exit(1);
    }
    if (!Array.isArray(arr)) {
      console.error("STELA_RELEASE_FORBIDDEN_PATTERNS JSON must be an array of strings");
      process.exit(1);
    }
    return arr.filter((s) => typeof s === "string" && s.length > 0);
  }
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function compileSources(sources, origin) {
  return sources.map((src, i) => {
    try {
      return new RegExp(src, "i");
    } catch {
      console.error(`Invalid forbidden regex in ${origin} (entry #${i + 1})`);
      process.exit(1);
    }
  });
}

const localGate = loadLocalGate();
const LOCAL_FORBIDDEN = compileSources(
  localGate.forbiddenPatternSources,
  "scripts/internal/release-gate.local.json",
);
const ENV_FORBIDDEN = compileSources(
  loadEnvForbiddenSources(),
  "STELA_RELEASE_FORBIDDEN_PATTERNS",
);
const ALL_FORBIDDEN = [...FORBIDDEN_PATTERNS, ...LOCAL_FORBIDDEN, ...ENV_FORBIDDEN];
const PRIVATE_PLUGIN_DIRS = new Set(localGate.privatePluginDirs);
const SKIP_PATH_PREFIXES = localGate.skipPathPrefixes;

/** Windows `path.relative` 用 `\`；门禁路径一律按 POSIX `/` 比对。 */
function toPosixRel(rel) {
  return rel.replace(/\\/g, "/");
}

function shouldSkipPath(rel) {
  if (rel === "scripts/internal" || rel.startsWith("scripts/internal/")) {
    return true;
  }
  return SKIP_PATH_PREFIXES.some(
    (prefix) => rel === prefix || rel.startsWith(`${prefix}/`),
  );
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = path.join(dir, name);
    const rel = toPosixRel(path.relative(repoRoot, p));
    if (shouldSkipPath(rel)) continue;
    const st = statSync(p);
    if (st.isDirectory()) {
      walk(p, out);
    } else if (TEXT_EXTENSIONS.has(path.extname(p)) || name === "README") {
      out.push(p);
    }
  }
  return out;
}

function checkForbiddenText() {
  const failures = [];
  for (const file of walk(repoRoot)) {
    const rel = toPosixRel(path.relative(repoRoot, file));
    // 脚本自身可能含「如何配置 secret」的说明文字；不把门禁文件当扫描目标。
    if (rel === "scripts/check-public-release.mjs") continue;
    const text = readFileSync(file, "utf-8");
    for (const pattern of ALL_FORBIDDEN) {
      if (pattern.test(text)) {
        // ponytail: 不回显 pattern，避免 CI 日志把 GitHub Secret 内容打出来
        failures.push(`${rel}: matches a forbidden pattern`);
        break;
      }
    }
  }
  return failures;
}

function checkPluginDirs() {
  const pluginsDir = path.join(repoRoot, "plugins");
  let names;
  try {
    names = readdirSync(pluginsDir);
  } catch {
    return [];
  }
  const failures = [];
  for (const name of names) {
    const p = path.join(pluginsDir, name);
    if (!statSync(p).isDirectory()) continue;
    if (PRIVATE_PLUGIN_DIRS.has(name)) continue;
    if (!ALLOWED_PLUGIN_DIRS.has(name)) {
      failures.push(`plugins/${name} is not in the public allowlist`);
    }
  }
  return failures;
}

function checkDisabledFeatureEntries() {
  const failures = [];
  const viteConfig = readFileSync(path.join(repoRoot, "electron.vite.config.ts"), "utf-8");
  if (/"mcp-server"\s*:/.test(viteConfig)) {
    failures.push("electron.vite.config.ts still compiles the MCP server entry");
  }
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf-8"));
  const disabledRuntimeDeps = [
    "@modelcontextprotocol/sdk",
    "@xenova/transformers",
    "sqlite-vec",
  ];
  for (const dep of disabledRuntimeDeps) {
    if (pkg.dependencies?.[dep]) {
      failures.push(`package.json keeps disabled feature dependency in dependencies: ${dep}`);
    }
  }
  const asarUnpack = JSON.stringify(pkg.build?.asarUnpack ?? []);
  for (const marker of ["sqlite-vec", "onnxruntime-node", "@xenova/transformers"]) {
    if (asarUnpack.includes(marker)) {
      failures.push(`package.json still unpacks disabled feature runtime: ${marker}`);
    }
  }
  return failures;
}

const failures = [
  ...checkForbiddenText(),
  ...checkPluginDirs(),
  ...checkDisabledFeatureEntries(),
];

if (failures.length > 0) {
  console.error("Public release gate failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Public release gate passed.");
