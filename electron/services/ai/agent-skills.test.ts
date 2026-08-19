import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listAgentSkills,
  loadAgentSkills,
  rankAgentSkills,
  rankAgentSkillsForRequest,
  saveAgentSkill,
} from "./agent-skills";

const root = await mkdtemp(join(tmpdir(), "stela-agent-skills-"));
const skillsDir = join(root, ".stela", "skills");

async function writeSkill(name: string, content: string): Promise<void> {
  const dir = join(skillsDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), content);
}

try {
  await writeSkill(
    "valid-schema-gotcha",
    `---
name: valid-schema-gotcha
description: Verify live schema before relying on a saved column type.
category: sql-dialect
tags: [schema, gotcha]
---

# Live schema wins
- Verify the live connector before writing SQL.`,
  );
  await writeSkill(
    "invalid-metadata",
    `---
name: invalid-metadata
description: This Skill has an unsupported category.
category: invented-category
tags: [schema]
---

# Invalid
- This must never load.`,
  );

  const { loaded } = await loadAgentSkills(root);
  assert.deepEqual(loaded.map((item) => item.metadata.name), ["valid-schema-gotcha"]);
  assert.deepEqual(
    (await listAgentSkills(root)).map((item) => item.name),
    ["valid-schema-gotcha"],
  );
  assert.deepEqual(loaded[0]?.metadata.sources, []);
  assert.deepEqual(loaded[0]?.metadata.sourceTables, []);
  await writeFile(join(root, "source.md"), "# Source\n\nVerified table rule.\n");
  await saveAgentSkill(
    root,
    "sourced-metric",
    `---
name: sourced-metric
description: Verified reusable metric definition.
category: metric-definition
tags: [metric, verified]
---

## Scope
Verified metric.

## Definition
Count verified records.

## Grain & Filters
One row per id.

## Verify
Compare the source total.`,
    "Test provenance injection.",
    {
      automatic: true,
      templateDriven: true,
      sourcePaths: ["source.md"],
      sourceTables: ["threed.metric_source"],
    },
  );
  const sourced = (await loadAgentSkills(root)).loaded.find((item) => item.metadata.name === "sourced-metric");
  assert.deepEqual(sourced?.metadata.sourceTables, ["threed.metric_source"]);
  assert.equal(sourced?.metadata.sources[0]?.path, "source.md");
  assert.match(sourced?.metadata.sources[0]?.sha256 ?? "", /^[a-f0-9]{64}$/);
  const allLoaded = (await loadAgentSkills(root)).loaded;
  assert.deepEqual(rankAgentSkills(loaded, "unrelated words", 8), []);
  assert.deepEqual(
    rankAgentSkills(loaded, "schema", 8).map((item) => item.metadata.name),
    ["valid-schema-gotcha"],
  );
  assert.deepEqual(
    rankAgentSkillsForRequest(
      allLoaded,
      { runId: "generic-sql", prompt: "[runsql: RunSQL block: SELECT]这个数据有新增吗" },
      8,
    ),
    [],
  );
  assert.deepEqual(
    rankAgentSkillsForRequest(
      allLoaded,
      {
        runId: "attached-sql",
        prompt: "这个数据有新增吗",
        attachments: [{
          kind: "runsql",
          label: "RunSQL block: SELECT",
          sql: "SELECT COUNT(*) FROM threed.metric_source WHERE verified = 1",
        }],
      },
      8,
    ),
    [],
  );
  assert.deepEqual(
    rankAgentSkillsForRequest(
      allLoaded,
      {
        runId: "referenced-table",
        prompt: "Explain this table",
        mentionedTables: ["threed.metric_source"],
      },
      8,
    ).map((item) => item.metadata.name),
    ["sourced-metric"],
  );
  await assert.rejects(
    saveAgentSkill(
      root,
      "wrong-dialect-tag",
      `---
name: wrong-dialect-tag
description: A reusable rule with the wrong database dialect tag.
category: sql-dialect
tags: [postgresql, render-task]
---

# Rule
- Verify the active dialect.`,
      "Test automatic dialect validation.",
      { dialect: "starrocks" },
    ),
    /does not match active SQL dialect/,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
