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

console.log("[connector-http-sample] built dist/index.cjs");
