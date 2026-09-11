import { useWorkspace } from "@/state/workspace";
import { useFileTree } from "@/state/file-tree";
import { createDir, listDir, pathExists } from "./fs";
import { scheduleAutoGit } from "./auto-git";
import { getIpcErrorCode } from "@/lib/ipc-error";
const preparingDirectories = new Map<string, Promise<void>>();
async function ensureChatDirectory(vault: string, parent: string) {
  const pending = preparingDirectories.get(parent);
  if (pending) return pending;
  const task = (async () => {
    if (await pathExists(parent)) return;
    try { await createDir(vault, parent); }
    catch (error) { if (getIpcErrorCode(error) !== "already_exists") throw error; }
    useFileTree.getState().setChildren(vault, await listDir(vault));
  })();
  preparingDirectories.set(parent, task);
  try { await task; } finally { preparingDirectories.delete(parent); }
}

export async function createSqlConversation(directory?: string) {
  const workspace = useWorkspace.getState();
  const vault = workspace.vaultPath;
  if (!vault) return;
  const parent = directory ?? `${vault.replace(/[/\\]+$/, "")}/Chats`;
  if (!directory) await ensureChatDirectory(vault, parent);
  const now = new Date();
  const title = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const file = await window.stela.conversation.create(parent, title);
  scheduleAutoGit("conversation-create");
  useFileTree.getState().setChildren(parent, await listDir(parent));
  workspace.openFile(file.path);
}
