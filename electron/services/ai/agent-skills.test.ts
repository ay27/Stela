import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listAgentSkills, loadAgentSkills, rankAgentSkills, saveAgentSkill } from "./agent-skills";

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
  assert.deepEqual(rankAgentSkills(loaded, "unrelated words", 8), []);
  assert.deepEqual(
    rankAgentSkills(loaded, "schema", 8).map((item) => item.metadata.name),
    ["valid-schema-gotcha"],
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
