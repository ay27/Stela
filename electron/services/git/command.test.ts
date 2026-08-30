import assert from "node:assert/strict";

import { buildGitEnv } from "./command";

const windowsEnv = buildGitEnv(
  {
    Path: "C:\\Windows\\System32;C:\\Program Files\\Git\\cmd",
  },
  "win32",
);
assert.equal(
  windowsEnv.Path,
  "C:\\Windows\\System32;C:\\Program Files\\Git\\cmd",
);
assert.equal(windowsEnv.PATH, undefined);
assert.equal(
  Object.keys(windowsEnv).filter((key) => key.toLowerCase() === "path").length,
  1,
);

const posixEnv = buildGitEnv({ PATH: "/custom/bin" }, "darwin");
assert.equal(posixEnv.PATH?.startsWith("/custom/bin:"), true);
assert.equal(posixEnv.PATH?.includes("/usr/local/bin"), true);
assert.equal(posixEnv.GIT_TERMINAL_PROMPT, "0");
assert.equal(posixEnv.GIT_OPTIONAL_LOCKS, "0");

console.log("git command environment tests passed.");
