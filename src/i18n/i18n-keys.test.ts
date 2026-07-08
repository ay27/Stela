import en from "./locales/en.json";
import zh from "./locales/zh.json";

import { readFileSync } from "node:fs";
import path from "node:path";

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

const UI_FILES_WITHOUT_HARDCODED_CHINESE = [
  "src/components/backlinks-panel.tsx",
  "src/components/block-run-tabs.tsx",
  "src/components/ai/ai-modal.tsx",
  "src/components/command-palette.tsx",
  "src/components/connection-picker.tsx",
  "src/layout/SchemaBrowserPanel.tsx",
  "src/layout/Sidebar.tsx",
  "src/views/WelcomeView.tsx",
  "src/components/settings-dialog.tsx",
  "src/components/settings/appearance-tab.tsx",
  "src/components/settings/atoms.tsx",
  "src/components/settings/connector-form.tsx",
  "src/components/settings/connections-tab.tsx",
  "src/components/settings/execution-tab.tsx",
  "src/components/settings/git-tab.tsx",
  "src/components/settings/ai-tab.tsx",
  "src/components/settings/persistence-tab.tsx",
  "src/components/settings/plugins-tab.tsx",
  "src/components/settings/security-tab.tsx",
  "src/components/settings/shortcuts-tab.tsx",
  "src/components/settings/ui-tab.tsx",
  "src/layout/FileTree.tsx",
  "src/layout/RunHistoryPanel.tsx",
  "src/layout/SearchPanel.tsx",
  "src/layout/SqlSearchView.tsx",
  "src/views/EditorView.tsx",
];

const OLD_SLOGAN = "Markdown + SQL 数据笔记，所有操作都将刻印在石碑之上。";
const CURRENT_SLOGAN = "Run SQL in Markdown. Track data in Stela.";
const SLOGAN_FILES = [
  "README.md",
  "src/views/WelcomeView.tsx",
  "src/services/demo-vault.ts",
];

function expect(name: string, ok: boolean, detail?: string): Check {
  return { name, ok, detail };
}

function keys(obj: Record<string, unknown>): string[] {
  return Object.keys(obj).sort();
}

function diff(left: string[], right: string[]): string[] {
  const r = new Set(right);
  return left.filter((k) => !r.has(k));
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s+\/\/.*$/gm, "");
}

function hardcodedChineseFindings(): string[] {
  const root = process.cwd();
  const findings: string[] = [];
  for (const rel of UI_FILES_WITHOUT_HARDCODED_CHINESE) {
    const src = stripComments(readFileSync(path.join(root, rel), "utf-8"));
    src.split(/\r?\n/).forEach((line, idx) => {
      if (/[\p{Script=Han}]/u.test(line)) {
        findings.push(`${rel}:${idx + 1}: ${line.trim()}`);
      }
    });
  }
  return findings;
}

function sloganFindings(): string[] {
  const root = process.cwd();
  const findings: string[] = [];
  for (const rel of SLOGAN_FILES) {
    const src = readFileSync(path.join(root, rel), "utf-8");
    if (src.includes(OLD_SLOGAN)) {
      findings.push(`${rel}: contains old slogan`);
    }
  }
  const readme = readFileSync(path.join(root, "README.md"), "utf-8");
  if (!readme.includes(CURRENT_SLOGAN)) {
    findings.push("README.md: missing current slogan");
  }
  return findings;
}

function main(): void {
  const enKeys = keys(en);
  const zhKeys = keys(zh);
  const hardcodedChinese = hardcodedChineseFindings();
  const slogans = sloganFindings();
  const checks = [
    expect(
      "en/zh i18n keys match",
      JSON.stringify(enKeys) === JSON.stringify(zhKeys),
      `missing in zh: ${diff(enKeys, zhKeys).join(", ")}\nmissing in en: ${diff(zhKeys, enKeys).join(", ")}`,
    ),
    expect(
      "selected UI files have no hardcoded Chinese",
      hardcodedChinese.length === 0,
      hardcodedChinese.slice(0, 80).join("\n"),
    ),
    expect(
      "public slogan is current",
      slogans.length === 0,
      slogans.join("\n"),
    ),
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
    console.error(`\ni18n key tests FAILED (${failed}).`);
    process.exit(1);
  }
  console.log("\ni18n key tests passed.");
}

main();
