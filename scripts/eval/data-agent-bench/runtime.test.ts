import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildDabBridgeCommand,
  buildDabBridgePath,
  buildDabUserPrompt,
  cacheHitRate,
  discoverDabTasks,
  endpointHash,
} from "./runtime";

assert.equal(
  buildDabBridgePath("/dab", "/usr/bin:/bin"),
  [path.join("/dab", "scripts"), "/usr/bin:/bin"].join(path.delimiter),
);

assert.deepEqual(buildDabBridgeCommand({
  dabRoot: "/dab",
  bridgePath: "/stela/bridge.py",
  condaEnv: "dabench",
}), {
  command: "conda",
  args: [
    "run",
    "--no-capture-output",
    "-n",
    "dabench",
    "python",
    "-u",
    "/stela/bridge.py",
    "--dab-root",
    "/dab",
  ],
});
assert.deepEqual(buildDabBridgeCommand({
  dabRoot: "/dab",
  bridgePath: "/stela/bridge.py",
  python: "/venv/bin/python",
}), {
  command: "/venv/bin/python",
  args: ["-u", "/stela/bridge.py", "--dab-root", "/dab"],
});

assert.equal(cacheHitRate(100, 300, 100), 0.6);
assert.equal(cacheHitRate(0, 0, 0), null);
assert.equal(endpointHash("https://example.test/v1").length, 16);

const prompt = buildDabUserPrompt({
  databaseDescription: "books_database has books_info",
  hintsText: "Join purchase_id to book_id",
  query: "Which decade wins?",
});
assert.ok(prompt.indexOf("DATABASE DESCRIPTION") < prompt.indexOf("DATASET HINTS"));
assert.ok(prompt.indexOf("ACTIVE CONNECTION CONTRACT") < prompt.indexOf("QUERY:"));
assert.match(prompt, /-- stela-dab-database: <logical_name>/);
assert.match(prompt, /QUERY:\nWhich decade wins\?$/);

const root = await fs.mkdtemp(path.join(os.tmpdir(), "stela-dab-runtime-"));
try {
  const queryDir = path.join(root, "query_demo", "query2");
  await fs.mkdir(queryDir, { recursive: true });
  await fs.writeFile(path.join(queryDir, "query.json"), '"hello"');
  await fs.writeFile(path.join(queryDir, "validate.py"), "def validate(x): return True, 'OK'");
  assert.deepEqual(await discoverDabTasks(root), [{ dataset: "demo", queryId: 2, queryDir }]);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log("data-agent-bench runtime tests passed.");
