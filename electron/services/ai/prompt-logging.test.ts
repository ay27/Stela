import assert from "node:assert/strict";

import type { AiContextBundle } from "./context-builder";
import { formatPromptDebugLog } from "./prompt-logging";

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
    },
  },
  symbols: {
    tables: ["users"],
    referencedColumns: [],
    aliases: [],
    operations: ["select"],
  },
  relatedRuns: [],
  summary: ["source=runsql", "connection=prod", "connector=mysql", "dialect=MySQL"],
} satisfies AiContextBundle;

const text = formatPromptDebugLog(bundle, {
  system: "system prompt",
  user: '{"request":"user prompt"}',
});

assert.match(text, /Stela AI Prompt/);
assert.match(text, /action=debug-query/);
assert.match(text, /locale=zh/);
assert.match(text, /connector=mysql/);
assert.match(text, /dialect=MySQL/);
assert.match(text, /--- system ---\nsystem prompt/);
assert.match(text, /--- user ---\n\{"request":"user prompt"\}/);

console.log("ai prompt-logging tests passed.");

