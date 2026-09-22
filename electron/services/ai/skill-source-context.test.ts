import assert from "node:assert/strict";
import { symlink, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadAgentSkills, saveAgentSkill } from "./agent-skills";
import { collectSkillSourceNotes, getSkillFreshness, isSkillStale } from "./skill-source-context";

const root = await mkdtemp(join(tmpdir(), "stela-skill-source-"));
try {
  await mkdir(join(root, "notes"), { recursive: true });
  await writeFile(join(root, "notes", "old.md"), "# Old\n\nSELECT * FROM demo.orders;\n");
  await writeFile(join(root, "notes", "new.md"), "# New\n\nSELECT * FROM demo.orders;\n");
  const hit = (relPath: string) => ({
    path: join(root, relPath),
    relPath,
    blockIndex: 0,
    line: 1,
    blockId: null,
    connectionName: null,
    dialect: null,
    runDate: null,
    operations: ["select" as const],
    readTables: ["demo.orders"],
    writeTables: [],
    snippet: "SELECT * FROM demo.orders",
  });
  let latest = [hit("notes/old.md")];
  const filters: Array<{ readTable?: string; writeTable?: string; maxHits?: number }> = [];
  const query = async (filter: { readTable?: string; writeTable?: string; maxHits?: number }) => {
    filters.push(filter);
    return filter.readTable ? latest : [];
  };
  const preferred = await collectSkillSourceNotes(root, [], async () => [], 3, [join(root, "notes", "new.md")]);
  assert.equal(preferred[0]?.path, "notes/new.md");
  assert.equal((await collectSkillSourceNotes(root, [], async () => [], 3, ["../outside.md"])).length, 0);
  const excluded = await collectSkillSourceNotes(root, ["demo.orders"], async () => [hit("notes/new.md"), hit("notes/old.md")], 1,
    ["notes/new.md"], new Set(["notes/new.md"]));
  assert.deepEqual(excluded.map(note => note.path), ["notes/old.md"], "generated sources are excluded before ranking, not after truncation");
  assert.equal((await collectSkillSourceNotes(root, [], async () => [], 3, ["./notes/new.md"], new Set(["notes/new.md"]))).length, 0);
  await symlink(join(root, "notes/new.md"), join(root, "alias.md"));
  assert.equal((await collectSkillSourceNotes(root, [], async () => [], 3, ["alias.md"], new Set(["notes/new.md"]))).length, 0, "path aliases cannot launder generated evidence");
  const notes = await collectSkillSourceNotes(root, ["demo.orders"], query);
  assert.deepEqual(notes.map((note) => note.path), ["notes/old.md"]);
  assert.deepEqual(filters, [
    { readTable: "demo.orders", maxHits: 60 },
    { writeTable: "demo.orders", maxHits: 60 },
  ]);

  const diagnostics = { candidates: [] as string[], excluded: [] as string[], unreadable: [] as string[] };
  const noSources = await collectSkillSourceNotes(root, [], async () => [], 3,
    ["notes/old.md", "missing.md"], new Set(["notes/old.md"]), diagnostics);
  assert.deepEqual(noSources, []);
  assert.deepEqual(diagnostics.excluded, ["notes/old.md"]);
  assert.deepEqual(diagnostics.unreadable, ["missing.md"]);

  await saveAgentSkill(
    root,
    "orders-metric",
    `---
name: orders-metric
description: Verified order-count definition.
category: metric-definition
tags: [orders, metric]
---

## Scope
Orders.

## Definition
Count order ids.

## Grain & Filters
One row per order.

## Verify
Compare grouped totals.`,
    "source test",
    { automatic: true, templateDriven: true, sourcePaths: ["notes/old.md"], sourceTables: ["demo.orders"] },
  );
  let skill = (await loadAgentSkills(root)).loaded[0]!;
  assert.equal(await getSkillFreshness(root, skill, query), "fresh");
  assert.equal(await isSkillStale(root, skill, query), false);
  await writeFile(join(root, "notes", "old.md"), "# Old changed\n");
  assert.equal(await getSkillFreshness(root, skill, query), "stale");
  assert.equal(await isSkillStale(root, skill, query), true);

  await saveAgentSkill(root, "orders-metric", skill.content, "refresh source", {
    overwrite: true,
    templateDriven: true,
    sourcePaths: ["notes/old.md"],
    sourceTables: ["demo.orders"],
  });
  skill = (await loadAgentSkills(root)).loaded[0]!;
  latest = [hit("notes/new.md")];
  // Additional retrieved sources may trigger refresh, but recorded sources stay preferred.
  assert.equal(await isSkillStale(root, skill, query), true);
  latest = [];
  assert.equal(await isSkillStale(root, skill, query), false);

  await saveAgentSkill(
    root,
    "untracked-orders-metric",
    skill.content.replaceAll("orders-metric", "untracked-orders-metric"),
    "manual source-less test",
    { overwrite: true },
  );
  const untracked = (await loadAgentSkills(root)).loaded.find(
    (item) => item.metadata.name === "untracked-orders-metric",
  )!;
  assert.equal(await getSkillFreshness(root, untracked, query), "untracked");
  assert.equal(await isSkillStale(root, untracked, query), false);
} finally {
  await rm(root, { recursive: true, force: true });
}
