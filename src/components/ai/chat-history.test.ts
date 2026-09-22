import assert from "node:assert/strict";
import { chatHistoryItems, chatFileLabel } from "./chat-history";
const items = chatHistoryItems([
  { sessionId: "same", path: "/vault/Chats/orders.stela.chat", title: "Old title", updatedAt: 5, temporary: false },
  { sessionId: "same", path: "/vault/.stela/chat-sessions.local/same.stela.chat", title: "duplicate", updatedAt: 6, temporary: true },
  { sessionId: "other", path: "/vault/.stela/chat-sessions.local/other.stela.chat", title: "Recent question", updatedAt: 8, temporary: true },
], [{ sessionId: "same", deviceSlug: "device", title: "Legacy", createdAt: 1, updatedAt: 4, isLocal: true },
{ sessionId: "old", deviceSlug: "device", title: "Earlier question", createdAt: 1, updatedAt: 2, isLocal: true }], "/vault");
assert.deepEqual(items.map(item => item.title), ["Recent question", "orders.stela.chat", "Earlier question"]);
assert.equal(items[1].directory, "Chats");
assert.deepEqual(items[2].legacy, { deviceSlug: "device", sessionId: "old" });
assert.deepEqual(chatFileLabel("C:\\vault\\Chat.stela.chat", "C:\\vault"), { title: "Chat.stela.chat", directory: "." });
console.log("Chat history mixes sources, prefers files, projects identities and displays relative paths.");
