import { i18n } from "@/i18n";
import assert from "node:assert/strict";
import type { IConversationBridge, IConversationSnapshot } from "@shared/conversation";
import { useConversation } from "./conversation";
import { useWorkspace } from "./workspace";
const visible = "/vault-link/chat.stela.chat";
const canonical = "/real-vault/chat.stela.chat";
let snapshot: IConversationSnapshot = { path: canonical, etag: "a".repeat(64), document: { kind: "stela-conversation", version: 1, id: "fixture", title: "Chat", createdAt: 1, updatedAt: 1, connectionName: "demo", draft: "SELECT 1", turns: [], sessionJsonl: "" } };
let listener: ((s: IConversationSnapshot) => void) | undefined;
let sends = 0;
let duringSubmit: (() => void) | undefined;
const bridge: IConversationBridge = {
  create: async () => snapshot, read: async () => snapshot,
  draft: async (_path, etag, draft, connectionName, draftMessage) => { assert.equal(etag, snapshot.etag); snapshot = { ...snapshot, etag: "b".repeat(64), document: { ...snapshot.document, draft, connectionName, draftMessage } }; return snapshot; },
  submit: async input => { assert.equal(input.locale, "zh"); sends++; snapshot = { ...snapshot, etag: "c".repeat(64), document: { ...snapshot.document, draft: "", draftMessage: { version: 1, segments: [], resources: [] }, turns: [{ id: input.requestId, input: input.input, message: input.message, connectionName: input.connectionName, status: "running", startedAt: 1, runs: [], events: [], responses: [] }] } }; listener?.(snapshot); duringSubmit?.(); return snapshot; },
  cancel: async () => {}, respond: async () => {},
  onChanged: callback => { listener = callback; return () => {}; },
};
Object.assign(globalThis, { window: { stela: { conversation: bridge } } });
useWorkspace.setState({ vaultPath: null, tabs: [{ id: "tab", kind: "conversation", path: visible, title: "Chat", ephemeral: true }] });
await i18n.changeLanguage("zh");
await useConversation.getState().open(visible);
assert.equal(useConversation.getState().snapshots[visible]?.etag, snapshot.etag);
assert.equal(useConversation.getState().drafts[visible], "SELECT 1");
useConversation.getState().edit(visible, "SELECT 2", "demo");
assert.equal(useWorkspace.getState().tabs[0]?.ephemeral, false);
await useConversation.getState().flush(visible);
assert.equal(snapshot.document.draft, "SELECT 2");
await Promise.all([useConversation.getState().send(visible), useConversation.getState().send(visible)]);
assert.equal(sends, 1);
assert.equal(useConversation.getState().drafts[visible], "");
assert.equal(useConversation.getState().snapshots[visible]?.document.turns.length, 1);
assert.equal(useWorkspace.getState().tabs[0]?.dirty, false);
assert.equal(useWorkspace.getState().tabs[0]?.sqlRunningCount, 1);
snapshot = { ...snapshot, document: { ...snapshot.document, turns: snapshot.document.turns.map(turn => ({ ...turn, status: "completed" })) } };
listener?.(snapshot);
assert.equal(useWorkspace.getState().tabs[0]?.sqlRunningCount ?? 0, 0);
console.log("Conversation renderer state: canonical-path aliases, drafts, preview promotion, duplicate send and background completion passed.");

const { createAgentComposerState, agentComposerStateToMessage } = await import("@/lib/agent-composer");
const { withAgentResourceId, agentMessagePlainText } = await import("@shared/agent-message");
const reference = withAgentResourceId({ kind: "note", label: "Orders", path: "orders.md" });
const message = { version: 1 as const, segments: [{ kind: "resource" as const, resourceId: reference.id }], resources: [reference] };
const editor = createAgentComposerState(message);
useConversation.getState().edit(visible, agentMessagePlainText(message), "demo", editor);
await useConversation.getState().flush(visible);
assert.deepEqual(snapshot.document.draftMessage, message);
duringSubmit = () => useConversation.getState().edit(visible, "next question", "demo");
await useConversation.getState().send(visible);
assert.deepEqual(snapshot.document.turns[0]?.message, message);
assert.equal(useConversation.getState().drafts[visible], "next question");
await useConversation.getState().flush(visible);
assert.equal(snapshot.document.draft, "next question");
assert.equal(agentMessagePlainText(agentComposerStateToMessage(useConversation.getState().editors[visible])), "next question");
console.log("Conversation structured drafts: references persist and a new draft survives in-flight submission.");
