import assert from "node:assert/strict";

import { normalizeSuggestion } from "./sql-inline-completion";

assert.equal(normalizeSuggestion("ct", "sele", "t * from users", true), "c");
assert.equal(normalizeSuggestion("ect", "sel", " * from users", true), "ect");
assert.equal(
  normalizeSuggestion("WHERE active = 1", "SELECT * FROM users", "", true),
  " WHERE active = 1",
);
assert.equal(
  normalizeSuggestion("amount\nFROM orders\nWHERE id > 0\nORDER BY id", "SELECT ", "", true),
  "amount\nFROM orders\nWHERE id > 0",
);
assert.equal(normalizeSuggestion("users", "SELECT * FROM ", "users", true), "");

console.log("SQL inline completion text tests passed.");
