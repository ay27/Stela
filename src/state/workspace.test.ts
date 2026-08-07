import assert from "node:assert/strict";

import { getTabBuffer, setTabBuffer } from "@/state/tab-buffer";

import { useWorkspace, type Tab } from "./workspace";

function resetWorkspace(tabs: Tab[]): void {
  useWorkspace.setState({
    tabs,
    activeTabId: tabs[0]?.id ?? null,
    mruTabIds: tabs.map((tab) => tab.id),
    pendingReveal: null,
  });
}

{
  const tab: Tab = {
    id: "file:/vault/note.md",
    kind: "file",
    title: "note.md",
    path: "/vault/note.md",
  };
  resetWorkspace([tab]);
  setTabBuffer(tab.id, "stale in-memory buffer");

  const pending = useWorkspace.getState().applyExternalEvents([
    { type: "changed", path: "/vault/note.md", isDir: false },
  ]);
  const next = useWorkspace.getState().tabs[0]!;

  assert.deepEqual(pending, []);
  assert.equal(getTabBuffer(tab.id), undefined);
  assert.equal(next.reloadToken, 1);
}

{
  const tab: Tab = {
    id: "file:/vault/dirty.md",
    kind: "file",
    title: "dirty.md",
    path: "/vault/dirty.md",
    dirty: true,
  };
  resetWorkspace([tab]);
  setTabBuffer(tab.id, "local dirty buffer");

  const pending = useWorkspace.getState().applyExternalEvents([
    { type: "changed", path: "/vault/dirty.md", isDir: false },
  ]);
  const next = useWorkspace.getState().tabs[0]!;

  assert.deepEqual(pending, [tab.id]);
  assert.equal(getTabBuffer(tab.id), "local dirty buffer");
  assert.equal(next.reloadToken, undefined);
}

{
  const canvasPath = "/vault/report.stela.canvas";
  resetWorkspace([]);
  useWorkspace.getState().openFile(canvasPath);
  useWorkspace.getState().openFile(canvasPath);
  assert.equal(useWorkspace.getState().tabs.length, 1);
  assert.equal(useWorkspace.getState().tabs[0]?.kind, "analysis");
  assert.equal(useWorkspace.getState().tabs[0]?.id, `file:${canvasPath}`);
}

{
  const canvasPath = "/vault/duplicate.stela.canvas";
  const duplicate: Tab = {
    id: `file:${canvasPath}`,
    kind: "analysis",
    title: "duplicate.stela.canvas",
    path: canvasPath,
  };
  resetWorkspace([duplicate, { ...duplicate }]);
  useWorkspace.getState().openFile(canvasPath);
  assert.equal(useWorkspace.getState().tabs.length, 1);
}

{
  const canvas: Tab = {
    id: "file:/vault/live.stela.canvas",
    kind: "analysis",
    title: "live.stela.canvas",
    path: "/vault/live.stela.canvas",
  };
  resetWorkspace([canvas]);
  useWorkspace.getState().applyExternalEvents([
    { type: "changed", path: canvas.path!, isDir: false },
  ]);
  assert.equal(useWorkspace.getState().tabs[0]?.reloadToken, 1);
}

{
  const note: Tab = {
    id: "file:/vault/current.md",
    kind: "file",
    title: "current.md",
    path: "/vault/current.md",
  };
  const canvas: Tab = {
    id: "file:/vault/background.stela.canvas",
    kind: "analysis",
    title: "background.stela.canvas",
    path: "/vault/background.stela.canvas",
  };
  resetWorkspace([note, canvas]);
  useWorkspace.getState().reloadTabFromBuffer(canvas.id);
  assert.equal(useWorkspace.getState().activeTabId, note.id);
  assert.equal(useWorkspace.getState().tabs[1]?.reloadToken, 1);
}

console.log("workspace tests passed.");
