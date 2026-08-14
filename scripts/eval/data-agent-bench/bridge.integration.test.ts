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
class QueryDBTool:
    def __init__(self, **kwargs):
        self.db_clients = {"demo_database": {"db_type": "sqlite"}}
    def exec(self, args):
        return {"success": True, "result": [{"value": 1, "query": args["query"]}]}
    def clean_up(self):
        pass
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
  const validation = await bridge.call<DabValidation>("validate", {
    config,
    answer: "one",
    terminateReason: "final_answer",
  });
  assert.equal(validation.is_valid, true);
  await bridge.close();
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log("data-agent-bench bridge integration tests passed.");
