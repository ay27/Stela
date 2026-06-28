import assert from "node:assert/strict";

import { redactForPrompt } from "./redaction";

const sample = {
  api_key: "sk-secret-value",
  nested: {
    Authorization: "Bearer abcdef123456",
    sql: "select * from users where token='abc123'",
  },
};

const redacted = redactForPrompt(sample);

assert.equal(redacted.api_key, "***redacted***");
assert.equal(redacted.nested.Authorization, "***redacted***");
assert.match(redacted.nested.sql, /\*\*\*redacted\*\*\*/);
assert.doesNotMatch(JSON.stringify(redacted), /sk-secret-value|abcdef123456/);

console.log("ai redaction tests passed.");

