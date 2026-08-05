import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { AiSettings } from "@shared/types";

import { ExecutionPlanStore } from "./execution-plan";
import { createAgentTools, dispatchTool } from "./agent-tools";
import { parseRunsqlFences } from "@shared/runsql-fences";

const AI_SETTINGS = {
  providerMode: "openai-compatible",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  hasApiKey: true,
  sendResultSamples: true,
  maxSampleRows: 20,
  contextWindow: 128_000,
  agentMaxIterations: 12,
  agentWallClockMs: 90_000,
  agentAllowMutations: false,
} satisfies AiSettings;

const root = await mkdtemp(join(tmpdir(), "stela-agent-tools-"));
try {
  await writeFile(join(root, "note.md"), "# Hello\n\nAgent target note.\n");

  const fakeConnector = {
    listKinds: () => [],
    listDatabases: async () => {
      throw new Error("listDatabases should not be called in this test");
    },
    listTables: async () => {
      throw new Error("listTables should not be called in this test");
    },
    execute: async () => {
      throw new Error("execute should not be called in this test");
    },
  };

  const baseCtx = {
    vaultPath: root,
    connectionName: null,
    connection: null,
    aiSettings: AI_SETTINGS,
    connector: fakeConnector,
    sqlIndex: { query: async () => [] },
    skills: [],
    mode: "normal" as const,
    run: { runId: "test-run", notePath: null, questionsAsked: 0 },
    recordRun: async () => {},
    requestProposal: async () => true,
    plan: new ExecutionPlanStore("test-run"),
  };

  // 无连接时数据库相关工具明确报错，引导模型走别的路径
  {
    const r = await dispatchTool("list_databases", "{}", baseCtx);
    assert.equal(r.ok, false);
    assert.match(r.text, /No data connection/);
  }
  {
    const r = await dispatchTool("run_sql", JSON.stringify({ sql: "SELECT 1" }), baseCtx);
    assert.equal(r.ok, false);
    assert.match(r.text, /No data connection/);
  }

  {
    const tools = createAgentTools({
      ctx: { ...baseCtx, mode: "maintenance" as const },
      requestProposal: async () => false,
    });
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["save_skill"],
    );
  }
  {
    const r = await dispatchTool(
      "search_sql_usage",
      JSON.stringify({ table: "threed.unrelated" }),
      {
        ...baseCtx,
        mode: "maintenance" as const,
        maintenanceTables: ["threed.evidenced"],
        maintenanceRelatedNotes: { paths: new Set(), reads: 0 },
      },
    );
    assert.equal(r.ok, false);
    assert.match(r.text, /only for tables in this run's evidence/i);
  }
  {
    const maintenanceRelatedNotes = { paths: new Set(["note.md"]), reads: 0 };
    const ctx = { ...baseCtx, mode: "maintenance" as const, maintenanceRelatedNotes };
    for (let index = 0; index < 3; index++) {
      const r = await dispatchTool("read_note", JSON.stringify({ path: "note.md" }), ctx);
      assert.equal(r.ok, true, r.text);
    }
    const r = await dispatchTool("read_note", JSON.stringify({ path: "note.md" }), ctx);
    assert.equal(r.ok, false);
    assert.match(r.text, /at most three notes/i);
  }

  // table 是“任意读写用法”快捷参数，必须分别查询读、写倒排后合并。
  {
    const filters: unknown[] = [];
    const ctx = {
      ...baseCtx,
      sqlIndex: {
        query: async (filter: unknown) => {
          filters.push(filter);
          return [{
            path: join(root, "note.md"),
            relPath: "note.md",
            blockIndex: 0,
            line: 1,
            blockId: null,
            connectionName: null,
            dialect: null,
            runDate: null,
            operations: ["insert" as const],
            snippet: "INSERT INTO target SELECT * FROM source",
          }];
        },
      },
    };
    const r = await dispatchTool(
      "search_sql_usage",
      JSON.stringify({ table: "threed.source" }),
      ctx,
    );
    assert.equal(r.ok, true);
    assert.deepEqual(filters, [
      { readTable: "threed.source", maxHits: 60 },
      { writeTable: "threed.source", maxHits: 60 },
    ]);
    assert.match(r.text, /"matchedBlocks": 1/);
  }
  {
    const olderPath = join(root, "a-older.md");
    const newerPath = join(root, "z-newer.md");
    await Promise.all([
      writeFile(olderPath, "# Older\n"),
      writeFile(newerPath, "# Newer\n"),
    ]);
    await Promise.all([
      utimes(olderPath, new Date("2026-01-01"), new Date("2026-01-01")),
      utimes(newerPath, new Date("2026-07-01"), new Date("2026-07-01")),
    ]);
    const ctx = {
      ...baseCtx,
      sqlIndex: {
        query: async () => [
          {
            path: olderPath,
            relPath: "a-older.md",
            blockIndex: 0,
            line: 1,
            blockId: null,
            connectionName: null,
            dialect: null,
            runDate: null,
            operations: ["select" as const],
            snippet: "SELECT * FROM threed.source",
          },
          {
            path: newerPath,
            relPath: "z-newer.md",
            blockIndex: 0,
            line: 1,
            blockId: null,
            connectionName: null,
            dialect: null,
            runDate: null,
            operations: ["select" as const],
            snippet: "SELECT * FROM threed.source",
          },
        ],
      },
    };
    const r = await dispatchTool("search_sql_usage", JSON.stringify({ table: "threed.source" }), ctx);
    assert.equal(r.ok, true);
    assert.ok(r.text.indexOf('"path": "z-newer.md"') < r.text.indexOf('"path": "a-older.md"'), r.text);
  }

  // 有连接时，改动类语句默认直接拦截，不走 requestProposal / registry.execute
  const withConnection = {
    ...baseCtx,
    connectionName: "demo",
    connection: { kind: "fake-kind", config: {} },
    requestProposal: async () => {
      throw new Error("requestProposal should not be called when mutations are blocked by default");
    },
  };

  // create_chart 只能引用本轮真实 run_sql 结果，并校验字段。
  {
    const chartRuns = new Map();
    const ctx = {
      ...withConnection,
      chartRuns,
      connector: {
        ...fakeConnector,
        execute: async () => ({
          kind: "query" as const,
          columns: [
            { name: "category", typeName: "VARCHAR" },
            { name: "count", typeName: "BIGINT" },
          ],
          rows: [["A", 12], ["B", 8]],
          elapsedMs: 1,
        }),
      },
      recordRun: async () => {},
    };
    const query = await dispatchTool("run_sql", JSON.stringify({ sql: "SELECT category, count FROM demo" }), ctx);
    assert.equal(query.ok, true, query.text);
    const runId = JSON.parse(query.text).runId as string;
    const chart = await dispatchTool("create_chart", JSON.stringify({
      runId,
      type: "bar",
      title: "Demo",
      category: "category",
      value: "count",
    }), ctx);
    assert.equal(chart.ok, true, chart.text);
    assert.match(chart.text, /```stela-chart/);
    const invalid = await dispatchTool("create_chart", JSON.stringify({
      runId,
      type: "bar",
      category: "missing",
      value: "count",
    }), ctx);
    assert.equal(invalid.ok, false);
    assert.match(invalid.text, /does not exist/);
  }

  {
    const r = await dispatchTool("run_sql", JSON.stringify({ sql: "DELETE FROM orders" }), withConnection);
    assert.equal(r.ok, false);
    assert.match(r.text, /blocked by default/);
  }

  // 多语句一律拒绝
  {
    const r = await dispatchTool(
      "run_sql",
      JSON.stringify({ sql: "SELECT 1; DROP TABLE orders" }),
      withConnection,
    );
    assert.equal(r.ok, false);
    assert.match(r.text, /one statement at a time/);
  }

  // allowMutations=true + 用户 reject → 不执行，返回 rejected 文案
  {
    let asked = false;
    const ctx = {
      ...withConnection,
      aiSettings: { ...AI_SETTINGS, agentAllowMutations: true },
      requestProposal: async () => {
        asked = true;
        return false;
      },
    };
    const r = await dispatchTool("run_sql", JSON.stringify({ sql: "UPDATE orders SET x=1" }), ctx);
    assert.equal(asked, true);
    assert.equal(r.ok, false);
    assert.match(r.text, /rejected/);
  }

  // search_vault / read_note 直接对真实 vault 目录操作
  {
    const r = await dispatchTool("search_vault", JSON.stringify({ keyword: "Agent target" }), baseCtx);
    assert.equal(r.ok, true);
    assert.match(r.text, /note\.md/);
  }
  {
    const r = await dispatchTool("read_note", JSON.stringify({ path: join(root, "note.md") }), baseCtx);
    assert.equal(r.ok, true);
    assert.match(r.text, /Agent target note/);
  }
  {
    // 越界路径被 ensureWithinVault 拦截
    const r = await dispatchTool("read_note", JSON.stringify({ path: "/etc/passwd" }), baseCtx);
    assert.equal(r.ok, false);
  }

  // 计划工具只能按顺序完成当前步骤，并要求完成证据。
  {
    const create = await dispatchTool(
      "create_plan",
      JSON.stringify({
        steps: [
          { id: "scope", title: "Scope", intent: "Define the metric", acceptance: "Definition found" },
          { id: "trend", title: "Trend", intent: "Measure daily values", acceptance: "Result available" },
        ],
      }),
      baseCtx,
    );
    assert.equal(create.ok, true);
    const skipAhead = await dispatchTool(
      "update_plan",
      JSON.stringify({ stepId: "trend", status: "completed", evidence: "run_2" }),
      baseCtx,
    );
    assert.equal(skipAhead.ok, false);
    const complete = await dispatchTool(
      "update_plan",
      JSON.stringify({ stepId: "scope", status: "completed", evidence: "metrics.md" }),
      baseCtx,
    );
    assert.equal(complete.ok, true);
    const plan = await dispatchTool("get_plan", "{}", baseCtx);
    assert.equal(plan.ok, true);
    assert.match(plan.text, /"status": "running"/);
  }

  // 同一毫秒内并行 SQL 也必须有不同的审计 runId，才能作为计划证据引用。
  {
    const runIds: string[] = [];
    const originalNow = Date.now;
    Date.now = () => 1234;
    try {
      const ctx = {
        ...withConnection,
        connector: {
          ...fakeConnector,
          execute: async () => ({ kind: "query" as const, columns: [], rows: [], elapsedMs: 1 }),
        },
        recordRun: async (run: { runId: string }) => {
          runIds.push(run.runId);
        },
      };
      await Promise.all([
        dispatchTool("run_sql", JSON.stringify({ sql: "SELECT 1" }), ctx),
        dispatchTool("run_sql", JSON.stringify({ sql: "SELECT 2" }), ctx),
      ]);
    } finally {
      Date.now = originalNow;
    }
    assert.equal(new Set(runIds).size, 2);
  }

  // get_table_schema 必须把 connector.execute 传给 schema-context，否则 DESCRIBE 永远跑不到。
  {
    const executed: string[] = [];
    const ctx = {
      ...withConnection,
      connector: {
        listKinds: () => [],
        listDatabases: async () => ["threed"],
        listTables: async () => ["global_3d_normal_clustering_final_summary"],
        execute: async (_kind: string, _config: unknown, sql: string) => {
          executed.push(sql);
          if (sql.startsWith("SHOW CREATE")) throw new Error("unsupported");
          if (sql.startsWith("DESCRIBE")) {
            return {
              kind: "query" as const,
              columns: [
                { name: "Field", typeName: "VARCHAR" },
                { name: "Type", typeName: "VARCHAR" },
              ],
              rows: [["id", "BIGINT"]],
              elapsedMs: 1,
            };
          }
          return { kind: "query" as const, columns: [], rows: [], elapsedMs: 1 };
        },
      },
    };
    const r = await dispatchTool(
      "get_table_schema",
      JSON.stringify({ tables: ["threed.global_3d_normal_clustering_final_summary"] }),
      ctx,
    );
    assert.equal(r.ok, true);
    assert.match(r.text, /"name": "id"/);
    assert.ok(executed.some((sql) => sql.startsWith("DESCRIBE")));
  }

  // propose_edit：reject 不写盘，approve 才写盘
  {
    const r = await dispatchTool(
      "propose_edit",
      JSON.stringify({ path: join(root, "note.md"), newContent: "rejected content" }),
      { ...baseCtx, requestProposal: async () => false },
    );
    assert.equal(r.ok, false);
    assert.match(r.text, /rejected/);
  }
  {
    const r = await dispatchTool(
      "propose_edit",
      JSON.stringify({ path: join(root, "note.md"), newContent: "approved content" }),
      { ...baseCtx, requestProposal: async () => true },
    );
    assert.equal(r.ok, true);
    const written = await dispatchTool("read_note", JSON.stringify({ path: join(root, "note.md") }), baseCtx);
    assert.match(written.text, /approved content/);
  }

  // 自动维护可创建新 Skill，但不能静默覆盖或归档已有知识。
  {
    const content = `---
name: verified-gotcha
description: Verified reusable SQL gotcha.
category: sql-dialect
tags: [sql, gotcha]
---

## Scope
StarRocks SQL against the verified source table.

## Rule
Use the live schema type.

## Valid Pattern
Cast only after inspecting the live type.

## Verify
Inspect the live schema first.`;
    const maintenanceCtx = {
      ...baseCtx,
      mode: "maintenance" as const,
      skills: [],
      maintenanceSourcePaths: ["note.md"],
      maintenanceTables: ["threed.verified"],
    };
    const created = await dispatchTool(
      "save_skill",
      JSON.stringify({ name: "verified-gotcha", content, reason: "Verified by live schema." }),
      maintenanceCtx,
    );
    assert.equal(created.ok, true);
    const skillUsage: Array<{ type: string; source: string; name: string; category: string | null }> = [];
    const usageCtx = {
      ...baseCtx,
      skills: maintenanceCtx.skills,
      onSkillUsage: (record: typeof skillUsage[number]) => skillUsage.push(record),
    };
    const searched = await dispatchTool(
      "search_skills",
      JSON.stringify({ query: "verified gotcha" }),
      usageCtx,
    );
    assert.equal(searched.ok, true);
    const loaded = await dispatchTool(
      "load_skill",
      JSON.stringify({ name: "verified-gotcha" }),
      usageCtx,
    );
    assert.equal(loaded.ok, true);
    assert.deepEqual(skillUsage.map(({ type, source, name }) => ({ type, source, name })), [
      { type: "candidate", source: "search", name: "verified-gotcha" },
      { type: "loaded", source: "load", name: "verified-gotcha" },
    ]);
    const overwrite = await dispatchTool(
      "save_skill",
      JSON.stringify({ name: "verified-gotcha", content, reason: "Must not overwrite automatically." }),
      maintenanceCtx,
    );
    assert.equal(overwrite.ok, false);
    assert.match(overwrite.text, /cannot overwrite/i);
    const archived = await dispatchTool(
      "save_skill",
      JSON.stringify({ action: "archive", name: "verified-gotcha", reason: "Must not archive automatically." }),
      maintenanceCtx,
    );
    assert.equal(archived.ok, false);
    assert.match(archived.text, /cannot archive/i);
    const wrongDialect = await dispatchTool(
      "save_skill",
      JSON.stringify({
        name: "wrong-dialect",
        content: content.replace("verified-gotcha", "wrong-dialect").replace("[sql, gotcha]", "[postgresql, gotcha]"),
      }),
      { ...maintenanceCtx, maintenanceDialect: "starrocks" },
    );
    assert.equal(wrongDialect.ok, false);
    assert.match(wrongDialect.text, /does not match active SQL dialect/i);
    const runbook = await dispatchTool(
      "save_skill",
      JSON.stringify({
        name: "automatic-runbook",
        content: content
          .replaceAll("verified-gotcha", "automatic-runbook")
          .replace("category: sql-dialect", "category: analysis-runbook"),
      }),
      maintenanceCtx,
    );
    assert.equal(runbook.ok, false);
    assert.match(runbook.text, /cannot create analysis-runbook/i);
  }

  // 未知工具名不崩，返回错误文本
  {
    const chartNote = join(root, "chart-note.md");
    await writeFile(chartNote, "# Chart\n\n```runsql\nSELECT category, count FROM demo\n```\n");
    const chart = JSON.stringify({
      version: 1,
      type: "bar",
      source: { kind: "run", runId: "chart-run" },
      title: "Demo",
      category: "category",
      value: "count",
    });
    const saved = await dispatchTool(
      "save_chart_to_note",
      JSON.stringify({ path: "chart-note.md", runId: "chart-run", chart }),
      {
        ...baseCtx,
        resolveChartRun: async () => ({
          runId: "chart-run",
          blockId: "agent:test-run",
          sql: "SELECT category, count FROM demo",
          status: "ok" as const,
          message: null,
          startedAt: Date.now(),
          elapsedMs: 1,
          rowCount: 2,
          connectionName: "demo",
          notePath: null,
        }),
      },
    );
    assert.equal(saved.ok, true, saved.text);
    const content = await readFile(chartNote, "utf8");
    const fences = parseRunsqlFences(content);
    assert.equal(fences.length, 1, content);
    assert.equal(fences[0]?.detail?.chart?.source.kind, "block");
    assert.equal(fences[0]?.detail?.chart?.source.kind === "block" && fences[0].detail.chart.source.blockId, fences[0]?.blockId);
    assert.doesNotMatch(content, /```stela-chart/);

    const replaced = await dispatchTool(
      "save_chart_to_note",
      JSON.stringify({ path: "chart-note.md", runId: "chart-run", chart: chart.replace("Demo", "Updated") }),
      {
        ...baseCtx,
        resolveChartRun: async () => ({
          runId: "chart-run",
          blockId: "agent:test-run",
          sql: "SELECT category, count FROM demo",
          status: "ok" as const,
          message: null,
          startedAt: Date.now(),
          elapsedMs: 1,
          rowCount: 2,
          connectionName: "demo",
          notePath: null,
        }),
      },
    );
    assert.equal(replaced.ok, true, replaced.text);
    assert.equal(parseRunsqlFences(await readFile(chartNote, "utf8"))[0]?.detail?.chart?.title, "Updated");

    const duplicatePath = join(root, "chart-duplicate.md");
    await writeFile(
      duplicatePath,
      "```runsql\nSELECT category, count FROM demo\n```\n\n<detail>\n   <block-id>blk-first</block-id>\n</detail>\n\n```runsql\nSELECT category, count FROM demo\n```\n\n<detail>\n   <block-id>blk-last</block-id>\n</detail>\n",
    );
    const duplicate = await dispatchTool(
      "save_chart_to_note",
      JSON.stringify({ path: "chart-duplicate.md", runId: "chart-run", chart }),
      {
        ...baseCtx,
        resolveChartRun: async () => ({
          runId: "chart-run",
          blockId: "agent:test-run",
          sql: "SELECT category, count FROM demo",
          status: "ok" as const,
          message: null,
          startedAt: Date.now(),
          elapsedMs: 1,
          rowCount: 2,
          connectionName: "demo",
          notePath: null,
        }),
      },
    );
    assert.equal(duplicate.ok, true, duplicate.text);
    const duplicateFences = parseRunsqlFences(await readFile(duplicatePath, "utf8"));
    assert.equal(duplicateFences[0]?.detail?.chart, null);
    assert.equal(duplicateFences[1]?.detail?.chart?.source.kind === "block" && duplicateFences[1].detail.chart.source.blockId, "blk-last");

    const rejectedPath = join(root, "chart-rejected.md");
    await writeFile(rejectedPath, "# Keep\n");
    const rejected = await dispatchTool(
      "save_chart_to_note",
      JSON.stringify({ path: "chart-rejected.md", runId: "chart-run", chart }),
      {
        ...baseCtx,
        requestProposal: async () => false,
        resolveChartRun: async () => ({
          runId: "chart-run",
          blockId: "agent:test-run",
          sql: "SELECT category, count FROM demo",
          status: "ok" as const,
          message: null,
          startedAt: Date.now(),
          elapsedMs: 1,
          rowCount: 2,
          connectionName: "demo",
          notePath: null,
        }),
      },
    );
    assert.equal(rejected.ok, false);
    assert.equal(await readFile(rejectedPath, "utf8"), "# Keep\n");
  }

  {
    const r = await dispatchTool("not_a_real_tool", "{}", baseCtx);
    assert.equal(r.ok, false);
    assert.match(r.text, /Unknown tool/);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("agent-tools tests passed.");
