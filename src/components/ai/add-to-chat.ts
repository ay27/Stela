import { getRunContext } from "@/editor/runsql/run-context";
import { useAgentPanel, type AgentDraftAttachmentInput } from "@/state/agent-panel";
import { useLayout } from "@/state/layout";
import { useWorkspace } from "@/state/workspace";

function relativeToVault(path: string | null | undefined): string | undefined {
  if (!path) return undefined;
  const vaultPath = useWorkspace.getState().vaultPath;
  if (!vaultPath) return path;
  const normalizedVault = vaultPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = path.replace(/\\/g, "/");
  if (normalizedPath === normalizedVault) return undefined;
  if (normalizedPath.startsWith(`${normalizedVault}/`)) {
    return normalizedPath.slice(normalizedVault.length + 1);
  }
  return normalizedPath;
}

function currentSourcePath(): string | undefined {
  return relativeToVault(getRunContext()?.path);
}

function fallbackLabel(prefix: string, text: string): string {
  const firstLine = text.trim().split(/\r?\n/, 1)[0]?.trim();
  return firstLine ? `${prefix}: ${firstLine.slice(0, 40)}` : prefix;
}

function openAgentChat(): void {
  const panel = useAgentPanel.getState();
  panel.ensureDefaultNote(currentSourcePath());
  useLayout.getState().focusAgentPanel();
}

export function addAttachmentToChat(attachment: AgentDraftAttachmentInput): void {
  useAgentPanel.getState().addToChat(attachment);
}

export function addSelectionToChat(text: string, label = "Selection", sourcePath = currentSourcePath()): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  addAttachmentToChat({
    kind: "selection",
    label: fallbackLabel(label, trimmed),
    text: trimmed,
    sourcePath,
  });
  return true;
}

export function addRunsqlToChat(sql: string, label = "RunSQL block", sourcePath = currentSourcePath()): boolean {
  const trimmed = sql.trim();
  if (!trimmed) return false;
  addAttachmentToChat({
    kind: "runsql",
    label: fallbackLabel(label, trimmed),
    sql: trimmed,
    sourcePath,
  });
  return true;
}

function selectedText(): string {
  return window.getSelection()?.toString().trim() ?? "";
}

function nearestCodeBlockText(): { kind: "runsql" | "code"; text: string } | null {
  const active = document.activeElement as HTMLElement | null;
  const block = active?.closest<HTMLElement>(".stela-cb");
  if (!block) return null;
  const text = block.querySelector<HTMLElement>(".cm-content")?.textContent?.trim() ?? "";
  if (!text) return null;
  return { kind: block.classList.contains("stela-cb--runsql") ? "runsql" : "code", text };
}

export function addFocusedContextToChat(): boolean {
  if (addSelectionToChat(selectedText())) return true;

  const codeBlock = nearestCodeBlockText();
  if (codeBlock?.kind === "runsql") return addRunsqlToChat(codeBlock.text);
  if (codeBlock?.kind === "code") return addSelectionToChat(codeBlock.text, "Code block");

  openAgentChat();
  return true;
}
