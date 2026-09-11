import assert from "node:assert/strict";
import { composerResourceCandidates, composerRunsqlCandidates } from "./composer-resources";
import { useWorkspace } from "@/state/workspace";
import { setTabBuffer, clearTabBuffer } from "@/state/tab-buffer";
const sql = "SELECT " + "column_name, ".repeat(100) + "last_column FROM sales";
let reads = 0;
Object.assign(globalThis, { window: { stela: {
  index: { listCandidates: async () => [{ kind: "file", detail: "/vault/reports/orders.md" }] },
  search: { listFiles: async () => ["/vault/report.stela.canvas"] },
  vault: { readFile: async (path: string) => { assert.equal(path, "/vault/reports/orders.md"); reads++; return "```runsql\n" + sql + "\n```"; } },
} } });
useWorkspace.setState({ vaultPath: "/vault", tabs: [] });
const candidates = await composerResourceCandidates("", null);
assert.ok(candidates.some(r => r.kind === "note" && r.path === "reports/orders.md"));
assert.ok(candidates.some(r => r.kind === "canvas" && r.path === "report.stela.canvas"));
const disk = await composerRunsqlCandidates("reports/orders.md");
assert.equal(reads, 1);
assert.equal(disk[0]?.kind === "runsql" && disk[0].sql, sql);
useWorkspace.setState({ tabs: [{ id: "note", kind: "file", title: "Orders", path: "/vault/reports/orders.md" }] });
setTabBuffer("note", "```runsql\nSELECT unsaved\n```\n\n```runsql\nSELECT second\n```");
const unsaved = await composerRunsqlCandidates("reports/orders.md");
assert.equal(reads, 1);
assert.equal(unsaved.length, 2);
assert.equal(unsaved[1]?.kind === "runsql" && unsaved[1].locator?.blockIndex, 1);
assert.equal(unsaved[0]?.kind === "runsql" && unsaved[0].sql, "SELECT unsaved");
clearTabBuffer("note");
console.log("Composer references: Vault-wide files, complete RunSQL bodies, unsaved buffers and block locators passed.");
