import assert from "node:assert/strict";

import {
  getActiveMentionFromText,
  parseMentionedTables,
  serializeMentionParts,
} from "./ai-mention-input";

assert.deepEqual(parseMentionedTables("compare @dw.users with @orders"), [
  "dw.users",
  "orders",
]);

assert.deepEqual(parseMentionedTables("no mentions here"), []);

assert.deepEqual(parseMentionedTables("compare @dw.users\nwith @orders"), [
  "dw.users",
  "orders",
]);

assert.equal(
  serializeMentionParts([
    { kind: "text", value: "Compare " },
    { kind: "mention", table: "dw.users" },
    { kind: "text", value: "\nwith " },
    { kind: "mention", table: "orders" },
    { kind: "text", value: "\nWhat changed?" },
  ]),
  "Compare @dw.users\nwith @orders\nWhat changed?",
);

assert.deepEqual(getActiveMentionFromText("explain join @dw.use", 20), {
  at: 13,
  prefix: "dw.use",
});

assert.equal(getActiveMentionFromText("explain join @dw.users ", 23), null);

console.log("ai-mention-input tests passed.");
