import assert from "node:assert/strict";

import { legacyAgentMessage, requestAgentMessage, runsqlRewriteTargets, withAgentResourceId } from "./agent-message";
import type { AgentMessageContent, AgentRunRequest } from "./types";

function request(overrides: Partial<AgentRunRequest>): AgentRunRequest {
  return { runId: "run_1", prompt: "", ...overrides } as AgentRunRequest;
}

function messageWith(resource: Parameters<typeof withAgentResourceId>[0]): AgentMessageContent {
  const withId = withAgentResourceId(resource);
  return {
    version: 1,
    segments: [{ kind: "resource", resourceId: withId.id }, { kind: "text", text: "fix this" }],
    resources: [withId],
  };
}

// The composer only ever sends `message`; reading `attachments` instead left the
// rewrite-target map empty and made every propose_edit({ targetId, sql }) fail.
{
  const targets = runsqlRewriteTargets(request({
    message: messageWith({
      kind: "runsql",
      label: "RunSQL block",
      sql: "SELECT 1",
      sourcePath: "notes/a.md",
      rewriteTargetId: "runsql_abc",
    }),
  }));
  assert.deepEqual([...targets.keys()], ["runsql_abc"]);
  assert.deepEqual(targets.get("runsql_abc"), { sql: "SELECT 1", sourcePath: "notes/a.md" });
}

// The catalog exposes both ids; only rewriteTargetId may key the registry.
{
  const message = messageWith({
    kind: "runsql",
    label: "RunSQL block",
    sql: "SELECT 2",
    rewriteTargetId: "runsql_def",
  });
  const targets = runsqlRewriteTargets(request({ message }));
  assert.equal(targets.has(message.resources[0]!.id), false);
  assert.deepEqual(targets.get("runsql_def"), { sql: "SELECT 2" });
}

// Legacy on-disk requests still normalize through the same path.
{
  const legacy = request({
    attachments: [{
      kind: "runsql",
      label: "RunSQL block",
      sql: "SELECT 3",
      sourcePath: "notes/b.md",
      rewriteTargetId: "runsql_ghi",
    }],
  });
  assert.deepEqual(requestAgentMessage(legacy), legacyAgentMessage(legacy));
  assert.deepEqual(runsqlRewriteTargets(legacy).get("runsql_ghi"), {
    sql: "SELECT 3",
    sourcePath: "notes/b.md",
  });
}

// Resources without a registry id (Add to Chat, plain selections) are not targets.
{
  assert.equal(runsqlRewriteTargets(request({
    message: messageWith({ kind: "runsql", label: "RunSQL block", sql: "SELECT 4" }),
  })).size, 0);
  assert.equal(runsqlRewriteTargets(request({
    message: messageWith({ kind: "selection", label: "Selection", text: "hello" }),
  })).size, 0);
  assert.equal(runsqlRewriteTargets(request({ prompt: "no resources" })).size, 0);
}

console.log("agent-message tests passed");
