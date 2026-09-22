import { create } from "zustand";
import type { AgentMessageContent, AgentMessageResourceInput, AgentHistoryRef } from "@shared/types";
import type { IConversationTask, IConversationSummary } from "@shared/conversation";
import { createAgentComposerState, insertAgentComposerResource, agentComposerStateToMessage } from "@/lib/agent-composer";
import { agentMessagePlainText } from "@shared/agent-message";
import { useConversation } from "./conversation";
import { useWorkspace } from "./workspace";
import { useLayout } from "./layout";
import { scheduleAutoGit } from "@/services/auto-git";

type Placement = "main" | "side";
interface IChatWorkspace {
  error: string;
  vault: string | null;
  sidePaths: string[];
  sidePath: string | null;
  lastPath: string | null;
  returnTabId: string | null;
  recent: IConversationSummary[];
  scroll: Record<string, { top: number; following: boolean }>;
  bind: () => void;
  refresh: () => Promise<void>;
  create: (placement?: Placement, title?: string) => Promise<string>;
  show: (path: string, placement: Placement) => Promise<void>;
  move: (path: string, placement: Placement) => void;
  close: (path: string) => void;
  save: (path: string, directory: string, title: string) => Promise<void>;
  discard: (path: string) => Promise<void>;
  attach: (resource: AgentMessageResourceInput) => Promise<void>;
  quick: (input: IConversationTask & { title: string; message: AgentMessageContent; connectionName?: string | null; autoSend: boolean }) => Promise<void>;
  importLegacy: (ref: AgentHistoryRef, placement?: Placement) => Promise<void>;
}
export const useChatWorkspace = create<IChatWorkspace>((set, get) => ({
  error: "", vault: null, sidePaths: [], sidePath: null, lastPath: null, returnTabId: null, recent: [], scroll: {},
  bind() {
    installChatSubscriptions();
    const vault = useWorkspace.getState().vaultPath;
    if (get().vault === vault) return;
    useConversation.getState().reset();
    set({ error: "", vault, sidePaths: [], sidePath: null, lastPath: null, returnTabId: null, recent: [], scroll: {} });
  },
  async refresh() { get().bind(); if (get().vault) set({ recent: await window.stela.conversation.recent() }); },
  async create(placement = "side", title = "Chat") {
    get().bind();
    if (!get().vault) throw new Error("Open a Vault before starting Chat.");
    const snapshot = await window.stela.conversation.temporary(title);
    useConversation.getState().accept(snapshot);
    await get().show(snapshot.path, placement);
    return snapshot.path;
  },
  async show(path, placement) { get().bind(); await useConversation.getState().open(path); get().move(path, placement); },
  move(path, placement) {
    const workspace = useWorkspace.getState();
    if (placement === "main") {
      const previous = workspace.tabs.find(tab => tab.id === workspace.activeTabId);
      const remaining = get().sidePaths.filter(item => item !== path);
      set({ sidePaths: remaining, sidePath: get().sidePath === path ? remaining.at(-1) ?? null : get().sidePath, lastPath: path,
        returnTabId: previous?.kind !== "conversation" ? workspace.activeTabId : get().returnTabId });
      workspace.openFile(path, useConversation.getState().snapshots[path]?.document.title ?? "Chat");
      if (!useLayout.getState().agentPanelCollapsed) useLayout.getState().toggleAgentPanel();
    } else {
      workspace.closeTab(workspace.getTabIdByPath(path));
      const previous = get().returnTabId;
      if (previous && useWorkspace.getState().tabs.some(tab => tab.id === previous)) workspace.setActive(previous);
      set({ sidePaths: get().sidePaths.includes(path) ? get().sidePaths : [...get().sidePaths, path], sidePath: path, lastPath: path }); useLayout.getState().focusAgentPanel();
    }
  },
  close(path) {
    const index = get().sidePaths.indexOf(path);
    const remaining = get().sidePaths.filter(item => item !== path);
    set({ sidePaths: remaining, sidePath: get().sidePath === path ? remaining[index] ?? remaining[index - 1] ?? null : get().sidePath });
    void useConversation.getState().flush(path).catch(error => set({ error: String(error) }));
    useWorkspace.getState().closeTab(useWorkspace.getState().getTabIdByPath(path));
    if (get().lastPath === path) set({ lastPath: null });
    void get().refresh();
  },
  async save(path, directory, title) {
    const store = useConversation.getState(); await store.flush(path);
    const source = useConversation.getState(); const snapshot = source.snapshots[path];
    const saved = await window.stela.conversation.saveAs(path, snapshot.etag, directory, title);
    store.accept(saved);
    useConversation.setState(s => ({ editors: { ...s.editors, [saved.path]: s.editors[path] },
      drafts: { ...s.drafts, [saved.path]: s.drafts[path] }, connections: { ...s.connections, [saved.path]: s.connections[path] },
      tasks: { ...s.tasks, [saved.path]: s.tasks[path] } }));
    useWorkspace.getState().renameTabsForPath(path, saved.path);
    set(s => ({ sidePaths: s.sidePaths.map(item => item === path ? saved.path : item), sidePath: s.sidePath === path ? saved.path : s.sidePath, lastPath: saved.path,
      scroll: { ...s.scroll, [saved.path]: s.scroll[path] } }));
    scheduleAutoGit("conversation-save"); await get().refresh();
  },
  async discard(path) { await useConversation.getState().flush(path); await window.stela.conversation.discard(path); get().close(path); await get().refresh(); },
  async attach(resource) {
    get().bind();
    const workspace = useWorkspace.getState(); const tab = workspace.tabs.find(tab => tab.id === workspace.activeTabId);
    let path = tab?.kind === "conversation" ? tab.path : get().sidePath ?? get().lastPath;
    if (!path) path = await get().create();
    await useConversation.getState().open(path);
    const store = useConversation.getState();
    const editor = insertAgentComposerResource(store.editors[path] ?? createAgentComposerState({ version: 1, segments: [], resources: [] }), resource, { collapseSelectionToHead: true });
    store.edit(path, agentMessagePlainText(agentComposerStateToMessage(editor)), store.connections[path] ?? null, editor);
    if (tab?.path === path) useWorkspace.getState().setActive(tab.id);
    else get().move(path, "side");
  },
  async quick(input) {
    const path = await get().create("side", input.title);
    const store = useConversation.getState();
    store.setTask(path, { entryPoint: input.entryPoint, canvasRefresh: input.canvasRefresh, workspaceContext: input.workspaceContext });
    store.edit(path, agentMessagePlainText(input.message), input.connectionName ?? null, createAgentComposerState(input.message));
    if (input.autoSend) await store.send(path);
  },
  async importLegacy(ref, placement = "side") { get().bind(); const snapshot = await window.stela.conversation.importHistory({ deviceSlug: ref.deviceSlug, sessionId: ref.sessionId }); await get().show(snapshot.path, placement); },
}));

let protectedSignature = "";
function protectOpenChats() {
  if (!useWorkspace.getState().vaultPath || typeof window === "undefined" || !window.stela?.conversation?.protect) return;
  const paths = useWorkspace.getState().tabs.filter(tab => tab.kind === "conversation").flatMap(tab => tab.path ? [tab.path] : []);
  paths.push(...useChatWorkspace.getState().sidePaths);
  const signature = JSON.stringify([useWorkspace.getState().vaultPath, [...paths].sort()]);
  if (signature === protectedSignature) return;
  protectedSignature = signature;
  void window.stela.conversation.protect(paths).catch(() => {});
}
let installed = false;
function installChatSubscriptions() {
  if (installed) return;
  installed = true;
  useWorkspace.subscribe((state, previous) => {
    const added = new Set(state.tabs.filter(tab => tab.kind === "conversation" && !previous.tabs.some(old => old.path === tab.path)).map(tab => tab.path));
    const chat = useChatWorkspace.getState();
    if (chat.sidePaths.some(path => added.has(path))) {
      const remaining = chat.sidePaths.filter(path => !added.has(path));
      useChatWorkspace.setState({ sidePaths: remaining, sidePath: chat.sidePath && added.has(chat.sidePath) ? remaining.at(-1) ?? null : chat.sidePath });
    }
    protectOpenChats();
  });
  useChatWorkspace.subscribe(protectOpenChats);
}

// Share startup across StrictMode/remounts; never replace a tab opened while IPC is pending.
const preparingSidebar = new Map<string, Promise<void>>();
export function ensureSidebarChat(): Promise<void> {
  useChatWorkspace.getState().bind();
  const { vault, sidePaths } = useChatWorkspace.getState();
  if (!vault || sidePaths.length) return Promise.resolve();
  const pending = preparingSidebar.get(vault);
  if (pending) return pending;
  const task = window.stela.conversation.temporary("Chat").then(snapshot => {
    const current = useChatWorkspace.getState();
    if (current.vault !== vault || useWorkspace.getState().vaultPath !== vault || current.sidePaths.length) return;
    useConversation.getState().accept(snapshot);
    useChatWorkspace.setState({ sidePaths: [snapshot.path], sidePath: snapshot.path, lastPath: snapshot.path });
  }).finally(() => { preparingSidebar.delete(vault); });
  preparingSidebar.set(vault, task);
  return task;
}
