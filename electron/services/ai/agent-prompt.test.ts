import assert from "node:assert/strict";

import { buildSystemPrompt } from "./agent-prompt";

const prompt = buildSystemPrompt(
  { runId: "prompt-test", prompt: "show the query" },
  null,
  null,
);

assert.match(prompt, /conversation and final-answer text, SQL MUST use fenced ```sql```/);
assert.match(prompt, /never label it ```runsql```/);
assert.match(prompt, /Only Markdown content being written into a vault note may use executable fenced ```runsql```/);
assert.match(prompt, /Never preserve already fetched numbers or rows by turning them into SELECT literals/);
