import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here=path.dirname(fileURLToPath(import.meta.url));
await build({entryPoints:[path.join(here,"src/index.ts")],outfile:path.join(here,"dist/index.cjs"),bundle:true,platform:"node",format:"cjs",target:"node18",external:["snowflake-sdk"],alias:{"@stela/connector-plugin-sdk":path.resolve(here,"../../plugin-sdk/src/index.ts")}});
