import { useEffect, useState } from "react";
import { useChatWorkspace } from "@/state/chat-workspace";
import { useWorkspace } from "@/state/workspace";
import { ConversationView } from "@/views/ConversationView";
import { ChatControls } from "./chat-controls";
import { useT } from "@/i18n/use-t";
let preparing: Promise<unknown> | null = null;
export function ChatSidebar() {
  const t = useT();
  const path = useChatWorkspace(s => s.sidePath);
  const vault = useWorkspace(s => s.vaultPath);
  const mainChat = useWorkspace(s => s.tabs.find(tab => tab.id === s.activeTabId && tab.kind === "conversation")?.path);
  const [error, setError] = useState("");
  useEffect(() => {
    useChatWorkspace.getState().bind();
    if (!vault || useChatWorkspace.getState().sidePath || mainChat || preparing) return;
    preparing = useChatWorkspace.getState().create("side").catch(e => setError(String(e))).finally(() => { preparing = null; });
  }, [vault, path, mainChat]);
  if (path && path !== mainChat) return <ConversationView path={path} side />;
  return <section className="flex min-h-0 flex-1 flex-col"><ChatControls side /><div className="flex flex-1 items-center justify-center p-4 text-sm text-muted-foreground">
    {mainChat ? <button onClick={() => useChatWorkspace.getState().move(mainChat, "side")}>{t("chat.dock")}</button> : error || t("chat.empty")}
  </div></section>;
}
