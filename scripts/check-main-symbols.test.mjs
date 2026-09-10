import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkMainSymbols } from "./check-main-symbols.mjs";

assert.equal(checkMainSymbols().length, 0);
const file = resolve("electron/services/ai/agent.ts");
const original = readFileSync(file, "utf8");
const removeRankingImport = source => source.replace(/^  rankAgentSkillsForRequest,\r?\n/m, "");
for (const eol of ["\n", "\r\n"]) {
  const fixture = `import {${eol}  rankAgentSkillsForRequest,${eol}  loadAgentSkills,${eol}} from './agent-skills';${eol}`;
  assert.equal(removeRankingImport(fixture), `import {${eol}  loadAgentSkills,${eol}} from './agent-skills';${eol}`);
}
const broken = removeRankingImport(original);
assert.notEqual(broken, original, "fixture must reproduce the missing import without editing the worktree");
const errors = checkMainSymbols("tsconfig.node.json", new Map([[file, broken]]));
assert.ok(errors.some(d => d.code === 2304 && String(d.messageText).includes("rankAgentSkillsForRequest")));
console.log("main symbol gate: original missing-import regression is blocked");
