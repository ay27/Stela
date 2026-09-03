import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DabBridgeClient, type DabValidation } from "./runtime";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = await fs.mkdtemp(path.join(os.tmpdir(), "stela-dab-bridge-"));
const write = async (relative: string, content: string): Promise<void> => {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf-8");
};

try {
  await write("common_scaffold/__init__.py", "");
  await write("common_scaffold/tools/__init__.py", "");
  await write("common_scaffold/validate/__init__.py", "");
  await write("common_scaffold/tools/QueryDBTool.py", `
from pathlib import Path
class QueryDBTool:
    def __init__(self, **kwargs):
        self.db_clients = {"demo_database": {"db_type": "sqlite"}}
        self.event_path = Path(kwargs["log_path"]).parent / "fixture-events.log"
        self.event_path.parent.mkdir(parents=True, exist_ok=True)
        with self.event_path.open("a") as handle:
            handle.write(f"init:{kwargs.get('check_load')}\\n")
    def exec(self, args):
        if "giant" in args["query"]:
            return {"success": True, "result": [{"value": "x" * 100000}]}
        if "many" in args["query"]:
            return {"success": True, "result": [{"value": index} for index in range(500)]}
        return {"success": True, "result": [{"value": 1, "query": args["query"]}]}
    def clean_up(self):
        with self.event_path.open("a") as handle:
            handle.write("cleanup\\n")
`);
  await write("common_scaffold/tools/ListDBTool.py", `
class ListDBTool:
    def __init__(self, **kwargs):
        pass
    def exec(self, args):
        return {"success": True, "result": ["demo_table"]}
`);
  await write("common_scaffold/validate/validate.py", `
def validate(query_dir, llm_answer, reason=None):
    return {"is_valid": "one" in llm_answer, "reason": reason, "llm_answer": llm_answer}
`);
  await write("query_demo/db_config.yaml", "db_clients: {}\n");
  await write("query_demo/db_description.txt", `1. demo_database
   - demo_table:
     - Fields:
       - value (int): Demo value
`);
  await write("query_demo/query1/query.json", '"Return one"\n');
  await write("query_demo/query1/validate.py", "def validate(x): return True, 'OK'\n");

  const bridge = new DabBridgeClient({
    dabRoot: root,
    bridgePath: path.join(here, "bridge.py"),
    python: "python3",
  });
  const config = { dataset: "demo", queryId: 1, runDir: path.join(root, "run") };
  await bridge.call("test", { config });
  assert.deepEqual(await bridge.call("list_databases", { config }), ["demo_database"]);
  assert.deepEqual(await bridge.call("list_tables", { config, db: "demo_database" }), ["demo_table"]);
  const descriptors = await bridge.call<Array<{ columns: Array<{ name: string }> }>>("describe_tables", {
    config,
    tables: [{ database: "demo_database", table: "demo_table" }],
  });
  assert.equal(descriptors[0]?.columns[0]?.name, "value");
  const result = await bridge.call<{ rows: unknown[][] }>("execute", {
    config,
    sql: "-- stela-dab-database: demo_database\nSELECT 1",
  });
  assert.equal(result.rows[0]?.[0], 1);
  const artifactPath = path.join(root, "materialized.jsonl");
  const materialized = await bridge.call<{
    columns: Array<{ name: string }>;
    previewRows: unknown[][];
    rowCount: number;
  }>("materialize_data_query", {
    config,
    query: { language: "sql", database: "demo_database", query: "SELECT many" },
    request: { format: "jsonl", outputPath: artifactPath, previewRows: 2, previewMaxBytes: 24_576, maxBytes: 1_000_000 },
  });
  assert.equal(materialized.columns[0]?.name, "value");
  assert.deepEqual(materialized.previewRows, [[0], [1]]);
  assert.equal(materialized.rowCount, 500);
  const artifactRows = (await fs.readFile(artifactPath, "utf-8")).trim().split("\n");
  assert.equal(artifactRows.length, 500);
  assert.deepEqual(JSON.parse(artifactRows[0]!), { c0: 0 });
  assert.deepEqual(JSON.parse(artifactRows.at(-1)!), { c0: 499 });
  const giantPath = path.join(root, "giant.jsonl");
  const giant = await bridge.call<{ previewRows: unknown[][]; previewTruncatedBy: string[] }>("materialize_data_query", {
    config,
    query: { language: "sql", database: "demo_database", query: "SELECT giant" },
    request: { format: "jsonl", outputPath: giantPath, previewRows: 2, previewMaxBytes: 1_024, maxBytes: 1_000_000 },
  });
  assert.deepEqual(giant.previewRows, []);
  assert.deepEqual(giant.previewTruncatedBy, ["bytes"]);
  assert.ok((await fs.stat(giantPath)).size > 100_000, "full artifact must remain intact despite preview truncation");
  const rejectedPath = path.join(root, "rejected.jsonl");
  await assert.rejects(
    bridge.call("materialize_data_query", {
      config,
      query: { language: "sql", database: "demo_database", query: "SELECT many" },
      request: { format: "jsonl", outputPath: rejectedPath, previewRows: 2, maxBytes: 10 },
    }),
    /artifact limit/,
  );
  await assert.rejects(fs.stat(rejectedPath), { code: "ENOENT" });
  const validation = await bridge.call<DabValidation>("validate", {
    config,
    answer: "one",
    terminateReason: "final_answer",
  });
  assert.equal(validation.is_valid, true);
  await bridge.close();
  assert.equal(
    await fs.readFile(path.join(root, "run", "fixture-events.log"), "utf-8"),
    "init:True\ncleanup\n",
  );

  const owner = new DabBridgeClient({
    dabRoot: root,
    bridgePath: path.join(here, "bridge.py"),
    python: "python3",
  });
  const child = new DabBridgeClient({
    dabRoot: root,
    bridgePath: path.join(here, "bridge.py"),
    python: "python3",
  });
  const ownerConfig = { dataset: "demo", queryId: 1, runDir: path.join(root, "owner") };
  const childConfig = {
    dataset: "demo",
    queryId: 1,
    runDir: path.join(root, "child"),
    fixtureMode: "shared",
  };
  await owner.call("test", { config: ownerConfig });
  await child.call("test", { config: childConfig });
  assert.deepEqual(await child.call("list_databases", { config: childConfig }), ["demo_database"]);
  await child.close();
  assert.equal(
    await fs.readFile(path.join(root, "child", "fixture-events.log"), "utf-8"),
    "init:False\n",
    "a shared child must never clean the owner's fixture",
  );
  await owner.close();
  assert.equal(
    await fs.readFile(path.join(root, "owner", "fixture-events.log"), "utf-8"),
    "init:True\ncleanup\n",
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log("data-agent-bench bridge integration tests passed.");
