/**
 * Prepared first-run demo Vault.
 *
 * The checked-in files under `examples/demo-vault/` are the single source of
 * truth. Vite's `?raw` imports bundle the curated text files into the renderer,
 * while this explicit allowlist prevents machine-local caches, secrets, and
 * development history from leaking into a newly created demo.
 */

import demoGitignore from "../../examples/demo-vault/.gitignore?raw";
import demoConnections from "../../examples/demo-vault/.stela/connections.json?raw";
import demoHistory from "../../examples/demo-vault/.stela/history/history_demo.jsonl?raw";
import ecommerceSkill from "../../examples/demo-vault/.stela/skills/ecommerce-unit-economics/SKILL.md?raw";
import templateChannelContribution from "../../examples/demo-vault/.stela/sql-templates/channel-contribution.md?raw";
import templateHighReturnSkus from "../../examples/demo-vault/.stela/sql-templates/high-return-skus.md?raw";
import dockerCompose from "../../examples/demo-vault/docker-compose.yml?raw";
import businessContextEn from "../../examples/demo-vault/en/01-business-context-and-metrics.md?raw";
import investigationEn from "../../examples/demo-vault/en/02-growth-quality-investigation.md?raw";
import actionPlanEn from "../../examples/demo-vault/en/03-management-action-plan.md?raw";
import businessCanvasEn from "../../examples/demo-vault/en/business-review.stela.canvas?raw";
import mysqlSchema from "../../examples/demo-vault/seed/mysql/001_schema.sql?raw";
import mysqlData from "../../examples/demo-vault/seed/mysql/002_data.sql?raw";
import welcome from "../../examples/demo-vault/README.md?raw";
import businessContextZh from "../../examples/demo-vault/zh/01-业务背景与指标.md?raw";
import investigationZh from "../../examples/demo-vault/zh/02-增长质量诊断.md?raw";
import actionPlanZh from "../../examples/demo-vault/zh/03-管理行动方案.md?raw";
import businessCanvasZh from "../../examples/demo-vault/zh/经营复盘.stela.canvas?raw";

import { createDir, createFile, pathExists } from "@/services/fs";
import {
  seedPreparedDemoVault,
  type PreparedDemoFile,
} from "@/services/demo-vault-seeder";

export { demoVaultPath } from "@/services/demo-vault-seeder";

const DEMO_FOLDER_NAME = "Stela Commerce Demo";
export const DEMO_WELCOME_PATH = "README.md";
const DEMO_CONNECTION_NAME = "local-mysql";

export async function ensureDemoConnectionSecret(): Promise<void> {
  const current = (await window.stela.connections.load())[DEMO_CONNECTION_NAME];
  const currentConfig = current?.config && typeof current.config === "object"
    ? current.config as Record<string, unknown>
    : {};
  if (typeof currentConfig.password === "string" && currentConfig.password.length > 0) return;
  await window.stela.connections.upsert(DEMO_CONNECTION_NAME, {
    kind: "mysql",
    config: {
      host: "127.0.0.1",
      port: 3306,
      user: "demo",
      database: "stela_demo",
      ...currentConfig,
      password: "demo",
    },
  });
}

export const PREPARED_DEMO_FILES: readonly PreparedDemoFile[] = [
  { relativePath: ".gitignore", contents: demoGitignore },
  { relativePath: ".stela/connections.json", contents: demoConnections },
  { relativePath: ".stela/history/history_demo.jsonl", contents: demoHistory },
  { relativePath: ".stela/skills/ecommerce-unit-economics/SKILL.md", contents: ecommerceSkill },
  { relativePath: ".stela/sql-templates/channel-contribution.md", contents: templateChannelContribution },
  { relativePath: ".stela/sql-templates/high-return-skus.md", contents: templateHighReturnSkus },
  { relativePath: "docker-compose.yml", contents: dockerCompose },
  { relativePath: "seed/mysql/001_schema.sql", contents: mysqlSchema },
  { relativePath: "seed/mysql/002_data.sql", contents: mysqlData },
  { relativePath: DEMO_WELCOME_PATH, contents: welcome },
  { relativePath: "en/01-business-context-and-metrics.md", contents: businessContextEn },
  { relativePath: "en/02-growth-quality-investigation.md", contents: investigationEn },
  { relativePath: "en/03-management-action-plan.md", contents: actionPlanEn },
  { relativePath: "en/business-review.stela.canvas", contents: businessCanvasEn },
  { relativePath: "zh/01-业务背景与指标.md", contents: businessContextZh },
  { relativePath: "zh/02-增长质量诊断.md", contents: investigationZh },
  { relativePath: "zh/03-管理行动方案.md", contents: actionPlanZh },
  { relativePath: "zh/经营复盘.stela.canvas", contents: businessCanvasZh },
];

/**
 * Seed one bilingual `Stela Commerce Demo` folder under `parentDir`.
 *
 * Missing prepared files are added on repeat runs, while existing files are
 * never overwritten so users keep any edits they made inside the demo.
 */
export async function seedDemoVault(parentDir: string): Promise<string> {
  return seedPreparedDemoVault({
    parentDir,
    folderName: DEMO_FOLDER_NAME,
    files: PREPARED_DEMO_FILES,
    dependencies: { pathExists, createDir, createFile },
  });
}
