import type { IConversationSummary, IConversationSnapshot } from "@shared/conversation";
import type { AgentHistoryRef, AgentHistorySummary } from "@shared/types";

export function chatFileLabel(path: string, vault: string | null) {
  const normalized = path.replace(/\\/g, "/");
  const root = vault?.replace(/\\/g, "/").replace(/\/+$/, "");
  const relative = root && normalized.startsWith(root + "/") ? normalized.slice(root.length + 1) : normalized;
  const split = relative.lastIndexOf("/");
  return { title: relative.slice(split + 1), directory: split < 0 ? "." : relative.slice(0, split) };
}
export function chatTabTitle(snapshot: IConversationSnapshot | undefined, path: string) {
  if (!snapshot || !snapshot.temporary) return chatFileLabel(path, null).title;
  const d = snapshot.document;
  return d.title === "Chat" ? (d.turns[0]?.input || d.draft).replace(/\s+/g, " ").trim().slice(0, 60) || d.title : d.title;
}
export interface IChatHistoryItem {
  key: string; title: string; directory?: string; updatedAt: number;
  path?: string; legacy?: AgentHistoryRef;
}
export function chatHistoryItems(recent: IConversationSummary[], legacy: AgentHistorySummary[], vault: string | null): IChatHistoryItem[] {
  const items = new Map<string, IChatHistoryItem>();
  for (const item of legacy) items.set(item.sessionId, { key: item.sessionId, title: item.title, updatedAt: item.updatedAt, legacy: { deviceSlug: item.deviceSlug, sessionId: item.sessionId } });
  for (const item of [...recent].sort((a, b) => Number(b.temporary) - Number(a.temporary))) {
    items.set(item.sessionId, { key: item.sessionId, updatedAt: item.updatedAt, path: item.path,
      ...(item.temporary ? { title: item.title } : chatFileLabel(item.path, vault)) });
  }
  return [...items.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key));
}
