import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { AiSettings } from "@shared/types";

import { ExecutionPlanStore } from "./execution-plan";
import {
  createAgentTools,
  dispatchTool as dispatchToolRaw,
  proposalApprovalMode,
} from "./agent-tools";
import { updateAnalysisCanvasFlowLayout } from "../analysis-canvas";

/**
 * 这些场景块共用一个 ctx，但每块都代表一次独立 run，所以默认清掉连续失败计数。
 * 熔断本身由文件末尾的专用场景直接调 `dispatchToolRaw` 验证。
 */
const dispatchTool: typeof dispatchToolRaw = (name, rawArguments, ctx) => {
  ctx.run.toolFailureStreak.clear();
  return dispatchToolRaw(name, rawArguments, ctx);
};

const AI_SETTINGS = {
  providerMode: "openai-compatible",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  hasApiKey: true,
  contextWindow: 128_000,
  agentMaxIterations: 12,
  agentWallClockMs: 90_000,
  agentAllowMutations: false,
  agentAutoApplyEdits: false,
} satisfies AiSettings;

const root = await mkdtemp(join(tmpdir(), "stela-agent-tools-"));
try {
  assert.equal(proposalApprovalMode(false, "edit_note"), "manual");
  assert.equal(proposalApprovalMode(true, "edit_note"), "automatic");
  assert.equal(proposalApprovalMode(true, "runsql_rewrite"), "automatic");
  assert.equal(proposalApprovalMode(true, "mutation_sql"), "manual");
  assert.equal(proposalApprovalMode(true, "question"), "manual");

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
    run: { runId: "test-run", notePath: null, questionsAsked: 0, toolFailureStreak: new Map<string, number>() },
    recordRun: async () => {},
    requestProposal: async () => true,
    plan: new ExecutionPlanStore("test-run"),
    analysisRuns: new Map(),
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
    const tools = createAgentTools({
      ctx: { ...baseCtx, queryArtifacts: {} as never, pythonExecutor: {} as never },
      requestProposal: async () => false,
    });
    assert.equal(tools.length, 19, "the provider-facing tool list must remain compact");
    const pythonDescription = tools.find((tool) => tool.name === "execute_python")!.description;
    assert.match(pythonDescription, /Aliases are not variables/);
    assert.match(pythonDescription, /result is cleared before EVERY cell/);
    assert.doesNotMatch(pythonDescription, /semantic\.classify/);
    const semanticTools = createAgentTools({ ctx: {
      ...baseCtx, queryArtifacts: {} as never, pythonExecutor: {} as never,
      runSemantic: async () => { throw new Error("not invoked"); },
    }, requestProposal: async () => false });
    assert.match(semanticTools.find((tool) => tool.name === "execute_python")!.description,
      /semantic\.classify\/extract\/resolve.*load_skill name=semantic-analysis/);
    // Semantic-capable runs include the helper discovery contract (~220 chars).
    assert.ok(JSON.stringify(semanticTools).length <= 17_000, `semantic discovery stays within tool prompt budget: ${JSON.stringify(semanticTools).length}`);
    const serializedTools = JSON.stringify(tools);
    assert.ok(
      serializedTools.length <= 17_000,
      `provider-facing tools must stay <= 17000 chars, got ${serializedTools.length}`,
    );
    assert.equal(tools.some((tool) => tool.name === "list_catalog"), true);
    assert.equal(tools.some((tool) => tool.name === "plan"), true);
    for (const legacyName of ["list_databases", "list_tables", "create_plan", "update_plan", "get_plan"]) {
      assert.equal(tools.some((tool) => tool.name === legacyName), false, `${legacyName} is an internal alias only`);
    }
    const runQuery = tools.find((tool) => tool.name === "run_query");
    assert.equal(
      (runQuery?.parameters as { type?: string } | undefined)?.type,
      "object",
      "function providers require run_query parameters to have a top-level object schema",
    );
    const executePython = tools.find((tool) => tool.name === "execute_python");
    const sourceVariants = (
      executePython?.parameters as {
        properties?: { sources?: { items?: { anyOf?: Array<{ properties?: Record<string, unknown> }> } } };
      } | undefined
    )?.properties?.sources?.items?.anyOf ?? [];
    const sqlSource = sourceVariants.find((variant) => variant.properties?.language && variant.properties?.query);
    const mongoSource = sourceVariants.find((variant) => variant.properties?.language && variant.properties?.collection);
    assert.ok(sqlSource, "execute_python exposes a distinct SQL source contract");
    assert.ok(mongoSource, "execute_python exposes a distinct MongoDB source contract");
    assert.equal("limit" in (sqlSource.properties ?? {}), false, "SQL source must not advertise MongoDB limit");
    assert.equal("limit" in (mongoSource.properties ?? {}), true, "MongoDB source keeps its top-level limit");
    const searchSkills = tools.find((tool) => tool.name === "search_skills");
    assert.ok(searchSkills);
    const required = (searchSkills.parameters as { required?: string[] }).required ?? [];
    assert.equal(required.includes("query"), false, "search_skills query must remain optional for browsing");
    const searchSkillsResult = await searchSkills.execute("test-search-skills", {});
    assert.deepEqual(searchSkillsResult.details, {}, "tool details must not duplicate model-visible content");
    assert.match(searchSkillsResult.content[0]?.type === "text" ? searchSkillsResult.content[0].text : "", /"skills"/);
    assert.equal(tools.some((tool) => tool.name === "revise_plan"), false);
    assert.equal(tools.some((tool) => tool.name === "finalize_analysis"), false);
    const createChart = tools.find((tool) => tool.name === "create_chart");
    const serializedChart = JSON.stringify(createChart);
    assert.ok(
      serializedChart.length <= 2_800,
      `create_chart must stay <= 2800 chars, got ${serializedChart.length}`,
    );
  }
  {
    const emptySkills = await dispatchTool("search_skills", "{}", baseCtx);
    assert.equal(emptySkills.ok, true);
    assert.deepEqual(JSON.parse(emptySkills.text), {
      skills: [],
      totalSkills: 0,
      totalMatches: 0,
      nextOffset: null,
      truncated: false,
      omittedStale: 0,
    });
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

  // list_catalog auto-selects a sole database and returns an actionable domain rejection for ambiguity.
  {
    const selected: Array<string | null | undefined> = [];
    const databases = await dispatchTool("list_catalog", JSON.stringify({ level: "databases" }), {
      ...withConnection,
      connector: { ...fakeConnector, listDatabases: async () => ["analytics"] },
    });
    assert.equal(databases.ok, true);
    assert.deepEqual(JSON.parse(databases.text).databases, ["analytics"]);
    const single = await dispatchTool("list_catalog", JSON.stringify({ level: "tables" }), {
      ...withConnection,
      connector: {
        ...fakeConnector,
        listDatabases: async () => ["analytics"],
        listTables: async (_kind: string, _config: unknown, database?: string | null) => {
          selected.push(database);
          return ["facts"];
        },
      },
    });
    assert.equal(single.ok, true);
    assert.equal(JSON.parse(single.text).database, "analytics");
    assert.deepEqual(selected, ["analytics"]);
    const ambiguous = await dispatchTool("list_catalog", JSON.stringify({ level: "tables" }), {
      ...withConnection,
      connector: { ...fakeConnector, listDatabases: async () => ["a", "b"] },
    });
    assert.equal(ambiguous.ok, true);
    assert.equal(JSON.parse(ambiguous.text).accepted, false);
    assert.equal(JSON.parse(ambiguous.text).reason, "database_required");
    assert.match(JSON.parse(ambiguous.text).instruction, /list_catalog/);
  }

  // Host byte-bounds a giant cell even when a connector ignores previewMaxBytes.
  {
    let recordedRows: unknown[][] = [];
    const giant = "x".repeat(100_000);
    const bounded = await dispatchTool("run_query", JSON.stringify({
      language: "sql",
      query: "SELECT document FROM facts",
    }), {
      ...withConnection,
      connector: {
        ...fakeConnector,
        executeUnbounded: async () => ({
          kind: "query" as const,
          columns: [{ name: "document", typeName: "TEXT" }],
          rows: [[giant]],
          elapsedMs: 1,
        }),
      },
      recordRun: async (run: { rows: unknown[][] }) => { recordedRows = run.rows; },
    });
    assert.equal(bounded.ok, true, bounded.text);
    const payload = JSON.parse(bounded.text) as {
      result: {
        rows?: string[][];
        sampleRows?: string[][];
        previewTruncated: boolean;
        previewTruncatedBy: string[];
      };
    };
    assert.equal(payload.result.previewTruncated, true);
    assert.deepEqual(payload.result.previewTruncatedBy, ["bytes"]);
    // Truncated results are never presented as countable `rows`.
    assert.equal(payload.result.rows, undefined);
    assert.ok((payload.result.sampleRows?.[0]?.[0]?.length ?? 0) < 5_000);
    assert.ok((recordedRows[0]?.[0] as string).length < 5_000);
  }

  // run_query exposes structured MongoDB find/aggregate and rejects unsafe operators/stages.
  {
    const received: unknown[] = [];
    const recorded: Array<{ queryLanguage?: string; sql: string }> = [];
    const skillEvidence = { notePaths: new Set<string>(), tables: new Set<string>() };
    const ctx = {
      ...withConnection,
      explicitSkillMaintenance: true,
      skillEvidence,
      connection: { kind: "mongodb", config: {} },
      connector: {
        ...fakeConnector,
        listKinds: () => [{
          kind: "mongodb",
          displayName: "MongoDB",
          configSchema: {},
          defaultConfig: {},
          subprocess: false,
          queryLanguages: ["mongodb" as const],
          mongoOperations: ["find" as const, "aggregate" as const],
        }],
        executeQuery: async (_kind: string, _config: unknown, query: unknown) => {
          received.push(query);
          return {
            kind: "query" as const,
            columns: [{ name: "name", typeName: "TEXT" }],
            rows: [["Stela"]],
            elapsedMs: 2,
          };
        },
      },
      recordRun: async (run: { queryLanguage?: string; sql: string }) => {
        recorded.push({ queryLanguage: run.queryLanguage, sql: run.sql });
      },
    };
    const query = await dispatchTool("run_query", JSON.stringify({
      language: "mongodb",
      database: "catalog",
      collection: "books",
      filter: { rating: { $gte: 4 } },
      projection: { name: 1, _id: 0 },
      limit: 25,
    }), ctx);
    assert.equal(query.ok, true, query.text);
    assert.deepEqual(received, [{
      language: "mongodb",
      database: "catalog",
      collection: "books",
      filter: { rating: { $gte: 4 } },
      projection: { name: 1, _id: 0 },
      limit: 25,
    }]);
    assert.equal(recorded[0]?.queryLanguage, "mongodb");
    assert.match(recorded[0]?.sql ?? "", /\"collection\":\"books\"/);
    assert.deepEqual([...skillEvidence.tables], ["catalog.books"]);

    const aggregate = await dispatchTool("run_query", JSON.stringify({
      language: "mongodb",
      operation: "aggregate",
      database: "catalog",
      collection: "books",
      pipeline: [
        { $match: { rating: { $gte: 4 } } },
        { $group: { _id: "$author", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ],
      limit: 10,
    }), ctx);
    assert.equal(aggregate.ok, true, aggregate.text);
    assert.deepEqual(received[1], {
      language: "mongodb",
      operation: "aggregate",
      database: "catalog",
      collection: "books",
      pipeline: [
        { $match: { rating: { $gte: 4 } } },
        { $group: { _id: "$author", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ],
      limit: 10,
    });

    const unsafeAggregate = await dispatchTool("run_query", JSON.stringify({
      language: "mongodb",
      operation: "aggregate",
      collection: "books",
      pipeline: [{ $lookup: { from: "authors", as: "authors" } }],
    }), ctx);
    assert.equal(unsafeAggregate.ok, false);
    assert.match(unsafeAggregate.text, /stage '\$lookup' is not allowed/);

    const unsafe = await dispatchTool("run_query", JSON.stringify({
      language: "mongodb",
      collection: "books",
      filter: { nested: { $where: "return true" } },
    }), ctx);
    assert.equal(unsafe.ok, false);
    assert.match(unsafe.text, /server-side JavaScript/);
    assert.equal(received.length, 2);

    const unknownLanguage = await dispatchTool("run_query", JSON.stringify({
      language: "javascript",
      query: "return db.books.find({})",
    }), ctx);
    assert.equal(unknownLanguage.ok, false);
    assert.match(unknownLanguage.text, /unsupported query language/);

    // A Python source is handed the complete artifact, so an omitted limit must mean complete
    // rather than run_query's 200-row preview default.
    const previewDefault = await dispatchTool("run_query", JSON.stringify({
      language: "mongodb",
      collection: "books",
    }), ctx);
    assert.equal(previewDefault.ok, true, previewDefault.text);
    assert.equal((received[2] as { limit?: number | null }).limit, 200);
  }

  // MongoDB Python sources default to the complete result and flag a result that stops at its cap.
  {
    const received: Array<{ limit?: number | null }> = [];
    let artifactRows = 1;
    const descriptor = {
      runId: "placeholder",
      sessionId: "session-1",
      format: "jsonl" as const,
      mode: "jsonl-buffered" as const,
      columns: [{ name: "name", typeName: "TEXT" }],
      rowCount: 1,
      byteSize: 12,
      createdAt: 1,
      lastAccessedAt: 1,
    };
    const ctx = {
      ...withConnection,
      run: { runId: "mongo-sources", sessionId: "session-1", notePath: null, questionsAsked: 0, toolFailureStreak: new Map<string, number>() },
      connection: { kind: "mongodb", config: {} },
      connector: {
        ...fakeConnector,
        listKinds: () => [{
          kind: "mongodb",
          displayName: "MongoDB",
          configSchema: {},
          defaultConfig: {},
          subprocess: false,
          queryLanguages: ["mongodb" as const],
          mongoOperations: ["find" as const, "aggregate" as const],
        }],
        executeQuery: async (_kind: string, _config: unknown, query: { limit?: number | null }) => {
          received.push(query);
          return {
            kind: "query" as const,
            columns: descriptor.columns,
            rows: Array.from({ length: artifactRows }, (_, index) => [`doc-${index}`]),
            elapsedMs: 1,
          };
        },
      },
      queryArtifacts: {
        createTarget: async () => { throw new Error("streaming path should not be used"); },
        finalize: async () => { throw new Error("streaming path should not be used"); },
        writeBuffered: async (input: { runId: string }) => ({
          ...descriptor,
          runId: input.runId,
          rowCount: artifactRows,
        }),
        resolve: async () => null,
        discard: async () => {},
      },
      pythonExecutor: {
        execute: async () => ({
          ok: true,
          stdout: "",
          value: { kind: "scalar" as const, value: 1 },
          elapsedMs: 1,
        }),
      },
      analysisRuns: new Map(),
    };

    artifactRows = 3;
    const complete = await dispatchTool("execute_python", JSON.stringify({
      sources: [{ alias: "books", language: "mongodb", collection: "books" }],
      code: "result = len(to_df('books'))",
    }), ctx);
    assert.equal(complete.ok, true, complete.text);
    assert.equal(received[0]?.limit, null, "an omitted source limit asks the connector for everything");
    assert.equal(
      (JSON.parse(complete.text) as { incompleteSources?: string }).incompleteSources,
      undefined,
      "a complete source carries no truncation warning",
    );

    // The real truncation risk is a model-chosen small limit, not an omitted one.
    artifactRows = 50;
    const capped = await dispatchTool("execute_python", JSON.stringify({
      sources: [{ alias: "books", language: "mongodb", collection: "books", limit: 50 }],
      code: "result = len(to_df('books'))",
    }), ctx);
    assert.equal(capped.ok, true, capped.text);
    assert.equal(received[1]?.limit, 50);
    const cappedPayload = JSON.parse(capped.text) as { incompleteSources?: string };
    assert.match(cappedPayload.incompleteSources ?? "", /books \(limit 50\) returned exactly the requested limit/);
    assert.match(cappedPayload.incompleteSources ?? "", /omit limit for the complete result/);

    artifactRows = 20;
    const underCap = await dispatchTool("execute_python", JSON.stringify({
      sources: [{ alias: "books", language: "mongodb", collection: "books", limit: 50 }],
      code: "result = len(to_df('books'))",
    }), ctx);
    assert.equal(underCap.ok, true, underCap.text);
    assert.equal(
      (JSON.parse(underCap.text) as { incompleteSources?: string }).incompleteSources,
      undefined,
      "a source that stops short of its limit is complete",
    );
  }

  // create_chart 只能引用本轮真实 run_query 结果，并校验字段。
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
      title: "Demo",
      preset: "ranking",
      fields: [
        { id: "category", field: "category", type: "nominal" },
        { id: "count", field: "count", type: "quantitative", format: { kind: "compact" } },
      ],
      layers: [{ mark: "bar", encoding: { x: "count", y: "category" } }],
    }), ctx);
    assert.equal(chart.ok, true, chart.text);
    assert.match(chart.text, /```stela-chart/);
    const invalid = await dispatchTool("create_chart", JSON.stringify({
      runId,
      preset: "ranking",
      fields: [
        { id: "category", field: "missing", type: "nominal" },
        { id: "count", field: "count", type: "quantitative" },
      ],
      layers: [{ mark: "bar", encoding: { x: "count", y: "category" } }],
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

  // 计划工具是只写记账：乱序、重复、未知步骤都只回执，不失败。
  {
    const create = await dispatchTool(
      "plan",
      JSON.stringify({
        action: "create",
        steps: [
          { id: "scope", title: "Scope", intent: "Define the metric", acceptance: "Definition found" },
          { id: "trend", title: "Trend", intent: "Measure daily values", acceptance: "Result available" },
        ],
      }),
      baseCtx,
    );
    assert.equal(create.ok, true);
    assert.equal(JSON.parse(create.text).created, true);

    const duplicate = await dispatchTool(
      "plan",
      JSON.stringify({ action: "create", steps: [{ id: "other", title: "Other", intent: "Other", acceptance: "Other" }] }),
      baseCtx,
    );
    assert.equal(duplicate.ok, true);
    assert.equal(JSON.parse(duplicate.text).created, false);

    // Completing a later step out of order is recorded, not rejected.
    const skipAhead = await dispatchTool(
      "plan",
      JSON.stringify({ action: "update", stepId: "trend", status: "completed", evidence: "run_2" }),
      baseCtx,
    );
    assert.equal(skipAhead.ok, true, skipAhead.text);

    // Evidence stays optional, so a missing line never costs a turn.
    const noEvidence = await dispatchTool(
      "plan",
      JSON.stringify({ action: "update", stepId: "scope", status: "completed" }),
      baseCtx,
    );
    assert.equal(noEvidence.ok, true, noEvidence.text);

    const unknown = await dispatchTool(
      "plan",
      JSON.stringify({ action: "update", stepId: "nope", status: "completed" }),
      baseCtx,
    );
    assert.equal(unknown.ok, true);
    assert.match(JSON.parse(unknown.text).note, /Unknown plan step 'nope'/);

    const plan = await dispatchTool("plan", JSON.stringify({ action: "get" }), baseCtx);
    assert.equal(plan.ok, true);
    assert.doesNotMatch(plan.text, /"status": "running"/);
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

  // Agent 可显式选择另一个 Vault connection；沙箱内 query() 自己取全量数据。
  {
    const executedConnections: string[] = [];
    const recorded: Array<{ connectionName: string; rowCount: number }> = [];
    const sandboxDescriptors: Array<{ rowCount: number }> = [];
    let artifactRunId = "";
    let pythonAliases: string[] = [];
    const descriptor = {
      runId: "placeholder",
      sessionId: "session-1",
      format: "jsonl" as const,
      mode: "jsonl-buffered" as const,
      columns: [{ name: "value", typeName: "INTEGER" }],
      rowCount: 3,
      byteSize: 27,
      createdAt: 1,
      lastAccessedAt: 1,
    };
    const ctx = {
      ...withConnection,
      connections: {
        demo: { kind: "demo-kind", config: {} },
        warehouse: { kind: "warehouse-kind", config: { database: "analytics" } },
      },
      connectionDialects: { demo: "SQLite", warehouse: "PostgreSQL" },
      run: { runId: "cross-connection", sessionId: "session-1", notePath: null, questionsAsked: 0, toolFailureStreak: new Map<string, number>() },
      connector: {
        ...fakeConnector,
        listKinds: () => [],
        executeUnbounded: async (kind: string) => {
          executedConnections.push(kind);
          return {
            kind: "query" as const,
            columns: descriptor.columns,
            rows: [[1], [2], [3]],
            elapsedMs: 2,
          };
        },
      },
      queryArtifacts: {
        createTarget: async () => { throw new Error("streaming path should not be used"); },
        finalize: async () => { throw new Error("streaming path should not be used"); },
        writeBuffered: async (input: { runId: string }) => {
          artifactRunId = input.runId;
          return { ...descriptor, runId: input.runId };
        },
        resolve: async (_vaultPath: string, sessionId: string, runId: string) =>
          sessionId === "session-1" && runId === artifactRunId
            ? { ...descriptor, runId }
            : null,
        discard: async () => {},
      },
      pythonExecutor: {
        execute: async (input: {
          artifacts: Record<string, unknown>;
          runQuery?: (arg: { connectionName: string; request: string }) => Promise<{ rowCount: number }>;
        }) => {
          pythonAliases = Object.keys(input.artifacts);
          const fetched = await input.runQuery?.({
            connectionName: "warehouse",
            request: JSON.stringify({ language: "sql", query: "SELECT value FROM facts" }),
          });
          if (fetched) sandboxDescriptors.push(fetched);
          return {
            ok: true,
            stdout: "",
            value: { kind: "scalar" as const, value: 6 },
            elapsedMs: 3,
          };
        },
      },
      recordRun: async (run: { connectionName: string; rowCount: number }) => {
        recorded.push({ connectionName: run.connectionName, rowCount: run.rowCount });
      },
      analysisRuns: new Map(),
    };
    const query = await dispatchTool(
      "run_sql",
      JSON.stringify({ sql: "SELECT value FROM facts", connectionName: "warehouse" }),
      ctx,
    );
    assert.equal(query.ok, true, query.text);
    const queryPayload = JSON.parse(query.text) as {
      runId: string;
      connectionName: string;
      result: { rowCount: number };
    };
    assert.deepEqual(executedConnections, ["warehouse-kind"]);
    assert.equal(queryPayload.connectionName, "warehouse");
    assert.equal(queryPayload.result.rowCount, 3);
    assert.equal(ctx.analysisRuns.get(queryPayload.runId)?.tables[0], "facts");
    assert.deepEqual(recorded, [{ connectionName: "warehouse", rowCount: 3 }]);

    // Queries known before execution are staged by alias; a dynamic query may
    // still use the sandbox bridge in the same fresh Python call.
    const python = await dispatchTool(
      "execute_python",
      JSON.stringify({
        sources: [{
          alias: "facts",
          connectionName: "warehouse",
          database: "analytics",
          language: "sql",
          query: "SELECT value FROM facts",
        }],
        code: "result = 6",
      }),
      ctx,
    );
    assert.equal(python.ok, true, python.text);
    assert.deepEqual(pythonAliases, ["facts"]);
    const pythonPayload = JSON.parse(python.text) as { runId: string; result: { value: number } };
    assert.equal(pythonPayload.result.value, 6);
    assert.deepEqual(sandboxDescriptors.map((item) => item.rowCount), [3]);
    assert.deepEqual(
      ctx.analysisRuns.get(pythonPayload.runId)?.sourceRunIds.length,
      2,
      "staged and dynamic queries are both credited as this Python run's sources",
    );

    let invalidPythonStarts = 0;
    const invalidCtx = {
      ...ctx,
      pythonExecutor: {
        execute: async () => {
          invalidPythonStarts += 1;
          return {
            ok: true,
            stdout: "",
            value: { kind: "none" as const },
            elapsedMs: 1,
          };
        },
      },
    };
    const invalidSource = await dispatchTool(
      "execute_python",
      JSON.stringify({
        sources: [{ alias: "docs", language: "mongodb", database: "content" }],
        code: "result = 1",
      }),
      invalidCtx,
    );
    assert.equal(invalidSource.ok, false);
    assert.match(invalidSource.text, /sources\[0\] \(docs\): collection must be a non-empty string/);
    const connectorCallsBeforeInvalidLimit = executedConnections.length;
    const invalidSqlLimit = await dispatchTool(
      "execute_python",
      JSON.stringify({
        sources: [{
          alias: "rows",
          language: "sql",
          query: "SELECT updated_at FROM analytics.events",
          limit: 10_000,
        }],
        code: "result = len(to_df('rows'))",
      }),
      invalidCtx,
    );
    assert.equal(invalidSqlLimit.ok, false);
    assert.match(invalidSqlLimit.text, /sql source does not accept 'limit'/i);
    assert.match(invalidSqlLimit.text, /Put LIMIT inside the SQL query; nothing was executed/);
    assert.equal(
      executedConnections.length,
      connectorCallsBeforeInvalidLimit,
      "a misplaced SQL limit is rejected before connector execution",
    );
    const duplicateAlias = await dispatchTool(
      "execute_python",
      JSON.stringify({
        sources: [
          { alias: "facts", language: "sql", query: "SELECT 1" },
          { alias: "facts", language: "sql", query: "SELECT 2" },
        ],
        code: "result = 1",
      }),
      invalidCtx,
    );
    assert.equal(duplicateAlias.ok, false);
    assert.match(duplicateAlias.text, /alias 'facts' is duplicated/);
    assert.equal(invalidPythonStarts, 0, "invalid sources do not start Python");

    const noResult = await dispatchTool(
      "execute_python",
      JSON.stringify({ code: "print('probe only')" }),
      invalidCtx,
    );
    assert.equal(noResult.ok, true, noResult.text);
    const noResultPayload = JSON.parse(noResult.text) as { instruction?: string };
    assert.match(noResultPayload.instruction ?? "", /No structured result was assigned/);
    assert.match(noResultPayload.instruction ?? "", /Reuse the workspace/);

    const statelessFailure = await dispatchTool(
      "execute_python",
      JSON.stringify({ code: "result = docs" }),
      {
        ...ctx,
        pythonExecutor: {
          execute: async () => ({
            ok: false,
            stdout: "",
            value: { kind: "none" as const },
            elapsedMs: 1,
            error: "NameError: name 'docs' is not defined",
          }),
        },
      },
    );
    assert.equal(statelessFailure.ok, false);
    assert.match(statelessFailure.text, /inspect the workspace snapshot/);

    for (const missing of ["docs", "result"]) {
      const failure = await dispatchTool("execute_python", JSON.stringify({ code: `result = ${missing}` }), {
        ...ctx,
        pythonExecutor: { execute: async () => ({
          ok: false, stdout: "", value: { kind: "none" as const }, elapsedMs: 1,
          error: `NameError: name '${missing}' is not defined`,
          workspace: { generation: "fixture", status: "partial_mutation_possible" as const,
            variables: [], refreshedAliases: [], sources: [
              { alias: "docs", version: "source-run", readAt: "fixture", rowCount: 3 },
            ] },
        }) },
      });
      const payload = JSON.parse(failure.text) as { guidance: string };
      assert.equal(failure.ok, false);
      if (missing === "docs") {
        assert.match(payload.guidance, /registered source alias, not a Python variable/);
        assert.ok(payload.guidance.includes('to_df("docs")'));
        assert.match(payload.guidance, /do not reset or reload/);
      } else assert.match(payload.guidance, /per-cell output slot, cleared before every cell/);
    }

    // Mutations are refused in the main process even with mutations enabled.
    sandboxDescriptors.length = 0;
    const mutating = await dispatchTool(
      "execute_python",
      JSON.stringify({ code: "result = 1" }),
      {
        ...ctx,
        aiSettings: { ...ctx.aiSettings, agentAllowMutations: true },
        pythonExecutor: {
          execute: async (input: {
            runQuery?: (arg: { connectionName: string; request: string }) => Promise<unknown>;
          }) => {
            let refusal = "";
            try {
              await input.runQuery?.({
                connectionName: "warehouse",
                request: JSON.stringify({ language: "sql", query: "UPDATE facts SET value = 1" }),
              });
            } catch (error) {
              refusal = error instanceof Error ? error.message : String(error);
            }
            return {
              ok: true,
              stdout: "",
              value: { kind: "scalar" as const, value: refusal },
              elapsedMs: 1,
            };
          },
        },
      },
    );
    assert.equal(mutating.ok, true, mutating.text);
    assert.match(JSON.parse(mutating.text).result.value, /blocked|not allowed|rejected/i);

    const toolNames = createAgentTools({ ctx, requestProposal: async () => false }).map((tool) => tool.name);
    assert.ok(toolNames.includes("execute_python"));
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
    assert.equal(JSON.parse(r.text).tables[0].columns, "id:BIGINT");
    assert.ok(executed.some((sql) => sql.startsWith("DESCRIBE")));
  }

  // 宽表回归探测器：两张 329 列的表必须一次装完。旧版撞 parseColumnsFromDdl 的 80
  // 列隐藏上限 + 冗余 ddlSnippet，模型看到残缺列清单就绕道 information_schema。
  {
    const wideColumns = Array.from({ length: 329 }, (_, i) => ({
      name: `col_${String(i).padStart(3, "0")}_metric_value`,
      type: "varchar(255)",
      comment: `业务字段第 ${i} 列的中文注释说明`,
    }));
    const ddlFor = (table: string) =>
      [
        `CREATE TABLE \`${table}\` (`,
        wideColumns
          .map((column) => `  \`${column.name}\` ${column.type} NULL COMMENT "${column.comment}"`)
          .join(",\n"),
        ') ENGINE=OLAP DUPLICATE KEY(`col_000_metric_value`) DISTRIBUTED BY HASH(`col_000_metric_value`) BUCKETS 10;',
      ].join("\n");
    const wideCtx = {
      ...withConnection,
      connector: {
        listKinds: () => [],
        listDatabases: async () => ["dw"],
        listTables: async () => ["wide_a", "wide_b"],
        execute: async (_kind: string, _config: unknown, sql: string) => {
          const table = /`?(wide_[ab])`?/.exec(sql)?.[1];
          if (!sql.startsWith("SHOW CREATE") || !table) throw new Error("unsupported");
          return {
            kind: "query" as const,
            columns: [{ name: "Create Table", typeName: "VARCHAR" }],
            rows: [[ddlFor(table)]],
            elapsedMs: 1,
          };
        },
      },
    };

    const wide = await dispatchTool(
      "get_table_schema",
      JSON.stringify({ tables: ["dw.wide_a", "dw.wide_b"] }),
      wideCtx,
    );
    assert.equal(wide.ok, true, wide.text);
    assert.doesNotMatch(wide.text, /\[truncated/);
    const parsed = JSON.parse(wide.text);
    assert.equal(parsed.tables.length, 2);
    for (const table of parsed.tables) {
      assert.equal(table.totalColumnCount, 329, `${table.table} lost columns`);
      assert.equal(table.columnsComplete, true, `${table.table} was truncated`);
      assert.equal(table.returnedColumnCount, 329);
      // 只给 tables 时不带 comment，也不带冗余 DDL——那是 63% 的旧 payload。
      assert.equal(table.commentsOmitted, true);
      assert.equal(table.ddlSnippet, undefined);
      const lines = table.columns.split("\n");
      assert.equal(lines.length, 329);
      assert.equal(lines[0], "col_000_metric_value:varchar(255)");
      assert.equal(lines[328], "col_328_metric_value:varchar(255)");
    }

    // 点名列时才带 comment，并且未命中的列要明确报出来，不能静默消失。
    const named = await dispatchTool(
      "get_table_schema",
      JSON.stringify({ tables: ["dw.wide_a"], columnNames: ["col_005_metric_value", "not_a_column"] }),
      wideCtx,
    );
    assert.equal(named.ok, true, named.text);
    const namedTable = JSON.parse(named.text).tables[0];
    assert.equal(namedTable.columns, "col_005_metric_value:varchar(255) -- 业务字段第 5 列的中文注释说明");
    assert.deepEqual(namedTable.missingRequestedColumns, ["not_a_column"]);
    assert.equal(namedTable.commentsOmitted, undefined);

    const paged = await dispatchTool(
      "get_table_schema",
      JSON.stringify({ tables: ["dw.wide_a"], columnOffset: 300 }),
      wideCtx,
    );
    const pagedTable = JSON.parse(paged.text).tables[0];
    assert.equal(pagedTable.returnedColumnCount, 29);
    assert.equal(pagedTable.columnsComplete, true);
    assert.equal(pagedTable.columns.split("\n")[0], "col_300_metric_value:varchar(255)");

    const withDdl = await dispatchTool(
      "get_table_schema",
      JSON.stringify({ tables: ["dw.wide_a"], includeDdl: true }),
      wideCtx,
    );
    assert.match(JSON.parse(withDdl.text).tables[0].ddlSnippet, /^CREATE TABLE/);
  }

  // 真放不下时：截断顺序是列最后，且必须逐表报出 nextColumnOffset + 指示，不能只留
  // 一个全局 ...[truncated N chars]——那是模型看不出哪张表不全的根因。
  {
    const columns = Array.from({ length: 900 }, (_, i) => `col_${String(i).padStart(3, "0")}_wide_metric`);
    const ctx = {
      ...withConnection,
      connector: {
        listKinds: () => [],
        listDatabases: async () => ["dw"],
        listTables: async () => ["huge"],
        execute: async (_kind: string, _config: unknown, sql: string) => {
          if (!sql.startsWith("SHOW CREATE")) throw new Error("unsupported");
          return {
            kind: "query" as const,
            columns: [{ name: "Create Table", typeName: "VARCHAR" }],
            rows: [[
              `CREATE TABLE \`huge\` (\n${columns.map((name) => `  \`${name}\` varchar(255) NULL`).join(",\n")}\n) ENGINE=OLAP;`,
            ]],
            elapsedMs: 1,
          };
        },
      },
    };
    const r = await dispatchTool("get_table_schema", JSON.stringify({ tables: ["dw.huge"] }), ctx);
    const table = JSON.parse(r.text).tables[0];
    assert.equal(table.totalColumnCount, 900);
    assert.equal(table.columnsComplete, false);
    assert.equal(table.nextColumnOffset, table.returnedColumnCount);
    assert.ok(table.returnedColumnCount > 500, `only ${table.returnedColumnCount} columns fit`);
    assert.match(JSON.parse(r.text).instruction, /dw\.huge/);
    assert.doesNotMatch(r.text, /\[truncated/);

    const resumed = await dispatchTool(
      "get_table_schema",
      JSON.stringify({ tables: ["dw.huge"], columnOffset: table.nextColumnOffset }),
      ctx,
    );
    const rest = JSON.parse(resumed.text).tables[0];
    assert.equal(rest.columnsComplete, true);
    assert.equal(rest.returnedColumnCount, 900 - table.returnedColumnCount);
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
    // 成功文案不得暗示内容被语义校验过——只做了一次读回比对。
    assert.doesNotMatch(r.text, /verified/i);
    assert.match(r.text, /correctness is not checked/i);
  }

  // 审批预览必须包含实际改动区。旧版发整篇前 6,000 字符，改动在 40K 处就完全看不见。
  {
    const longNote = join(root, "long.md");
    const lines = Array.from({ length: 1_200 }, (_, i) => `line ${i} ${"padding ".repeat(6)}`);
    await writeFile(longNote, lines.join("\n"), "utf8");
    const edited = [...lines];
    edited[1_000] = "THE ACTUAL CHANGE lands deep in the note";
    let preview: { oldContent?: string; newContent?: string } = {};
    const r = await dispatchTool(
      "propose_edit",
      JSON.stringify({ path: longNote, newContent: edited.join("\n") }),
      {
        ...baseCtx,
        requestProposal: async (proposal: { payload: { oldContent?: string; newContent?: string } }) => {
          preview = proposal.payload;
          return true;
        },
      },
    );
    assert.equal(r.ok, true, r.text);
    assert.ok(lines.join("\n").length > 40_000, "fixture must exceed the old 6,000-char preview");
    assert.match(preview.newContent ?? "", /THE ACTUAL CHANGE/);
    assert.match(preview.oldContent ?? "", /line 1000 /);
    assert.ok((preview.oldContent ?? "").length <= 6_200, "preview must stay bounded");
    // 省略标记两侧必须一致，否则渲染端的 line diff 会凭空多出一对增删行。
    const elided = (text: string) => text.split("\n").filter((line) => line.startsWith("…["));
    assert.deepEqual(elided(preview.oldContent ?? ""), elided(preview.newContent ?? ""));
    assert.equal(elided(preview.oldContent ?? "").length, 2);
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
    const skillUsage: Array<{ type: string; source: string; origin: "system" | "vault"; name: string; category: string | null }> = [];
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
    assert.deepEqual(JSON.parse(searched.text), {
      skills: [{
        name: "verified-gotcha",
        description: "Verified reusable SQL gotcha.",
        category: "sql-dialect",
        tags: ["sql", "gotcha"],
        freshness: "fresh",
      }],
      totalSkills: 1,
      totalMatches: 1,
      nextOffset: null,
      truncated: false,
      omittedStale: 0,
    });
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
    const verifiedSkill = maintenanceCtx.skills[0]!;
    const systemSkill = {
      ...verifiedSkill,
      skill: { ...verifiedSkill.skill, name: "chart-authoring", content: "# Chart rules\nUse valid field ids." },
      content: "---\nname: chart-authoring\ndescription: Read-only chart rules.\n---\n\n# Chart rules\nUse valid field ids.",
      metadata: {
        ...verifiedSkill.metadata,
        name: "chart-authoring",
        description: "Read-only chart rules.",
        origin: "system" as const,
        category: null,
        tags: [],
        sources: [],
        sourceTables: [],
        relativePath: "playbooks/chart-authoring/SKILL.md",
      },
    };
    const systemCtx = { ...usageCtx, skills: [systemSkill, verifiedSkill] };
    const hiddenSystem = await dispatchTool(
      "search_skills",
      JSON.stringify({ query: "chart authoring" }),
      systemCtx,
    );
    assert.deepEqual(JSON.parse(hiddenSystem.text).skills, [], "System Skills are exact-load only");
    const loadedSystem = await dispatchTool(
      "load_skill",
      JSON.stringify({ name: "chart-authoring" }),
      systemCtx,
    );
    assert.equal(loadedSystem.ok, true);
    assert.equal(JSON.parse(loadedSystem.text).source, "system");
    assert.equal(JSON.parse(loadedSystem.text).usableForFacts, false);
    const overwriteSystem = await dispatchTool(
      "save_skill",
      JSON.stringify({
        name: "chart-authoring",
        content,
        reason: "Attempt to replace bundled guidance.",
      }),
      systemCtx,
    );
    assert.equal(overwriteSystem.ok, false);
    assert.match(overwriteSystem.text, /read-only System Skill/);
    const automaticShadow = await dispatchTool(
      "save_skill",
      JSON.stringify({
        name: "chart-authoring",
        content: content.replaceAll("verified-gotcha", "chart-authoring"),
        reason: "Automatic maintenance must not shadow bundled guidance.",
      }),
      { ...maintenanceCtx, reservedSkillNames: ["chart-authoring"] },
    );
    assert.equal(automaticShadow.ok, false);
    assert.match(automaticShadow.text, /read-only System Skill/);
    const browseUsage: typeof skillUsage = [];
    const browseCtx = {
      ...usageCtx,
      skills: ["zeta-rule", "alpha-rule", "middle-rule"].map((name) => ({
        ...verifiedSkill,
        metadata: { ...verifiedSkill.metadata, name, description: `${name} description` },
      })),
      onSkillUsage: (record: typeof browseUsage[number]) => browseUsage.push(record),
    };
    const firstPage = await dispatchTool(
      "search_skills",
      JSON.stringify({ limit: 2 }),
      browseCtx,
    );
    assert.equal(firstPage.ok, true);
    assert.deepEqual(JSON.parse(firstPage.text), {
      skills: [
        { name: "alpha-rule", description: "alpha-rule description", category: "sql-dialect", tags: ["sql", "gotcha"], freshness: "fresh" },
        { name: "middle-rule", description: "middle-rule description", category: "sql-dialect", tags: ["sql", "gotcha"], freshness: "fresh" },
      ],
      totalSkills: 3,
      totalMatches: 3,
      nextOffset: 2,
      truncated: true,
      omittedStale: 0,
    });
    const lastPage = await dispatchTool(
      "search_skills",
      JSON.stringify({ offset: 2, limit: 2 }),
      browseCtx,
    );
    assert.deepEqual(JSON.parse(lastPage.text), {
      skills: [
        { name: "zeta-rule", description: "zeta-rule description", category: "sql-dialect", tags: ["sql", "gotcha"], freshness: "fresh" },
      ],
      totalSkills: 3,
      totalMatches: 3,
      nextOffset: null,
      truncated: false,
      omittedStale: 0,
    });
    assert.deepEqual(browseUsage, [], "browsing metadata must not record every row as a candidate");

    const scheduledRefreshes: string[] = [];
    const routineStaleCtx = {
      ...usageCtx,
      getSkillFreshness: async () => "stale" as const,
      scheduleSkillRefresh: (skill: { metadata: { name: string } }) => {
        scheduledRefreshes.push(skill.metadata.name);
      },
    };
    const hiddenStale = await dispatchTool(
      "search_skills",
      JSON.stringify({ query: "verified gotcha" }),
      routineStaleCtx,
    );
    assert.deepEqual(JSON.parse(hiddenStale.text), {
      skills: [],
      totalSkills: 1,
      totalMatches: 1,
      nextOffset: null,
      truncated: false,
      omittedStale: 1,
    });
    const rejectedStaleLoad = await dispatchTool(
      "load_skill",
      JSON.stringify({ name: "verified-gotcha" }),
      routineStaleCtx,
    );
    assert.equal(rejectedStaleLoad.ok, false);
    assert.match(rejectedStaleLoad.text, /stale_skill_unavailable/);
    assert.deepEqual(
      scheduledRefreshes,
      ["verified-gotcha"],
      "a stale load must queue a background refresh instead of blocking on a maintenance LLM call",
    );

    const maintenanceStaleCtx = {
      ...routineStaleCtx,
      explicitSkillMaintenance: true,
    };
    const visibleStale = await dispatchTool(
      "search_skills",
      JSON.stringify({ limit: 20, offset: 0 }),
      maintenanceStaleCtx,
    );
    const visibleStaleValue = JSON.parse(visibleStale.text) as {
      skills: Array<{ name: string; freshness: string }>;
      omittedStale: number;
    };
    assert.deepEqual(visibleStaleValue.skills.map(({ name, freshness }) => ({ name, freshness })), [
      { name: "verified-gotcha", freshness: "stale" },
    ]);
    assert.equal(visibleStaleValue.omittedStale, 0);
    const inspectStale = await dispatchTool(
      "load_skill",
      JSON.stringify({ name: "verified-gotcha" }),
      maintenanceStaleCtx,
    );
    assert.equal(inspectStale.ok, true);
    assert.match(inspectStale.text, /"freshness": "stale"/);
    assert.match(inspectStale.text, /"usableForFacts": false/);
    assert.match(inspectStale.text, /inspection-only/);

    const inspectUntracked = await dispatchTool(
      "load_skill",
      JSON.stringify({ name: "verified-gotcha" }),
      { ...usageCtx, getSkillFreshness: async () => "untracked" as const },
    );
    assert.equal(inspectUntracked.ok, true);
    assert.match(inspectUntracked.text, /"freshness": "untracked"/);
    assert.match(inspectUntracked.text, /no source hashes/);

    const skillEvidence = { notePaths: new Set<string>(), tables: new Set<string>(["threed.verified"]) };
    const explicitCtx = {
      ...usageCtx,
      explicitSkillMaintenance: true,
      skillEvidence,
    };
    const evidenceRead = await dispatchTool("read_note", JSON.stringify({ path: "note.md" }), explicitCtx);
    assert.equal(evidenceRead.ok, true);
    assert.deepEqual([...skillEvidence.notePaths], ["note.md"]);
    const provenanceName = "explicit-provenance";
    const provenanceSave = await dispatchTool(
      "save_skill",
      JSON.stringify({
        name: provenanceName,
        content: content.replaceAll("verified-gotcha", provenanceName),
        reason: "Bind evidence read during explicit maintenance.",
        sourcePaths: ["note.md"],
        sourceTables: ["threed.verified"],
      }),
      explicitCtx,
    );
    assert.equal(provenanceSave.ok, true, provenanceSave.text);
    const provenanceFile = await readFile(join(root, ".stela", "skills", provenanceName, "SKILL.md"), "utf-8");
    assert.match(provenanceFile, /sources: \[\{"path":"note\.md","sha256":"[a-f0-9]{64}"\}\]/);
    assert.match(provenanceFile, /source_tables: \["threed\.verified"\]/);
    const fakeSource = await dispatchTool(
      "save_skill",
      JSON.stringify({
        name: "fake-source",
        content: content.replaceAll("verified-gotcha", "fake-source"),
        reason: "Must reject invented provenance.",
        sourcePaths: ["not-read.md"],
      }),
      explicitCtx,
    );
    assert.equal(fakeSource.ok, false);
    assert.match(fakeSource.text, /was not read/);

    const largeBrowse = await dispatchTool(
      "search_skills",
      JSON.stringify({ limit: 999 }),
      {
        ...browseCtx,
        skills: Array.from({ length: 60 }, (_, index) => ({
          ...verifiedSkill,
          metadata: { ...verifiedSkill.metadata, name: `skill-${String(index).padStart(2, "0")}` },
        })),
      },
    );
    const largeBrowseValue = JSON.parse(largeBrowse.text) as { skills: unknown[]; nextOffset: number | null };
    assert.equal(largeBrowseValue.skills.length, 50);
    assert.equal(largeBrowseValue.nextOffset, 50);
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

  // Canvas writes are validated artifacts, and every new SQL source must bind
  // to a successful query from this Agent run.
  {
    const events: Array<{ action: "created" | "updated"; path: string }> = [];
    const chartRuns = new Map([["canvas-run", {
      sql: "SELECT category, total FROM demo",
      columns: [{ name: "category", typeName: "VARCHAR" }, { name: "total", typeName: "BIGINT" }],
      rows: [["A", 2]],
    }], ["constant-canvas-run", {
      sql: "SELECT 'A' AS category, 2 AS total UNION ALL SELECT 'B', 1",
      columns: [{ name: "category", typeName: "VARCHAR" }, { name: "total", typeName: "BIGINT" }],
      rows: [["A", 2], ["B", 1]],
    }]]);
    const canvasCtx = {
      ...baseCtx,
      run: { ...baseCtx.run, notePath: join(root, "note.md") },
      chartRuns,
      resolveChartRun: async (runId: string) => chartRuns.has(runId) ? {
        runId,
        blockId: "agent:test-run",
        sql: chartRuns.get(runId)!.sql,
        status: "ok" as const,
        message: null,
        startedAt: 123,
        elapsedMs: 1,
        rowCount: 1,
        connectionName: "demo",
        notePath: null,
      } : null,
      onCanvasUpdated: (event: { action: "created" | "updated"; path: string }) => events.push(event),
    };
    const created = await dispatchTool(
      "create_analysis_canvas",
      JSON.stringify({ title: "Agent Report" }),
      canvasCtx,
    );
    assert.equal(created.ok, true, created.text);
    const createdPayload = JSON.parse(created.text) as { path: string; etag: string; content: string };
    const content = JSON.parse(createdPayload.content) as Record<string, unknown> & {
      sources: unknown[];
      sections: unknown[];
    };
    content.sources = [{
      id: "overview",
      title: "Overview",
      connectionName: "ignored",
      sql: "SELECT invented FROM nowhere",
      lastRunId: null,
      lastRunAt: null,
      lastError: null,
    }];
    content.sections = [{
      id: "summary",
      title: "Summary",
      cards: [{
        id: "totals",
        type: "table",
        sourceId: "overview",
        width: "full",
        maxRows: 20,
      }, {
        id: "pipeline",
        type: "flow",
        width: "full",
        direction: "TB",
        nodes: [
          { id: "source", kind: "source", label: "Source", position: { x: 900, y: 900 } },
          { id: "result", kind: "result", label: "Result", position: { x: 1_000, y: 900 } },
        ],
        edges: [{ id: "source_result", source: "source", target: "result" }],
      }],
    }];
    const updated = await dispatchTool(
      "update_analysis_canvas",
      JSON.stringify({
        path: createdPayload.path,
        etag: createdPayload.etag,
        content: JSON.stringify(content),
        sourceRuns: [{ sourceId: "overview", runId: "canvas-run" }],
      }),
      canvasCtx,
    );
    assert.equal(updated.ok, true, updated.text);
    const saved = JSON.parse(await readFile(createdPayload.path, "utf8")) as {
      sources: Array<Record<string, unknown>>;
      sections: Array<{ cards: Array<Record<string, unknown>> }>;
    };
    assert.deepEqual(saved.sources[0], {
      id: "overview",
      title: "Overview",
      connectionName: "demo",
      sql: "SELECT category, total FROM demo",
      lastRunId: "canvas-run",
      lastRunAt: 123,
      lastError: null,
    });
    const newFlow = saved.sections[0]!.cards[1] as { nodes: Array<{ position?: unknown }> };
    assert.equal(newFlow.nodes[0]?.position, undefined, "Agent-supplied positions on new Flow cards must be stripped");

    const updatedPayload = JSON.parse(updated.text) as { etag: string };
    const laidOut = await updateAnalysisCanvasFlowLayout(root, createdPayload.path, updatedPayload.etag, "pipeline", {
      direction: "LR",
      positions: [{ nodeId: "source", position: { x: 12, y: 34 } }],
    });
    const agentEdit = JSON.parse(laidOut.content) as {
      sections: Array<{ cards: Array<Record<string, unknown>> }>;
    };
    const agentFlow = agentEdit.sections[0]!.cards[1] as {
      direction: string;
      nodes: Array<Record<string, unknown>>;
    };
    agentFlow.direction = "TB";
    agentFlow.nodes[0] = { ...agentFlow.nodes[0], label: "Renamed source", position: { x: 999, y: 999 } };
    const agentUpdated = await dispatchTool(
      "update_analysis_canvas",
      JSON.stringify({ path: createdPayload.path, etag: laidOut.etag, content: JSON.stringify(agentEdit), sourceRuns: [] }),
      canvasCtx,
    );
    assert.equal(agentUpdated.ok, true, agentUpdated.text);
    const agentUpdatedPayload = JSON.parse(agentUpdated.text) as { etag: string };
    const preserved = JSON.parse(await readFile(createdPayload.path, "utf8")) as {
      sections: Array<{ cards: Array<{ type: string; direction?: string; nodes?: Array<{ id: string; label: string; position?: unknown }> }> }>;
    };
    const preservedFlow = preserved.sections[0]!.cards.find((card) => card.type === "flow")!;
    assert.equal(preservedFlow.direction, "LR");
    assert.deepEqual(preservedFlow.nodes?.find((node) => node.id === "source")?.position, { x: 12, y: 34 });
    assert.equal(preservedFlow.nodes?.find((node) => node.id === "source")?.label, "Renamed source");

    const constantContent = JSON.parse(await readFile(createdPayload.path, "utf8")) as {
      sources: Array<Record<string, unknown>>;
      sections: unknown[];
    };
    constantContent.sources.push({
      id: "constant_snapshot",
      title: "Constant snapshot",
      connectionName: "ignored",
      sql: "SELECT ignored",
      lastRunId: null,
      lastRunAt: null,
      lastError: null,
    });
    const rejectedConstant = await dispatchTool(
      "update_analysis_canvas",
      JSON.stringify({
        path: createdPayload.path,
        etag: agentUpdatedPayload.etag,
        content: JSON.stringify(constantContent),
        sourceRuns: [{ sourceId: "constant_snapshot", runId: "constant-canvas-run" }],
      }),
      canvasCtx,
    );
    assert.equal(rejectedConstant.ok, false);
    assert.match(rejectedConstant.text, /must read a real table/i);

    const beforeAtomic = await readFile(createdPayload.path, "utf8");
    const refreshCtx = {
      ...canvasCtx,
      canvasRefresh: { path: createdPayload.path, sourceId: null, committed: false },
    };
    const missingAtomicBinding = await dispatchTool(
      "update_analysis_canvas",
      JSON.stringify({
        path: createdPayload.path,
        etag: agentUpdatedPayload.etag,
        content: beforeAtomic,
        sourceRuns: [],
      }),
      refreshCtx,
    );
    assert.equal(missingAtomicBinding.ok, false);
    assert.match(missingAtomicBinding.text, /requires a successful run binding for target source overview/i);
    assert.equal(await readFile(createdPayload.path, "utf8"), beforeAtomic, "failed atomic refresh must not write");

    const wrongAtomicTarget = await dispatchTool(
      "update_analysis_canvas",
      JSON.stringify({
        path: join(root, "different.stela.canvas"),
        etag: agentUpdatedPayload.etag,
        content: beforeAtomic,
        sourceRuns: [{ sourceId: "overview", runId: "canvas-run" }],
      }),
      refreshCtx,
    );
    assert.equal(wrongAtomicTarget.ok, false);
    assert.match(wrongAtomicTarget.text, /only its requested Canvas/i);

    const atomicUpdated = await dispatchTool(
      "update_analysis_canvas",
      JSON.stringify({
        path: createdPayload.path,
        etag: agentUpdatedPayload.etag,
        content: beforeAtomic,
        sourceRuns: [{ sourceId: "overview", runId: "canvas-run" }],
      }),
      refreshCtx,
    );
    assert.equal(atomicUpdated.ok, true, atomicUpdated.text);
    assert.equal(refreshCtx.canvasRefresh.committed, true);
    const atomicPayload = JSON.parse(atomicUpdated.text) as { etag: string };
    const afterAtomic = await readFile(createdPayload.path, "utf8");
    const secondAtomicUpdate = await dispatchTool(
      "update_analysis_canvas",
      JSON.stringify({
        path: createdPayload.path,
        etag: atomicPayload.etag,
        content: afterAtomic,
        sourceRuns: [{ sourceId: "overview", runId: "canvas-run" }],
      }),
      refreshCtx,
    );
    assert.equal(secondAtomicUpdate.ok, false);
    assert.match(secondAtomicUpdate.text, /already committed/i);
    assert.equal(await readFile(createdPayload.path, "utf8"), afterAtomic, "second atomic update must not write");
    assert.deepEqual(events.map((event) => event.action), ["created", "updated", "updated", "updated"]);
  }

  {
    let proposedKind = "";
    const rewrite = await dispatchTool(
      "propose_edit",
      JSON.stringify({ targetId: "target-1", sql: "SELECT fixed FROM orders", description: "Fix column" }),
      {
        ...baseCtx,
        rewriteTargets: new Map([["target-1", { sql: "SELECT broken FROM orders", sourcePath: "note.md" }]]),
        requestProposal: async (proposal) => {
          proposedKind = proposal.kind;
          assert.equal(proposal.payload.targetId, "target-1");
          assert.equal(proposal.payload.oldContent, "SELECT broken FROM orders");
          return true;
        },
      },
    );
    assert.equal(rewrite.ok, true, rewrite.text);
    assert.equal(proposedKind, "runsql_rewrite");

    const unbound = await dispatchTool(
      "propose_edit",
      JSON.stringify({ targetId: "missing", sql: "SELECT fixed", description: "Fix" }),
      baseCtx,
    );
    assert.equal(unbound.ok, false);
    assert.match(unbound.text, /not explicitly attached/i);

    const ambiguous = await dispatchTool(
      "propose_edit",
      JSON.stringify({
        targetId: "target-1",
        sql: "SELECT fixed FROM orders",
        path: "note.md",
        newContent: "mixed target",
      }),
      baseCtx,
    );
    assert.equal(ambiguous.ok, false);
    assert.match(ambiguous.text, /one edit target/i);
  }

  // oldText 只差行尾空白和 CRLF 时仍然命中；真的不存在时错误要能指导下一步。
  {
    const notePath = join(root, "crlf.md");
    await writeFile(notePath, "# Report\r\n\r\nkeep   \r\nSELECT 1;   \r\ntail\r\n");
    const looseHit = await dispatchTool(
      "propose_edit",
      JSON.stringify({ path: notePath, oldText: "keep\nSELECT 1;", newText: "keep\nSELECT 2;" }),
      { ...baseCtx, requestProposal: async () => true },
    );
    assert.equal(looseHit.ok, true, looseHit.text);
    const rewritten = await readFile(notePath, "utf8");
    assert.match(rewritten, /SELECT 2;/);
    assert.doesNotMatch(rewritten, /SELECT 1;/);
    assert.match(rewritten, /tail/);

    const miss = await dispatchTool(
      "propose_edit",
      JSON.stringify({ path: notePath, oldText: "nowhere to be found", newText: "x" }),
      baseCtx,
    );
    assert.equal(miss.ok, false);
    assert.match(miss.text, /appears 0 time\(s\)/);
    assert.match(miss.text, /read_note/);
  }

  // 错误的 targetId 要把合法 id 报回去，一个都没附加时要给出替代路径。
  {
    const wrongTarget = await dispatchTool(
      "propose_edit",
      JSON.stringify({ targetId: "resource_runsql_abc", sql: "SELECT 1" }),
      { ...baseCtx, rewriteTargets: new Map([["runsql_42", { sql: "SELECT 0" }]]) },
    );
    assert.equal(wrongTarget.ok, false);
    assert.match(wrongTarget.text, /runsql_42/);

    const noTargets = await dispatchTool(
      "propose_edit",
      JSON.stringify({ targetId: "runsql_42", sql: "SELECT 1" }),
      baseCtx,
    );
    assert.equal(noTargets.ok, false);
    assert.match(noTargets.text, /No RunSQL target is attached/i);
  }

  // zod 的 encoding 是 strict 的，Vega-Lite 风格的 channel 必须在工具层就被拒。
  {
    const chartCtx = {
      ...baseCtx,
      chartRuns: new Map([["chart-run", {
        sql: "SELECT category, total FROM t",
        columns: [{ name: "category", typeName: "VARCHAR" }, { name: "total", typeName: "BIGINT" }],
        rows: [["A", 2], ["B", 1]] as unknown[][],
      }]]),
    };
    const chartArgs = {
      runId: "chart-run",
      preset: "ranking",
      fields: [
        { id: "cat", field: "category", type: "nominal" },
        { id: "total", field: "total", type: "quantitative" },
      ],
    };
    const strict = await dispatchTool(
      "create_chart",
      JSON.stringify({ ...chartArgs, layers: [{ mark: "bar", encoding: { y: "cat", x: "total", category: "cat" } }] }),
      chartCtx,
    );
    assert.equal(strict.ok, false);
    assert.match(strict.text, /category/);

    const accepted = await dispatchTool(
      "create_chart",
      JSON.stringify({ ...chartArgs, layers: [{ mark: "bar", encoding: { y: "cat", x: "total" } }] }),
      chartCtx,
    );
    assert.equal(accepted.ok, true, accepted.text);

    // advertised schema 必须和 zod 一样窄，否则模型只能靠重试才知道 channel 不存在。
    const createChart = createAgentTools({ ctx: baseCtx, requestProposal: async () => false })
      .find((tool) => tool.name === "create_chart");
    const encoding = (createChart?.parameters as {
      properties: { layers: { items: { properties: { encoding: { additionalProperties?: boolean } } } } };
    }).properties.layers.items.properties.encoding;
    assert.equal(encoding.additionalProperties, false);
  }

  // ADR-0081：同名工具连续失败到阈值就熔断，成功一次清零，探索类工具豁免。
  {
    const breakerNote = join(root, "breaker.md");
    await writeFile(breakerNote, "breaker target\n");
    const breakerCtx = {
      ...baseCtx,
      run: { ...baseCtx.run, toolFailureStreak: new Map<string, number>() },
    };
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const failed = await dispatchToolRaw("propose_edit", JSON.stringify({ path: breakerNote }), breakerCtx);
      assert.equal(failed.ok, false);
      assert.doesNotMatch(failed.text, /now blocked/, `attempt ${attempt} must still reach the tool`);
    }
    const blocked = await dispatchToolRaw("propose_edit", JSON.stringify({ path: breakerNote, newContent: "x" }), breakerCtx);
    assert.equal(blocked.ok, false);
    assert.match(blocked.text, /propose_edit has failed 3 times in a row/);
    assert.equal(await readFile(breakerNote, "utf8"), "breaker target\n", "a blocked tool must not run");

    breakerCtx.run.toolFailureStreak.set("propose_edit", 2);
    const recovered = await dispatchToolRaw(
      "propose_edit",
      JSON.stringify({ path: breakerNote, newContent: "recovered" }),
      { ...breakerCtx, requestProposal: async () => true },
    );
    assert.equal(recovered.ok, true, recovered.text);
    assert.equal(breakerCtx.run.toolFailureStreak.get("propose_edit"), undefined, "success must reset the streak");

    breakerCtx.run.toolFailureStreak.set("run_sql", 9);
    const exploration = await dispatchToolRaw("run_sql", JSON.stringify({ sql: "SELECT 1" }), breakerCtx);
    assert.equal(exploration.ok, false);
    assert.match(exploration.text, /No data connection/, "ADR-0069 exploration tools are never blocked");
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
