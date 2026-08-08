import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseAnalysisCanvas } from "../electron/shared/analysis-canvas";
import { buildDemoFixture, buildDemoQueryResults } from "./demo-vault-fixture";
import { demoVaultPath, seedPreparedDemoVault } from "../src/services/demo-vault-seeder";

interface JournalLine {
  runId: string;
  record: { sql: string; status: string; connectionName: string };
  columns: Array<{ name: string; typeName: string }>;
  rows: unknown[][];
}

const root = path.join(process.cwd(), "examples", "demo-vault");
const readDemo = (relativePath: string) => readFile(path.join(root, relativePath), "utf8");
const canvasFiles = ["en/business-review.stela.canvas", "zh/经营复盘.stela.canvas"];
const noteFiles = [
  "en/01-business-context-and-metrics.md",
  "en/02-growth-quality-investigation.md",
  "en/03-management-action-plan.md",
  "zh/01-业务背景与指标.md",
  "zh/02-增长质量诊断.md",
  "zh/03-管理行动方案.md",
];
const templateFiles = [
  ".stela/sql-templates/channel-contribution.md",
  ".stela/sql-templates/high-return-skus.md",
];

const fixture = buildDemoFixture();
assert.equal(fixture.customers.length, 600);
assert.equal(fixture.products.length, 24);
assert.equal(fixture.orders.length, 1_650);
assert.equal(fixture.orderItems.length, 2_930);
assert.equal(fixture.returns.length, 155);

const expectedResults = new Map(buildDemoQueryResults(fixture).map((result) => [result.id, result]));
const journal = (await readDemo(".stela/history/history_demo.jsonl"))
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as JournalLine);
assert.equal(journal.length, expectedResults.size * 2);
const journalByRunId = new Map(journal.map((line) => [line.runId, line]));

for (const locale of ["en", "zh"]) {
  for (const [id, expected] of expectedResults) {
    const saved = journalByRunId.get(`run_demo_ecommerce_${id}_${locale}`);
    assert.ok(saved, `missing ${locale} ${id} history`);
    assert.equal(saved.record.status, "ok");
    assert.equal(saved.record.connectionName, "local-mysql");
    assert.equal(saved.record.sql, expected.sql);
    assert.deepEqual(saved.columns, expected.columns);
    assert.deepEqual(saved.rows, expected.rows);
  }
}

const monthly = expectedResults.get("monthly")!.rows;
const may = monthly[4]!;
const june = monthly[5]!;
assert.ok(Number(june[1]) > Number(may[1]), "June orders must grow");
assert.ok(Number(june[2]) > Number(may[2]), "June revenue must grow");
assert.ok(Number(june[4]) < Number(may[4]) - 0.2, "June contribution margin must fall materially");
const kpi = expectedResults.get("kpi")!.rows[0]!;
assert.ok(Number(kpi[5]) < -0.5, "June contribution profit must fall by more than half");
assert.ok(Number(kpi[6]) < 0, "paid social contribution must be negative in the evidence KPIs");
assert.ok(Number(kpi[8]) > 0.19, "TrailFlex return rate must exceed 19% in the evidence KPIs");
const paidSocial = expectedResults.get("channel")!.rows.find((row) => row[0] === "paid_social");
assert.ok(paidSocial && Number(paidSocial[4]) < 0, "paid social must be contribution-negative");
assert.equal(expectedResults.get("sku")!.rows[0]?.[0], "NS-FW-004");

for (const relativePath of canvasFiles) {
  const canvas = parseAnalysisCanvas(await readDemo(relativePath));
  assert.equal(canvas.status, "complete");
  assert.ok(canvas.sections.some((section) => section.cards.some((card) => card.type === "chart")));
  assert.ok(canvas.sections.some((section) => section.cards.some((card) => card.type === "flow")));
  assert.ok(canvas.sections.some((section) => section.cards.some((card) => card.type === "table")));
  const statisticalEvidence = canvas.sections.find((section) => section.id === "statistical_evidence");
  assert.equal(statisticalEvidence?.cards.filter((card) => card.type === "kpi").length, 3);
  for (const source of canvas.sources) {
    assert.ok(source.lastRunId);
    const saved = journalByRunId.get(source.lastRunId);
    assert.ok(saved, `${relativePath} references missing ${source.lastRunId}`);
    assert.equal(source.sql, saved.record.sql);
  }
}

for (const relativePath of noteFiles) {
  const note = await readDemo(relativePath);
  assert.match(note, /connection_name: local-mysql/);
  for (const resultRef of note.matchAll(/<result-ref-id>([^<]+)<\/result-ref-id>/g)) {
    assert.ok(journalByRunId.has(resultRef[1]!), `${relativePath} references missing ${resultRef[1]}`);
  }
}

for (const relativePath of templateFiles) {
  const template = (await readDemo(relativePath)).replace(/\r\n?/g, "\n");
  assert.match(template, /type: stela-sql-template/);
  assert.match(template, /name: .+ \/ .+/);
  assert.match(template, /```runsql\n[\s\S]+\n```/);
  const variables = [...template.matchAll(/{{([^}]+)}}/g)].map((match) => match[1]);
  assert.ok(variables.length >= 5);
  assert.ok(new Set(variables).size < variables.length, `${relativePath} must demonstrate linked repeated variables`);
}

const skill = await readDemo(".stela/skills/ecommerce-unit-economics/SKILL.md");
assert.match(skill, /category: metric-definition/);
assert.match(skill, /## Definition/);
assert.match(skill, /## Grain & Filters/);
assert.match(skill, /## Verify/);

const welcome = await readDemo("README.md");
assert.match(welcome, /\[\[en\/01-business-context-and-metrics/);
assert.match(welcome, /\[\[zh\/01-业务背景与指标/);
assert.doesNotMatch(welcome, /START-HERE|release readiness|发布准备度/i);

const connections = JSON.parse(await readDemo(".stela/connections.json")) as { entries: Record<string, { kind: string; config: Record<string, unknown> }> };
assert.deepEqual(Object.keys(connections.entries), ["local-mysql"]);
assert.equal(connections.entries["local-mysql"]?.kind, "mysql");
assert.equal(connections.entries["local-mysql"]?.config.password, undefined);
const compose = await readDemo("docker-compose.yml");
assert.match(compose, /mysql:8/);
assert.doesNotMatch(compose, /postgres/i);
const mysqlData = await readDemo("seed/mysql/002_data.sql");
assert.match(mysqlData, /INSERT INTO customers/);
assert.match(mysqlData, /INSERT INTO orders/);
assert.match(mysqlData, /INSERT INTO returns/);

const curatedText = [welcome, skill, compose, ...await Promise.all(noteFiles.map(readDemo)), ...await Promise.all(templateFiles.map(readDemo))].join("\n");
assert.doesNotMatch(curatedText, /demo_tasks|release-readiness|mobile-onboarding|local-postgresql/i);

assert.equal(demoVaultPath("/tmp/demo/", "en/start.md"), "/tmp/demo/en/start.md");
assert.equal(demoVaultPath("C:\\Users\\demo", "zh/开始使用.md"), "C:\\Users\\demo\\zh\\开始使用.md");
const existing = new Set<string>(["/tmp"]);
const directories: string[] = [];
const writes: string[] = [];
const seedFiles = [
  { relativePath: "README.md", contents: "welcome" },
  { relativePath: "en/start.md", contents: "start" },
] as const;
const seed = () => seedPreparedDemoVault({
  parentDir: "/tmp",
  folderName: "Stela Commerce Demo",
  files: seedFiles,
  dependencies: {
    pathExists: async (filePath) => existing.has(filePath),
    createDir: async (_vaultPath, filePath) => { directories.push(filePath); existing.add(filePath); },
    createFile: async (_vaultPath, filePath) => { writes.push(filePath); existing.add(filePath); },
  },
});
assert.equal(await seed(), "/tmp/Stela Commerce Demo");
await seed();
assert.deepEqual(directories, ["/tmp/Stela Commerce Demo"]);
assert.deepEqual(writes, ["/tmp/Stela Commerce Demo/README.md", "/tmp/Stela Commerce Demo/en/start.md"]);

console.log("commerce demo vault checks passed.");
