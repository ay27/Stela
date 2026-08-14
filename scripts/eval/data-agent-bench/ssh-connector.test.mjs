import assert from "node:assert/strict";

import {
  CONNECTOR_META,
  buildRemoteCommand,
  buildSshArgs,
  parseSshConnectorArgs,
} from "./ssh-connector.mjs";

const options = parseSshConnectorArgs([
  "--host", "root@example",
  "--port", "36000",
  "--remote-bridge", "/srv/stela/bridge.py",
  "--dab-root", "/srv/dab data",
]);
assert.equal(options.condaEnv, "dabench");
assert.equal(CONNECTOR_META.kind, "dab-remote");
assert.match(buildRemoteCommand(options), /conda run -n 'dabench'/);
assert.match(buildRemoteCommand(options), /'\/srv\/dab data'/);
assert.deepEqual(buildSshArgs(options).slice(0, 3), ["-p", "36000", "-o"]);
assert.throws(() => parseSshConnectorArgs([]), /required/);

console.log("data-agent-bench SSH connector tests passed.");
