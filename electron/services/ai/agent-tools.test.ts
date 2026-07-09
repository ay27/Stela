import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { AiSettings } from "@shared/types";

import { dispatchTool } from "./agent-tools";

const AI_SETTINGS = {
  providerMode: "openai-compatible",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  hasApiKey: true,
  sendResultSamples: true,
  maxSampleRows: 20,
  inlineCompletionEnabled: false,
  fimBaseUrl: "",
  fimModel: "",
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
    requestProposal: async () => true,
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

  // 有连接时，改动类语句默认直接拦截，不走 requestProposal / registry.execute
  const withConnection = {
    ...baseCtx,
    connectionName: "demo",
    connection: { kind: "fake-kind", config: {} },
    requestProposal: async () => {
      throw new Error("requestProposal should not be called when mutations are blocked by default");
    },
  };
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

  // 未知工具名不崩，返回错误文本
  {
    const r = await dispatchTool("not_a_real_tool", "{}", baseCtx);
    assert.equal(r.ok, false);
    assert.match(r.text, /Unknown tool/);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("agent-tools tests passed.");
