/**
 * 模板目录尚未创建时，打开模板 UI 不应触发失败的 IPC 请求。
 *
 *     npx tsx src/services/sql-templates-missing-dir.test.ts
 */
import { listSqlTemplates } from "./sql-templates";

let listDirCalls = 0;
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    stela: {
      vault: {
        pathExists: async () => false,
        listDir: async () => {
          listDirCalls += 1;
          throw new Error("template directory is missing");
        },
      },
    },
  },
});

const templates = await listSqlTemplates("/vault");
if (templates.length !== 0 || listDirCalls !== 0) {
  console.error(
    `expected no templates without listDir IPC, got count=${templates.length}, calls=${listDirCalls}`,
  );
  process.exit(1);
}
console.log("sql-templates-missing-dir.test.ts passed");
