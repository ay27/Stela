import type { AgentMessageResource } from "@shared/types";
import { withAgentResourceId } from "@shared/agent-message";
import { parseRunsqlFences } from "@shared/runsql-fences";
import { useWorkspace } from "@/state/workspace";
import { getTabBuffer } from "@/state/tab-buffer";
import { ensureAutocompleteFor } from "@/editor/runsql/fetch-schema";
import { fuzzyFilter } from "@/lib/fuzzy";

function relative(path: string, vault: string): string { return path.startsWith(vault + "/") ? path.slice(vault.length + 1) : path; }
export async function composerResourceCandidates(query: string, connectionName: string | null): Promise<AgentMessageResource[]> {
  const vault = useWorkspace.getState().vaultPath;
  if (!vault) return [];
  const [files, canvases, tables] = await Promise.all([
    window.stela.index.listCandidates(query, 32),
    window.stela.search.listFiles(vault, [".stela.canvas"]),
    connectionName ? ensureAutocompleteFor(connectionName).catch(() => []) : Promise.resolve([]),
  ]);
  const resources: AgentMessageResource[] = [
    ...files.filter(f => f.kind === "file" && f.detail && /\.md$/i.test(f.detail)).map(f => {
      const path = relative(f.detail!, vault);
      return withAgentResourceId({ kind: "note", path, label: path.split("/").pop()! });
    }),
    ...canvases.map(file => { const path = relative(file, vault); return withAgentResourceId({ kind: "canvas", path, label: path.split("/").pop()! }); }),
    ...tables.map(table => withAgentResourceId({ kind: "table", table, label: table, connectionName })),
  ];
  const unique = [...new Map(resources.map(r => [r.id, r])).values()];
  return query.trim() ? fuzzyFilter(query.trim(), unique, r => `${r.label} ${"path" in r ? r.path : ""}`, 24) : unique.slice(0, 24);
}
export async function composerRunsqlCandidates(notePath: string): Promise<AgentMessageResource[]> {
  const workspace = useWorkspace.getState();
  const vault = workspace.vaultPath;
  if (!vault) return [];
  const path = notePath.startsWith("/") ? notePath : `${vault}/${notePath}`;
  const tab = workspace.tabs.find(t => t.path === path);
  const raw = (tab && getTabBuffer(tab.id)) ?? await window.stela.vault.readFile(path);
  return parseRunsqlFences(raw).map(block => withAgentResourceId({
    kind: "runsql", label: `${notePath.split("/").pop()} · ${block.index + 1} · ${block.sql.trim().split("\n")[0]?.slice(0, 120) || "SQL"}`,
    sql: block.sql, sourcePath: relative(path, vault),
    locator: { blockId: block.blockId ?? undefined, blockIndex: block.index, line: raw.slice(0, block.codeStart).split("\n").length },
  })).filter(r => r.kind === "runsql" && r.sql.trim());
}
