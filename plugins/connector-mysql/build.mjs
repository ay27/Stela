/**
 * 构建 MySQL connector 插件为单文件 CJS bundle（dist/index.cjs）。
 *
 * - platform node：Node 内建模块自动 external
 * - bundle mysql2：内联进产物，安装到 vault 后无需额外 node_modules
 * - alias @stela/connector-plugin-sdk → 仓内 plugin-sdk 源码（发布时换成 npm 包）
 *
 * esbuild 从仓库根 node_modules 解析（mysql2 / esbuild 都在根 devDependencies）。
 */

import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

await build({
  entryPoints: [path.join(here, "src/index.ts")],
  outfile: path.join(here, "dist/index.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  sourcemap: false,
  logLevel: "info",
  alias: {
    "@stela/connector-plugin-sdk": path.join(
      repoRoot,
      "plugin-sdk/src/index.ts",
    ),
  },
});

console.log("[connector-mysql] built dist/index.cjs");
