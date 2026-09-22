import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { maintenanceModel, maintenanceExcerpt, maintenanceNotes, maintenanceSkip, recordMaintenance, MAINTENANCE_COOLDOWN_MS } from "./maintenance-policy";

const original: Model<"openai-completions"> = { id: "glm-5.3-flash", name: "GLM", api: "openai-completions", provider: "custom", baseUrl: "http://localhost", reasoning: true, input: ["text"], contextWindow: 1000000, maxTokens: 16384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsReasoningEffort: true } };
const selected = maintenanceModel(original);
assert.equal(selected.maxTokens, 2048);
assert.equal(selected.compat?.thinkingFormat, "zai");
assert.equal(original.compat?.thinkingFormat, undefined, "foreground model must not change");
assert.equal(maintenanceModel({ ...original, id: "another-model" }).compat?.thinkingFormat, undefined);
const raw = '# Intro\n\nUnrelated text.\n\n```sql\nSELECT * FROM demo.orders;\n```\n\n' + 'oversized '.repeat(1000) + '\n\n```sql\nSELECT broken';
const excerpt = maintenanceExcerpt(raw, ['demo.orders'], 150);
assert.match(excerpt, /\[sanitized lines 5-7\]/);
assert.match(excerpt, /```sql\nSELECT \* FROM demo.orders;\n```/);
assert.ok(!excerpt.includes('broken') && !excerpt.includes('oversized'));
const notes = maintenanceNotes([{ path: 'orders.md', content: raw, updatedAt: '', sha256: 'hash' }], ['demo.orders'], 500);
assert.equal(notes[0].sha256, 'hash');
assert.ok(notes[0].content.length < 500);
const root = await mkdtemp(join(tmpdir(), 'maintenance-policy-'));
try {
  assert.equal(await maintenanceSkip(root, 'candidate', 'skills', 10), null);
  await recordMaintenance(root, { key: 'candidate', skills: 'skills', at: 10, outcome: 'timeout' });
  assert.equal(await maintenanceSkip(root, 'candidate', 'skills', 11), 'cooldown');
  assert.equal(await maintenanceSkip(root, 'new-source-hash', 'skills', 11), null);
  assert.equal(await maintenanceSkip(root, 'candidate', 'new-skills', 11), null);
  assert.equal(await maintenanceSkip(root, 'candidate', 'skills', 10 + MAINTENANCE_COOLDOWN_MS), null);
  await recordMaintenance(root, { key: 'candidate', skills: 'skills', at: 10, outcome: 'saved' });
  assert.equal(await maintenanceSkip(root, 'candidate', 'skills', 10 + MAINTENANCE_COOLDOWN_MS), 'unchanged');
  assert.equal(JSON.parse(await readFile(join(root, '.stela/skill-maintenance.local.json'), 'utf8')).receipts.length, 1);
  await writeFile(join(root, '.stela/skill-maintenance.local.json'), '{corrupt');
  assert.equal(await maintenanceSkip(root, 'candidate', 'skills'), null);
} finally { await rm(root, { recursive: true, force: true }); }
console.log('maintenance policy tests passed');

// Exercise the actual provider serializer and stop before HTTP dispatch.
const { streamSimple } = await import('@earendil-works/pi-ai/api/openai-completions');
let payload: Record<string, unknown> | undefined;
const response = await streamSimple(selected as Model<'openai-completions'>,
  { messages: [{ role: 'user', content: 'No new knowledge.', timestamp: 0 }] },
  { apiKey: 'offline-test-key', onPayload: value => {
    payload = value as Record<string, unknown>;
    throw new Error('offline: stop before HTTP');
  } }).result();
assert.equal(response.stopReason, 'error');
assert.deepEqual(payload?.thinking, { type: 'disabled' });
assert.equal(payload?.max_tokens ?? payload?.max_completion_tokens, 2048);
console.log('maintenance actual provider payload: explicit thinking disabled, bounded output');
