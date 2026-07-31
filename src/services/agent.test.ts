import assert from "node:assert/strict";

import { toAgentHistoryRef } from "./agent";

assert.deepEqual(
  toAgentHistoryRef({
    sessionId: "sess_1",
    deviceSlug: "laptop",
    title: "Revenue analysis",
    createdAt: 1,
    updatedAt: 2,
    isLocal: true,
  }),
  { sessionId: "sess_1", deviceSlug: "laptop" },
);

console.log("agent service tests passed.");
