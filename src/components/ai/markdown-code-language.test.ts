import assert from "node:assert/strict";

import { normalizeAgentMarkdownCodeLanguage } from "./markdown-code-language";

assert.equal(normalizeAgentMarkdownCodeLanguage("runsql"), "sql");
assert.equal(normalizeAgentMarkdownCodeLanguage("RunSQL"), "sql");
assert.equal(normalizeAgentMarkdownCodeLanguage("sql"), "sql");
assert.equal(normalizeAgentMarkdownCodeLanguage("stela-chart"), "stela-chart");
assert.equal(normalizeAgentMarkdownCodeLanguage(""), "");
