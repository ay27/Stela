import { useChatWorkspace } from "@/state/chat-workspace";

/** New Chat is temporary until the user explicitly saves it. */
export async function createSqlConversation(_directory?: string) {
  return useChatWorkspace.getState().create("main");
}
