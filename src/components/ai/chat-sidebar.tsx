import { useEffect } from "react";
import { ensureSidebarChat, useChatWorkspace } from "@/state/chat-workspace";
import { useWorkspace } from "@/state/workspace";
import { ConversationView } from "@/views/ConversationView";
import { ChatControls } from "./chat-controls";
import { useT } from "@/i18n/use-t";
export function ChatSidebar() {
  const t = useT();
  const path = useChatWorkspace(s => s.sidePath);
  const vault = useWorkspace(s => s.vaultPath);
  const mainChat = useWorkspace(s => s.tabs.find(tab => tab.id === s.activeTabId && tab.kind === "conversation")?.path);
  useEffect(() => {
    void ensureSidebarChat().catch(error => useChatWorkspace.setState({ error: String(error) }));
  }, [vault, path]);
  if (path && path !== mainChat) return <ConversationView path={path} side />;
  return <section className="flex min-h-0 flex-1 flex-col"><ChatControls side /><div className="flex flex-1 items-center justify-center p-4 text-sm text-muted-foreground">
    {mainChat ? <button onClick={() => useChatWorkspace.getState().move(mainChat, "side")}>{t("chat.dock")}</button>
      : <button onClick={() => { void useChatWorkspace.getState().create("side").catch(error => useChatWorkspace.setState({ error: String(error) })); }}>{t("conversation.new")}</button>}
  </div></section>;
}
