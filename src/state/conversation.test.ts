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
  temporary: async () => snapshot, recent: async () => [], saveAs: async () => snapshot,
  discard: async () => {}, protect: async () => {}, importHistory: async () => snapshot,
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

// Placement changes must not fork execution or replace a structured draft.
const { useChatWorkspace } = await import("./chat-workspace");
useWorkspace.setState({ vaultPath: "/real-vault", tabs: [{ id: "note", kind: "file", path: "/real-vault/note.md", title: "Note" }], activeTabId: "note" });
useChatWorkspace.getState().bind();
await useConversation.getState().open(canonical);
useConversation.getState().edit(canonical, "kept draft", "demo");
await useConversation.getState().flush(canonical);
const retainedEditor = useConversation.getState().editors[canonical];
const priorSends = sends;
Object.assign(window.stela, { settings: { patch: async () => ({}) } });
useChatWorkspace.getState().move(canonical, "side");
useChatWorkspace.getState().move(canonical, "main");
assert.equal(useChatWorkspace.getState().sidePath, null);
assert.equal(useWorkspace.getState().tabs.filter(t => t.path === canonical).length, 1);
useChatWorkspace.getState().move(canonical, "side");
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(useWorkspace.getState().activeTabId, "note");
assert.equal(useWorkspace.getState().tabs.filter(t => t.path === canonical).length, 0);
assert.equal(useConversation.getState().editors[canonical], retainedEditor);
assert.equal(useConversation.getState().connections[canonical], "demo");
assert.equal(sends, priorSends);
let cancellations = 0;
bridge.cancel = async () => { cancellations++; };
useChatWorkspace.getState().close(canonical);
assert.equal(cancellations, 0);
assert.equal(useConversation.getState().drafts[canonical], "kept draft");
console.log("Unified Chat placement preserves one session, draft/editor, connection, prior tab and execution; close does not cancel.");

// History menus supply a summary; only its identity may cross strict IPC.
const historySummary = { deviceSlug: "device-test", sessionId: "session-test", title: "Old Chat", createdAt: 1, updatedAt: 2, isLocal: true };
let imported = false;
bridge.importHistory = async ref => {
  assert.deepEqual(ref, { deviceSlug: "device-test", sessionId: "session-test" });
  imported = true;
  return snapshot;
};
await useChatWorkspace.getState().importLegacy(historySummary, "side");
assert.equal(imported, true);
console.log("Legacy Chat import projects summary metadata to the strict IPC identity.");

const secondPath = "/real-vault/second.stela.chat";
useChatWorkspace.getState().move(secondPath, "side");
useChatWorkspace.getState().move(canonical, "side");
assert.deepEqual(useChatWorkspace.getState().sidePaths, [canonical, secondPath]);
useChatWorkspace.getState().close(canonical);
assert.equal(useChatWorkspace.getState().sidePath, secondPath);
useChatWorkspace.getState().close(secondPath);
assert.deepEqual(useChatWorkspace.getState().sidePaths, []);
assert.equal(useChatWorkspace.getState().sidePath, null);
assert.equal(cancellations, 0);
console.log("Chat tabs deduplicate and close to the adjacent tab, then an empty state.");

const { ensureSidebarChat } = await import("./chat-workspace");
let blankCreations = 0;
bridge.temporary = async () => { blankCreations++; return snapshot; };
await Promise.all([ensureSidebarChat(), ensureSidebarChat()]);
assert.equal(blankCreations, 1);
assert.deepEqual(useChatWorkspace.getState().sidePaths, [snapshot.path]);
await ensureSidebarChat();
assert.equal(blankCreations, 1, "existing tabs must not be replaced");
useChatWorkspace.getState().close(snapshot.path);
await ensureSidebarChat();
assert.equal(blankCreations, 2, "closing the last tab allows a fresh blank composer");
console.log("Empty sidebar initializes one Chat and deduplicates concurrent initialization.");
