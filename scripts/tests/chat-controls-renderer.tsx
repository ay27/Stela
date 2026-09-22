import React from "react";
import { createRoot } from "react-dom/client";
import { i18n } from "../../src/i18n";
import { ChatControls } from "../../src/components/ai/chat-controls";
import { useChatWorkspace } from "../../src/state/chat-workspace";
import { useConversation } from "../../src/state/conversation";
import { useWorkspace } from "../../src/state/workspace";
import type { IConversationSnapshot } from "../../electron/shared/conversation";

const files = ["/vault/.stela/chat-sessions.local/one.stela.chat", "/vault/Chats/orders.stela.chat", "/vault/.stela/chat-sessions.local/three.stela.chat"];
const snapshots: Record<string, IConversationSnapshot> = Object.fromEntries(files.map((path, i) => [path, { path, etag: "a".repeat(64), temporary: i !== 1, document: { kind: "stela-conversation", version: 1, id: `id${i}`, title: ["订单分析与季度对比", "orders", "检查异常数据"][i], createdAt: 1, updatedAt: 1, draft: "", connectionName: null, turns: [], sessionJsonl: "" } }]));
const recent = [...Object.values(snapshots).map(s => ({ path: s.path, sessionId: s.document.id, title: s.document.title, updatedAt: 5, temporary: s.temporary! })), ...Array.from({ length: 52 }, (_, i) => ({ path: `/vault/.stela/chat-sessions.local/history${i}.stela.chat`, sessionId: `history${i}`, title: `历史分析 ${i}`, updatedAt: 4, temporary: true }))];
Object.assign(window, { stela: { conversation: { protect: async () => {}, recent: async () => recent }, agent: { listHistory: async () => [{ sessionId: "legacy", deviceSlug: "device", title: "之前的会话", updatedAt: 2, createdAt: 1, isLocal: true }] } } });
useWorkspace.setState({ vaultPath: "/vault", tabs: [] });
useChatWorkspace.setState({ vault: "/vault", sidePaths: files, sidePath: files[0], recent });
useConversation.setState({ snapshots });
function Fixture() {
  const active = useChatWorkspace(s => s.sidePath);
  return <main className="h-screen bg-background text-foreground"><ChatControls side={!new URLSearchParams(location.search).has("main")} path={active ?? undefined} /><div className="p-8 text-sm text-muted-foreground">会话正文区域</div><button id="outside">外部按钮</button></main>;
}
void i18n.changeLanguage("zh").then(() => createRoot(document.getElementById("root")!).render(<Fixture />));
