import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkMainSymbols } from "./check-main-symbols.mjs";

assert.equal(checkMainSymbols().length, 0);
const file = resolve("electron/services/ai/agent.ts");
const original = readFileSync(file, "utf8");
const broken = original.replace("  rankAgentSkillsForRequest,\n", "");
assert.notEqual(broken, original, "fixture must reproduce the missing import without editing the worktree");
const errors = checkMainSymbols("tsconfig.node.json", new Map([[file, broken]]));
assert.ok(errors.some(d => d.code === 2304 && String(d.messageText).includes("rankAgentSkillsForRequest")));
console.log("main symbol gate: original missing-import regression is blocked");
