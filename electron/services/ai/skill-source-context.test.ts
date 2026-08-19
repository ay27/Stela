import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
  const notes = await collectSkillSourceNotes(root, ["demo.orders"], query);
  assert.deepEqual(notes.map((note) => note.path), ["notes/old.md"]);
  assert.deepEqual(filters, [
    { readTable: "demo.orders", maxHits: 60 },
    { writeTable: "demo.orders", maxHits: 60 },
  ]);

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
  assert.equal(await isSkillStale(root, skill, query), true);
  latest = [];
  assert.equal(await isSkillStale(root, skill, query), true);

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
