/**
 * Renderer 端的 vault watcher 订阅器（v0.2 #7）。
 *
 * 职责：
 *   1. 通过 `window.stela.vault.onExternalChange` 订阅 main 推送的事件 batch
 *   2. 把事件分发给三个 store：
 *      - `useFileTree`：直接对受影响的（且已被缓存过的）父目录重跑 listDir
 *      - `useWorkspace.applyExternalEvents`：标 tab 的 externalChange / reload
 *      - `useSearch.markStale`：bump staleToken，让 SearchPanel 提示用户重跑
 *   3. 提供 `installVaultWatcherSubscriber()` 给 App 顶层 useEffect 调用
 *
 * 不做的事：
 *   - 不在这里做 schema 校验。preload 已经把 channel / 来源约束死了，main 推送
 *     的 payload 是受控的；renderer 端只读用。
 *   - 不在这里做用户提示 UI。banner / "刷新搜索" 由各自 view 组件渲染。
 */

import type { VaultFsEvent } from "@shared/ipc-events";

import { clearWikiResolverCache } from "@/editor/wiki";
import { readFile, listDir } from "@/services/fs";
import { getKnownDiskContent } from "@/services/note-save-tracker";
import { useFileTree } from "@/state/file-tree";
import { useSearch } from "@/state/search";
import { useWorkspace } from "@/state/workspace";

function parentDirOf(p: string): string | null {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (idx <= 0) return null;
  return p.slice(0, idx);
}

/**
 * 收集本批事件涉及的 "已缓存父目录" 集合。
 *
 * 只刷新已经被 listDir 过的目录——避免对从未展开过的目录额外发起 IPC。
 * 用户没看过的子树，下次展开时仍走懒加载即可。
 */
function affectedCachedDirs(events: VaultFsEvent[]): string[] {
  const cache = useFileTree.getState().children;
  const dirs = new Set<string>();
  for (const ev of events) {
    const parent = parentDirOf(ev.path);
    if (parent && parent in cache) dirs.add(parent);
    // 路径本身是目录且其 children 已缓存（典型场景：watch 命中已展开目录的添加 / 删除）
    if (ev.isDir && ev.path in cache) dirs.add(ev.path);
  }
  return Array.from(dirs);
}

async function refreshDir(dirPath: string): Promise<void> {
  const store = useFileTree.getState();
  try {
    const rows = await listDir(dirPath);
    store.setChildren(dirPath, rows);
  } catch (err) {
    // listDir 失败：要么目录被删了，要么权限问题。直接清掉缓存条目，
    // FileTree 在用户再次展开时会重试并显示错误。
    const nextChildren = { ...store.children };
    delete nextChildren[dirPath];
    useFileTree.setState({ children: nextChildren });
    store.setError(
      dirPath,
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function verifyDirtyExternalChange(tabId: string): Promise<void> {
  const tab = useWorkspace.getState().tabs.find((t) => t.id === tabId);
  if (!tab?.path || !tab.dirty) return;
  if (tab.externalChange) return;

  let disk: string;
  try {
    disk = await readFile(tab.path);
  } catch {
    return;
  }

  const known = getKnownDiskContent(tab.path);
  if (known !== undefined && disk === known) {
    return;
  }

  const latest = useWorkspace.getState().tabs.find((t) => t.id === tabId);
  if (!latest?.dirty || latest.externalChange) return;

  useWorkspace.getState().markExternalChange(tabId, "changed");
}

function applyBatch(events: VaultFsEvent[]): void {
  if (events.length === 0) return;

  // 1. tab 状态：clean → reload；dirty + changed → 返回待验证 id；removed → banner
  const pendingDirtyChanged =
    useWorkspace.getState().applyExternalEvents(events);
  for (const tabId of pendingDirtyChanged) {
    void verifyDirtyExternalChange(tabId);
  }

  // 2. 搜索结果：任何文件级事件都让结果可能 stale
  if (events.some((e) => !e.isDir)) {
    useSearch.getState().markStale();
  }

  // 3. 文件树缓存：只刷新已加载过的父目录，限制 IPC 量
  const dirs = affectedCachedDirs(events);
  for (const d of dirs) void refreshDir(d);

  // 4. wiki link resolver 缓存（v0.3 M1）：任何文件级事件都可能影响 [[…]] 的
  // 存在性判定。v0.3.0 暂时全清，足够；M2 上线 vault-index 后会改为按 target
  // 精确失效（INDEX_CHANGED 广播驱动）。
  if (events.some((e) => !e.isDir)) {
    clearWikiResolverCache();
  }
}

let unsubscribe: (() => void) | null = null;

/**
 * 安装订阅器。幂等：重复调用会先取消旧订阅再装新订阅，避免 React StrictMode
 * 双触 useEffect 时挂两遍。
 */
export function installVaultWatcherSubscriber(): () => void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  unsubscribe = window.stela.vault.onExternalChange((payload) => {
    applyBatch(payload.events);
  });
  return () => {
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  };
}
