import assert from "node:assert/strict";

import { requestAgentMessage } from "@shared/agent-message";

import {
  buildAgentEmptyActions,
  formatMaintenanceRecency,
  type AgentEmptyActionCopy,
} from "./agent-empty-state";

const copy: AgentEmptyActionCopy = {
  canvasCreatePrompt: "create canvas",
  canvasRefreshPrompt: "refresh canvas",
  documentSummaryPrompt: "summarize document",
  canvasSummaryPrompt: "summarize canvas",
  dataAuditPrompt: "audit document",
  canvasAuditPrompt: "audit canvas",
  knowledgeMaintenancePrompt: "maintain knowledge",
};

const noteActions = buildAgentEmptyActions({
  workspace: { kind: "note", path: "reports/orders.md", title: "Orders" },
  copy,
});
assert.deepEqual(noteActions.map((action) => action.id), [
  "canvas-create",
  "document-summary",
  "data-audit",
  "knowledge-maintenance",
]);
assert.equal(noteActions[0]?.entryPoint, "chat");
assert.deepEqual(noteActions[0]?.message.resources[0], {
  id: noteActions[0]?.message.resources[0]?.id,
  kind: "note",
  label: "Orders",
  path: "reports/orders.md",
});

const canvasActions = buildAgentEmptyActions({
  workspace: { kind: "canvas", path: "reports/orders.stela.canvas", title: "Orders" },
  copy,
});
assert.deepEqual(canvasActions.map((action) => action.id), [
  "canvas-refresh",
  "canvas-summary",
  "canvas-audit",
  "knowledge-maintenance",
]);
assert.equal(canvasActions[0]?.entryPoint, "canvas-refresh");
assert.deepEqual(canvasActions[0]?.canvasRefresh, { path: "reports/orders.stela.canvas" });

const globalActions = buildAgentEmptyActions({ workspace: null, copy });
assert.deepEqual(globalActions.map((action) => action.id), ["knowledge-maintenance"]);
assert.equal(globalActions[0]?.entryPoint, "knowledge-maintenance");
const knowledgeText = requestAgentMessage({
  runId: "knowledge-test",
  prompt: "fallback",
  message: globalActions[0]?.message,
}).segments.flatMap((segment) => segment.kind === "text" ? [segment.text] : []).join("");
assert.equal(knowledgeText, "maintain knowledge");

const now = Date.UTC(2026, 7, 19, 12);
assert.equal(formatMaintenanceRecency(now - 3 * 24 * 60 * 60_000, now, "en"), "3 days ago");
assert.equal(formatMaintenanceRecency(now - 3 * 24 * 60 * 60_000, now, "zh"), "3天前");

console.log("agent empty-state tests passed.");
