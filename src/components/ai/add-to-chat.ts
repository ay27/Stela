import { getRunContext } from "@/editor/runsql/run-context";
import type { AgentMessageResourceInput } from "@shared/types";
import { useAgentPanel } from "@/state/agent-panel";
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
  useLayout.getState().focusAgentPanel();
}

export function addAttachmentToChat(attachment: AgentMessageResourceInput): void {
  useAgentPanel.getState().addToChat(attachment);
}

export function addSelectionToChat(
  text: string,
  label = "Selection",
  sourcePath = currentSourcePath(),
  nthInFile = 0,
): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  addAttachmentToChat({
    kind: "selection",
    label: fallbackLabel(label, trimmed),
    text: trimmed,
    sourcePath,
    locator: sourcePath ? { keyword: trimmed, nthInFile } : undefined,
  });
  return true;
}

export function addRunsqlToChat(
  sql: string,
  label = "RunSQL block",
  sourcePath = currentSourcePath(),
  blockId?: string | null,
  blockIndex?: number,
): boolean {
  const trimmed = sql.trim();
  if (!trimmed) return false;
  addAttachmentToChat({
    kind: "runsql",
    label: fallbackLabel(label, trimmed),
    sql: trimmed,
    sourcePath,
    locator: sourcePath ? { blockId, blockIndex, keyword: trimmed, nthInFile: 0 } : undefined,
  });
  return true;
}

function selectedText(): { text: string; nthInFile: number } {
  const selection = window.getSelection();
  const text = selection?.toString().trim() ?? "";
  if (!selection?.anchorNode || !text) return { text, nthInFile: 0 };
  const anchor = selection.anchorNode.nodeType === Node.ELEMENT_NODE
    ? selection.anchorNode as Element
    : selection.anchorNode.parentElement;
  const root = anchor?.closest(".milkdown, [data-milkdown-root]");
  if (!root) return { text, nthInFile: 0 };
  try {
    const prefix = document.createRange();
    prefix.selectNodeContents(root);
    prefix.setEnd(selection.anchorNode, selection.anchorOffset);
    const before = prefix.toString();
    let nthInFile = 0;
    let offset = 0;
    while ((offset = before.indexOf(text, offset)) >= 0) {
      nthInFile += 1;
      offset += Math.max(1, text.length);
    }
    return { text, nthInFile };
  } catch {
    return { text, nthInFile: 0 };
  }
}

function nearestCodeBlockText(): { kind: "runsql" | "code"; text: string; blockId?: string | null; blockIndex?: number } | null {
  const active = document.activeElement as HTMLElement | null;
  const block = active?.closest<HTMLElement>(".stela-cb");
  if (!block) return null;
  const text = block.querySelector<HTMLElement>(".cm-content")?.textContent?.trim() ?? "";
  if (!text) return null;
  const kind = block.classList.contains("stela-cb--runsql") ? "runsql" : "code";
  const runsqlBlocks = kind === "runsql"
    ? Array.from(document.querySelectorAll<HTMLElement>(".stela-cb--runsql"))
    : [];
  return {
    kind,
    text,
    blockId: block.querySelector<HTMLElement>(".stela-cb__id")?.textContent?.trim() || null,
    blockIndex: kind === "runsql" ? Math.max(0, runsqlBlocks.indexOf(block)) : undefined,
  };
}

export function addFocusedContextToChat(): boolean {
  const selection = selectedText();
  if (addSelectionToChat(selection.text, "Selection", currentSourcePath(), selection.nthInFile)) return true;

  const codeBlock = nearestCodeBlockText();
  if (codeBlock?.kind === "runsql") {
    return addRunsqlToChat(codeBlock.text, "RunSQL block", currentSourcePath(), codeBlock.blockId, codeBlock.blockIndex);
  }
  if (codeBlock?.kind === "code") return addSelectionToChat(codeBlock.text, "Code block");

  openAgentChat();
  return true;
}
