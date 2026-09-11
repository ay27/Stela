import { i18n } from "@/i18n";
import type { EditorState } from "@codemirror/state";
import { agentMessagePlainText } from "@shared/agent-message";
import { agentComposerStateToMessage, composerResources, createAgentComposerState, emptyAgentComposerState } from "@/lib/agent-composer";
import { create } from "zustand";
import type { IConversationSnapshot } from "@shared/conversation";
import { scheduleAutoGit } from "@/services/auto-git";
import { useWorkspace } from "./workspace";

interface IConversationState {
  snapshots: Record<string, IConversationSnapshot>;
  drafts: Record<string, string>;
  editors: Record<string, EditorState>;
  connections: Record<string, string | null>;
  errors: Record<string, string>;
  accept: (snapshot: IConversationSnapshot) => void;
  open: (path: string) => Promise<void>;
  edit: (path: string, draft: string, connectionName: string | null, editor?: EditorState) => void;
  flush: (path: string) => Promise<void>;
  send: (path: string) => Promise<void>;
}
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const saving = new Map<string, Promise<void>>();
const sending = new Set<string>();
let subscribed = false;
const aliases = new Map<string, Set<string>>();
export const useConversation = create<IConversationState>((set, get) => ({
  snapshots: {}, drafts: {}, editors: {}, connections: {}, errors: {},
  accept(snapshot) {
    const paths = [snapshot.path, ...(aliases.get(snapshot.path) ?? [])];
    set(s => ({ snapshots: { ...s.snapshots, ...Object.fromEntries(paths.map(path => [path, { ...snapshot, path }])) } }));
    for (const visiblePath of paths) {
    const tabId = useWorkspace.getState().getTabIdByPath(visiblePath);
    if (tabId) {
      const running = snapshot.document.turns.some(t => t.status === "running") && !snapshot.persistenceError;
      const tab = useWorkspace.getState().tabs.find(t => t.id === tabId);
      const draft = get().drafts[visiblePath];
      useWorkspace.getState().setDirty(tabId, !!snapshot.persistenceError || (draft !== undefined && (draft !== snapshot.document.draft || JSON.stringify(get().editors[visiblePath] ? agentComposerStateToMessage(get().editors[visiblePath]) : undefined) !== JSON.stringify(snapshot.document.draftMessage))));
      if (running && !tab?.sqlRunningCount) useWorkspace.getState().incrementSqlRunning(tabId);
      if (!running && tab?.sqlRunningCount) useWorkspace.getState().decrementSqlRunning(tabId);
    }
    }
  },
  async open(path) {
    if (!subscribed) { window.stela.conversation.onChanged(s => get().accept(s)); subscribed = true; }
    const snapshot = await window.stela.conversation.read(path);
    const knownAliases = aliases.get(snapshot.path) ?? new Set<string>();
    knownAliases.add(path); aliases.set(snapshot.path, knownAliases);
    get().accept(snapshot);
    set(s => ({ editors: { ...s.editors, [path]: s.editors[path] ?? createAgentComposerState(snapshot.document.draftMessage ?? { version: 1, segments: [{ kind: "text", text: snapshot.document.draft }], resources: [] }) }, drafts: { ...s.drafts, [path]: s.drafts[path] ?? snapshot.document.draft }, connections: { ...s.connections, [path]: path in s.connections ? s.connections[path]! : snapshot.document.connectionName } }));
  },
  edit(path, draft, connectionName, editor) {
    const current = get().editors[path];
    editor ??= current && agentMessagePlainText(agentComposerStateToMessage(current)) === draft ? current
      : createAgentComposerState({ version: 1, segments: [{ kind: "text", text: draft }], resources: [] });
    if (current && current.doc === editor.doc && current.field(composerResources) === editor.field(composerResources) && get().connections[path] === connectionName) {
      if (current !== editor) set(s => ({ editors: { ...s.editors, [path]: editor! } }));
      return;
    }
    draft = agentMessagePlainText(agentComposerStateToMessage(editor));
    if (current && JSON.stringify(agentComposerStateToMessage(current)) === JSON.stringify(agentComposerStateToMessage(editor)) && get().connections[path] === connectionName) {
      set(s => ({ editors: { ...s.editors, [path]: editor! } })); return;
    }
    const tabId = useWorkspace.getState().getTabIdByPath(path);
    if (tabId && !useWorkspace.getState().tabs.find(tab => tab.id === tabId)?.dirty) useWorkspace.getState().setDirty(tabId, true);
    set(s => ({ editors: { ...s.editors, [path]: editor! }, drafts: { ...s.drafts, [path]: draft }, connections: { ...s.connections, [path]: connectionName } }));
    clearTimeout(timers.get(path));
    timers.set(path, setTimeout(() => { void get().flush(path).catch(e => set(s => ({ errors: { ...s.errors, [path]: String(e) } }))); }, 350));
  },
  async flush(path) {
    clearTimeout(timers.get(path));
    const previous = saving.get(path) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      const state = get(); const snap = state.snapshots[path]; if (!snap) return;
      const draft = state.drafts[path] ?? snap.document.draft;
      const connection = state.connections[path] ?? null;
      const draftMessage = state.editors[path] ? agentComposerStateToMessage(state.editors[path]) : undefined;
      if (draft === snap.document.draft && connection === snap.document.connectionName && JSON.stringify(draftMessage) === JSON.stringify(snap.document.draftMessage)) return;
      // Active events can advance revisions; retry only when an event already
      // delivered a newer revision, never silently adopt an external disk edit.
      let snapshot: IConversationSnapshot;
      try { snapshot = await window.stela.conversation.draft(path, snap.etag, draft, connection, draftMessage); }
      catch (e) {
        const latest = get().snapshots[path];
        if (!latest || latest.etag === snap.etag) throw e;
        snapshot = await window.stela.conversation.draft(path, latest.etag, draft, connection, draftMessage);
      }
      get().accept(snapshot); scheduleAutoGit("conversation-save");
      set(s => ({ errors: { ...s.errors, [path]: "" } }));
    });
    saving.set(path, task);
    try { await task; } catch (e) { set(s => ({ errors: { ...s.errors, [path]: String(e) } })); throw e; } finally { if (saving.get(path) === task) saving.delete(path); }
  },
  async send(path) {
    if (sending.has(path)) return;
    sending.add(path);
    try {
      await get().flush(path);
      const state = get(); const snapshot = state.snapshots[path];
      const message = state.editors[path] ? agentComposerStateToMessage(state.editors[path]) : undefined;
      const input = state.drafts[path]?.trim();
      if (!snapshot || !input || snapshot.document.turns.some(t => t.status === "running")) return;
      const next = await window.stela.conversation.submit({ locale: i18n.resolvedLanguage?.startsWith("zh") ? "zh" : "en", path, etag: snapshot.etag, requestId: crypto.randomUUID(), input, message, connectionName: state.connections[path] ?? null });
      get().accept(next);
      set(s => {
        const unchanged = JSON.stringify(s.editors[path] ? agentComposerStateToMessage(s.editors[path]) : undefined) === JSON.stringify(message);
        return { editors: { ...s.editors, [path]: unchanged ? emptyAgentComposerState() : s.editors[path] },
          drafts: { ...s.drafts, [path]: unchanged ? "" : s.drafts[path] }, errors: { ...s.errors, [path]: "" } };
      });
      get().accept(next);
      scheduleAutoGit("conversation-send");
    } catch (e) { set(s => ({ errors: { ...s.errors, [path]: String(e) } })); }
    finally { sending.delete(path); }
  },
}));
