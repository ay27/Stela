import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DabBridgeClient,
  DabBridgeError,
  buildDabBridgeCommand,
  buildDabBridgePath,
  buildDabUserPrompt,
  cacheHitRate,
  discoverDabTasks,
  endpointHash,
  mapWithConcurrency,
  mapWithResourceConcurrency,
  readDabDatasetResourceLocks,
} from "./runtime";

assert.equal(
  buildDabBridgePath("/dab", "/usr/bin:/bin"),
  [path.join("/dab", "scripts"), "/usr/bin:/bin"].join(path.delimiter),
);
assert.equal(
  buildDabBridgePath("/dab", "/usr/bin:/bin", "/venv/bin/python"),
  [path.join("/dab", "scripts"), "/venv/bin", "/usr/bin:/bin"].join(path.delimiter),
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

let activeWorkers = 0;
let maxWorkers = 0;
const concurrentResults = await mapWithConcurrency([1, 2, 3, 4], 2, async (value) => {
  activeWorkers += 1;
  maxWorkers = Math.max(maxWorkers, activeWorkers);
  await new Promise((resolve) => setTimeout(resolve, 10));
  activeWorkers -= 1;
  return value * 2;
});
assert.deepEqual(concurrentResults, [2, 4, 6, 8]);
assert.equal(maxWorkers, 2);

let activeResourceWorkers = 0;
let activeMongoWorkers = 0;
let maxResourceWorkers = 0;
let maxMongoWorkers = 0;
const resourceResults = await mapWithResourceConcurrency(
  ["mongo-a", "mongo-b", "sql-a", "sql-b"],
  2,
  (value) => value.startsWith("mongo") ? ["mongodb"] : [],
  async (value) => {
    activeResourceWorkers += 1;
    if (value.startsWith("mongo")) activeMongoWorkers += 1;
    maxResourceWorkers = Math.max(maxResourceWorkers, activeResourceWorkers);
    maxMongoWorkers = Math.max(maxMongoWorkers, activeMongoWorkers);
    await new Promise((resolve) => setTimeout(resolve, 10));
    activeResourceWorkers -= 1;
    if (value.startsWith("mongo")) activeMongoWorkers -= 1;
    return value.toUpperCase();
  },
);
assert.deepEqual(resourceResults, ["MONGO-A", "MONGO-B", "SQL-A", "SQL-B"]);
assert.equal(maxResourceWorkers, 2);
assert.equal(maxMongoWorkers, 1);

const prompt = buildDabUserPrompt({
  databaseDescription: "books_database has books_info",
  hintsText: "Join purchase_id to book_id",
  query: "Which decade wins?",
});
assert.ok(prompt.indexOf("DATABASE DESCRIPTION") < prompt.indexOf("DATASET HINTS"));
assert.ok(prompt.indexOf("ACTIVE CONNECTION CONTRACT") < prompt.indexOf("QUERY:"));
assert.match(prompt, /run_query call targets exactly one logical database/);
assert.match(prompt, /language=mongodb/);
assert.match(prompt, /QUERY:\nWhich decade wins\?$/);

const root = await fs.mkdtemp(path.join(os.tmpdir(), "stela-dab-runtime-"));
try {
  const queryDir = path.join(root, "query_demo", "query2");
  await fs.mkdir(queryDir, { recursive: true });
  await fs.writeFile(path.join(queryDir, "query.json"), '"hello"');
  await fs.writeFile(path.join(queryDir, "validate.py"), "def validate(x): return True, 'OK'");
  await fs.writeFile(
    path.join(root, "query_demo", "db_config.yaml"),
    "db_clients:\n  docs:\n    db_type: mongo # shared service\n",
  );
  assert.deepEqual(
    await readDabDatasetResourceLocks({ dataset: "demo", queryId: 2, queryDir }),
    ["dab:mongodb"],
  );
  assert.deepEqual(await discoverDabTasks(root), [{ dataset: "demo", queryId: 2, queryDir }]);

  const blockingBridge = path.join(root, "blocking_bridge.py");
  await fs.writeFile(blockingBridge, [
    "import sys",
    "import time",
    "for line in sys.stdin:",
    "    time.sleep(60)",
  ].join("\n"));
  const bridge = new DabBridgeClient({
    dabRoot: root,
    bridgePath: blockingBridge,
    python: "python3",
    callTimeoutMs: 100,
  });
  let timeoutError: unknown;
  try {
    await bridge.call("test", {});
  } catch (error) {
    timeoutError = error;
  }
  assert.ok(timeoutError instanceof DabBridgeError);
  assert.equal(timeoutError.code, "bridge_call_timeout");
  assert.equal(timeoutError.method, "test");
  assert.equal(timeoutError.fatal, true);
  await assert.rejects(bridge.call("list_databases", {}), (error: unknown) =>
    error instanceof DabBridgeError && error.code === "bridge_call_timeout",
  );
  await bridge.close();
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log("data-agent-bench runtime tests passed.");
