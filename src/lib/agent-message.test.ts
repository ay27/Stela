import assert from "node:assert/strict";

import { agentMessagePlainText, withAgentResourceId } from "@shared/agent-message";
import {
  agentMessageVisibleLength,
  composeAgentMessage,
  insertAgentResource,
  markupToMessage,
  messageToMarkup,
} from "./agent-message";

const runsql = withAgentResourceId({
  kind: "runsql",
  label: "Orders query",
  sql: "select * from orders",
  sourcePath: "orders.md",
  locator: { blockId: "block_1", blockIndex: 0 },
});
const first = composeAgentMessage("Compare ", runsql, " with yesterday");
const inserted = insertAgentResource(first, runsql, agentMessagePlainText(first).length);

assert.equal(inserted.message.resources.length, 1, "duplicate occurrences share one resource body");
assert.equal(
  inserted.message.segments.filter((segment) => segment.kind === "resource").length,
  2,
  "duplicate occurrences retain both positions",
);
assert.match(agentMessagePlainText(inserted.message), /^Compare \[runsql: Orders query\]/);
assert.equal(
  inserted.cursorOffset,
  agentMessageVisibleLength(inserted.message),
  "caret after an appended pill uses the same visible offset as the editor DOM",
);

const markup = messageToMarkup(inserted.message);
assert.deepEqual(markupToMessage(markup, inserted.message.resources), inserted.message);

console.log("agent message tests passed.");
