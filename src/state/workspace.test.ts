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

console.log("workspace tests passed.");
