import assert from "node:assert/strict";

import type { AiContextBundle } from "./context-builder";
import { buildPrompt } from "./prompt-builder";

const bundle = {
  request: {
    action: "debug-query",
    locale: "zh",
    context: {
      source: "runsql",
      connectionName: "prod",
      connector: {
        kind: "mysql",
        displayName: "MySQL",
        dialect: "MySQL",
      },
      sql: "select * from users where",
      errorMessage: "You have an error in your SQL syntax",
    },
  },
  symbols: {
    tables: ["users"],
    referencedColumns: [],
    aliases: [],
    operations: ["select"],
  },
  schemaTargets: [
    {
      connectionName: "prod",
      database: null,
      table: "users",
      columns: [{ name: "id", typeName: "int" }],
      ddlSnippet: "CREATE TABLE users (id int)",
      source: "schema-dir",
      matchReason: "explicit SQL table",
      score: 100,
    },
  ],
  relatedRuns: [],
  summary: ["source=runsql", "connection=prod", "connector=mysql", "dialect=MySQL"],
} satisfies AiContextBundle;

const prompt = buildPrompt(bundle);
const all = `${prompt.system}\n${prompt.user}`;

assert.match(all, /Respond in Simplified Chinese/);
assert.match(all, /Keep the answer short and direct/);
assert.match(all, /where it failed/i);
assert.match(all, /how to fix it/i);
assert.match(all, /MySQL/);
assert.match(all, /SQL dialect/);

const rewriteBundle = {
  ...bundle,
  request: {
    action: "rewrite-sql",
    locale: "en",
    context: {
      source: "runsql",
      connectionName: "prod",
      connector: bundle.request.context.connector,
      sql: "select * from users where",
      userInstruction: "fix syntax",
      noteMarkdown: "this note must not be included for rewrite",
      result: {
        rowCount: 1,
        rows: [[1]],
      },
    },
  },
  schemaTargets: bundle.schemaTargets,
  summary: ["source=runsql", "connection=prod", "connector=mysql", "dialect=MySQL"],
} satisfies AiContextBundle;
const rewritePrompt = buildPrompt(rewriteBundle);
const rewriteUser = JSON.parse(rewritePrompt.user) as {
  outputRules?: unknown;
  sqlDialect?: unknown;
  schemaTargets?: Array<Record<string, unknown>>;
  requestContext: {
    connector?: unknown;
    sql?: string | null;
    userInstruction?: string | null;
    noteMarkdown?: string | null;
    result?: unknown;
    schemas?: unknown;
  };
};
assert.match(rewritePrompt.system, /Use only the current RunSQL block/);
assert.match(rewritePrompt.system, /Return only the rewritten SQL/);
assert.equal(rewriteUser.outputRules, undefined);
assert.equal(rewriteUser.sqlDialect, undefined);
assert.equal(rewriteUser.requestContext.connector, undefined);
assert.equal(rewriteUser.requestContext.sql, "select * from users where");
assert.equal(rewriteUser.requestContext.userInstruction, "fix syntax");
assert.equal(rewriteUser.requestContext.noteMarkdown, undefined);
assert.equal(rewriteUser.requestContext.result, undefined);
assert.equal(rewriteUser.requestContext.schemas, undefined);
assert.equal(rewriteUser.schemaTargets?.length, 1);
assert.equal(rewriteUser.schemaTargets?.[0]?.score, undefined);
assert.equal(rewriteUser.schemaTargets?.[0]?.matchReason, undefined);

const rewriteWithSchemas = buildPrompt({
  ...rewriteBundle,
  request: {
    ...rewriteBundle.request,
    context: {
      ...rewriteBundle.request.context,
      schemas: bundle.schemaTargets,
    },
  },
  schemaTargets: bundle.schemaTargets,
});
const deduped = JSON.parse(rewriteWithSchemas.user) as {
  schemaTargets?: unknown[];
  requestContext: { schemas?: unknown };
};
assert.equal(deduped.schemaTargets?.length, 1);
assert.equal(deduped.requestContext.schemas, undefined);

const askBundle = {
  ...bundle,
  request: {
    action: "ask-sql",
    locale: "zh",
    context: {
      source: "runsql",
      connectionName: "prod",
      connector: bundle.request.context.connector,
      sql: "select 1",
      userInstruction: "@threed.users 解释一下这个表",
      mentionedTables: ["threed.users"],
    },
  },
  relatedRuns: [
    {
      runId: "r1",
      status: "ok",
      connectionName: "prod",
      notePath: "note.md",
      rowCount: 1,
      message: null,
      sql: "select 1",
      startedAt: Date.now(),
      endedAt: Date.now(),
      blockId: null,
    },
  ],
} satisfies AiContextBundle;
const askPrompt = buildPrompt(askBundle);
const askUser = JSON.parse(askPrompt.user) as {
  sqlSymbols?: unknown;
  relatedRuns?: unknown[];
  schemaTargets?: Array<Record<string, unknown>>;
  requestContext: {
    userInstruction?: string | null;
    mentionedTables?: string[];
  };
};
assert.equal(askUser.sqlSymbols, undefined);
assert.equal(askUser.relatedRuns, undefined);
assert.equal(askUser.requestContext.userInstruction, "threed.users 解释一下这个表");
assert.deepEqual(askUser.requestContext.mentionedTables, ["threed.users"]);
assert.equal(askUser.schemaTargets?.[0]?.columns, undefined);
assert.ok(askUser.schemaTargets?.[0]?.ddlSnippet);

console.log("ai prompt-builder tests passed.");

