/**
 * Vault 文件 watcher（v0.2 #7）。
 *
 * 职责：
 *   1. 在 vault 切换时启动 / 停止原生递归 watcher
 *   2. 过滤掉应用自身写入的事件（app-owned suppress）
 *   3. 过滤 `.stela.sqlite*` / `.stela/` / `.git/` / 隐藏文件等噪音
 *   4. 把短时间内的多条事件合并成 batch 通过事件 channel 广播给 renderer
 *
 * 不做的事：
 *   - 不做 rename 推断（remove + add 自然能在 renderer 侧实现"先删再建"逻辑）
 *   - 不做 polling 兜底；网络盘 / Docker 卷出现反馈时再单独处理
 *
 * 注意：@parcel/watcher 是 Node 原生模块；在 main 进程使用，**不能**直接被 renderer 引用。
 */

import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import parcelWatcher from "@parcel/watcher";

import type {
  VaultExternalChangePayload,
  VaultFsEvent,
  VaultFsEventType,
} from "@shared/ipc-events";

import { getLogger } from "./logger";

const log = getLogger("vault-watcher");

/** 事件合并窗口（ms）。窗口越大越省 IPC，但用户感知刷新会更迟。 */
const BATCH_DELAY_MS = 200;

/** app-owned 写入抑制时长（ms）。从 vault-fs.notifySelfWrite 落到原生
 *  事件回调之间的最长抖动；实测 macOS fsevents 通常 < 80ms，留 1.5s 余量
 *  覆盖 GC / WAL 等场景。 */
const SUPPRESS_TTL_MS = 1500;
const WRITE_STABILITY_MS = 150;

/**
 * 应用自身写入的路径 → 过期时间戳。原生 watcher 事件命中时若仍在 TTL 内则吞掉。
 * Map 而非 Set 是为了支持过期判断；过期 key 在每次 sweep / 命中时主动清理。
 */
const suppressed = new Map<string, number>();

interface WatcherRuntime {
  vaultPath: string;
  subscription: { unsubscribe(): Promise<void> };
  directories: Set<string>;
  /** 待 flush 的事件队列，flushTimer 触发时一次性广播 */
  queue: VaultFsEvent[];
  flushTimer: ReturnType<typeof setTimeout> | null;
  pendingUpdates: Map<string, ReturnType<typeof setTimeout>>;
  /** main → renderer 广播的回调（webContents.send 的薄封装）；setBroadcaster 注入 */
  broadcast: (payload: VaultExternalChangePayload) => void;
}

let runtime: WatcherRuntime | null = null;

let broadcaster: ((payload: VaultExternalChangePayload) => void) | null = null;

/**
 * Main 进程内部的事件订阅者。renderer 走 broadcaster 的 webContents.send，main
 * 内部模块（如 vault-index）走这条路：watcher flush 时 broadcaster 与所有
 * subscribers 都会被触发，互不干扰。
 *
 * 设计上不复用 broadcaster——broadcaster 是 IPC 注入点（启动顺序敏感、可能
 * 暂时为 null），main-internal 订阅者期望可靠送达。
 */
const subscribers = new Set<
  (payload: VaultExternalChangePayload) => void
>();

export function subscribe(
  fn: (payload: VaultExternalChangePayload) => void,
): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/**
 * 注入广播实现。main 进程在创建 BrowserWindow 后调一次：
 *   setBroadcaster((p) => mainWindow.webContents.send(channel, p))
 * 这样 vault-watcher 不直接依赖 BrowserWindow。
 */
export function setBroadcaster(
  fn: (payload: VaultExternalChangePayload) => void,
): void {
  broadcaster = fn;
  if (runtime) runtime.broadcast = fn;
}

/**
 * 标记一段时间内不响应该路径的 `changed` 事件。vault-fs 在 writeFile /
 * createFile / renamePath / deletePath 等"应用自身发起的写"成功后调用。
 *
 * 注意：suppress **只**作用于 chokidar 的 `change` 事件（即 EditorView
 * onPersist 把当前 .md 写回时的回声）。`add` / `unlink` 事件**不**被吞掉，
 * 因为：
 *   - `applyExternalEvents` 不会因 added 改 tab 状态，FileTree 等订阅者反而
 *     需要这条信号刷新文件列表（例如粘贴附件后的 `<vault>/assets/` 新增）
 *   - 删除入口（FileTree 右键 / 重命名）已经在 renderer 主动调过
 *     closeTabsForPath / renameTabsForPath，watcher 推 unlink 只是兜底刷新树
 *
 * 实现细节：renamePath 会触发 unlink(from) + add(to)，suppress 此处不影响——
 * 这两类事件本就不会被 suppress 吞。
 */
export function notifySelfWrite(absPath: string): void {
  suppressed.set(normalizeKey(absPath), Date.now() + SUPPRESS_TTL_MS);
}

/** Main-process tools that mutate vault files intentionally still need renderer/index invalidation. */
export function notifyFileChanged(absPath: string): void {
  const rt = runtime;
  if (!rt) return;
  if (shouldIgnore(absPath, rt.vaultPath)) return;
  enqueue(rt, { type: "changed", path: absPath, isDir: false });
}

function normalizeKey(p: string): string {
  // 在 Linux / macOS 上路径区分大小写；Windows 习惯不区分，但 chokidar 给出的
  // 路径与传入 watch 的根路径大小写一致，这里不做大小写归一，避免误抑制。
  return path.resolve(p);
}

function isSuppressed(absPath: string): boolean {
  const key = normalizeKey(absPath);
  const expireAt = suppressed.get(key);
  if (!expireAt) return false;
  if (Date.now() > expireAt) {
    suppressed.delete(key);
    return false;
  }
  return true;
}

function shouldIgnore(absPath: string, vaultPath: string): boolean {
  const rel = path.relative(vaultPath, absPath);
  if (!rel || rel.startsWith("..")) return true;
  // POSIX 化分段比较，避免 Windows 反斜杠导致的 startsWith 误判
  const parts = rel.split(/[\\/]/);
  for (const seg of parts) {
    if (!seg) continue;
    if (seg === ".stela") return true;
    if (seg === ".git") return true;
    if (seg === "node_modules") return true;
    if (seg.startsWith(".stela.sqlite")) return true; // .stela.sqlite, -wal, -shm
    if (seg.startsWith(".")) {
      // 其它隐藏：与 vault-fs.shouldSkip 行为一致——避免 .DS_Store 等噪音
      return true;
    }
  }
  return false;
}

/** 同一 batch 内合并 type+path+isDir 完全相同的事件（迟到的 fsevents 回声很常见）。 */
function coalesceEvents(events: VaultFsEvent[]): VaultFsEvent[] {
  const seen = new Set<string>();
  const out: VaultFsEvent[] = [];
  for (const e of events) {
    const key = `${e.type}\0${e.path}\0${e.isDir ? 1 : 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

function enqueue(rt: WatcherRuntime, event: VaultFsEvent): void {
  rt.queue.push(event);
  if (rt.flushTimer) return;
  rt.flushTimer = setTimeout(() => {
    rt.flushTimer = null;
    if (rt.queue.length === 0) return;
    const events = coalesceEvents(rt.queue);
    rt.queue = [];
    const payload: VaultExternalChangePayload = {
      vaultPath: rt.vaultPath,
      events,
    };
    try {
      rt.broadcast(payload);
    } catch (err) {
      log.error("broadcast vault external change failed", err);
    }
    // main-internal 订阅者（vault-index 等）。失败一个不影响其它。
    for (const sub of subscribers) {
      try {
        sub(payload);
      } catch (err) {
        log.warn("vault-watcher subscriber threw", {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }, BATCH_DELAY_MS);
}

async function collectDirectories(vaultPath: string): Promise<Set<string>> {
  const directories = new Set<string>([normalizeKey(vaultPath)]);
  const pending = [vaultPath];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn("scan watcher directories failed", {
          dir,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(dir, entry.name);
      if (shouldIgnore(child, vaultPath)) continue;
      directories.add(normalizeKey(child));
      pending.push(child);
    }
  }
  return directories;
}

function removeDirectoryAndChildren(rt: WatcherRuntime, absPath: string): boolean {
  const key = normalizeKey(absPath);
  const isDir = rt.directories.has(key);
  for (const directory of rt.directories) {
    if (directory === key || directory.startsWith(`${key}${path.sep}`)) {
      rt.directories.delete(directory);
    }
  }
  return isDir;
}

async function classifyPresentPath(
  rt: WatcherRuntime,
  absPath: string,
): Promise<{ isDir: boolean } | null> {
  try {
    const stats = await lstat(absPath);
    const isDir = stats.isDirectory();
    if (isDir) rt.directories.add(normalizeKey(absPath));
    return { isDir };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("stat watcher event failed", {
        path: absPath,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  }
}

function publishEvent(
  rt: WatcherRuntime,
  type: VaultFsEventType,
  absPath: string,
  isDir: boolean,
): void {
  if (shouldIgnore(absPath, rt.vaultPath)) return;
  // self-write suppress 只对 `changed` 事件生效；added / removed 仍必须让
  // FileTree 与索引刷新，即使它们是应用自己发起的写入。
  if (!isDir && type === "changed" && isSuppressed(absPath)) return;
  enqueue(rt, { type, path: absPath, isDir });
}

function scheduleUpdate(rt: WatcherRuntime, absPath: string): void {
  const key = normalizeKey(absPath);
  const pending = rt.pendingUpdates.get(key);
  if (pending) clearTimeout(pending);
  rt.pendingUpdates.set(
    key,
    setTimeout(() => {
      rt.pendingUpdates.delete(key);
      void classifyPresentPath(rt, absPath).then((entry) => {
        if (entry && !entry.isDir) publishEvent(rt, "changed", absPath, false);
      });
    }, WRITE_STABILITY_MS),
  );
}

function handleParcelEvents(
  rt: WatcherRuntime,
  events: Array<{ path: string; type: "create" | "update" | "delete" }>,
): void {
  for (const event of events) {
    const absPath = path.resolve(event.path);
    if (shouldIgnore(absPath, rt.vaultPath)) continue;
    if (event.type === "delete") {
      const pending = rt.pendingUpdates.get(normalizeKey(absPath));
      if (pending) clearTimeout(pending);
      rt.pendingUpdates.delete(normalizeKey(absPath));
      publishEvent(rt, "removed", absPath, removeDirectoryAndChildren(rt, absPath));
      continue;
    }
    if (event.type === "create") {
      void classifyPresentPath(rt, absPath).then((entry) => {
        if (entry) publishEvent(rt, "added", absPath, entry.isDir);
      });
      continue;
    }
    scheduleUpdate(rt, absPath);
  }
}

/**
 * 启动针对 vaultPath 的 watcher。如果当前已绑定到同一路径，no-op；不同路径则
 * 先停掉旧的再起新的。vaultPath=null 表示停止 watcher（vault 关闭场景）。
 */
export async function start(vaultPath: string | null): Promise<void> {
  if (runtime && runtime.vaultPath === vaultPath) return;
  await stop();
  if (!vaultPath) return;
  if (!broadcaster) {
    // 在没有 BrowserWindow 之前调用——记录后跳过；renderer ready 后会再触发
    log.warn(
      "no broadcaster registered; vault watcher will not deliver events",
      { vaultPath },
    );
    return;
  }
  let subscription: { unsubscribe(): Promise<void> };
  try {
    const directories = await collectDirectories(vaultPath);
    subscription = await parcelWatcher.subscribe(vaultPath, (err, events) => {
      if (err) {
        log.error("native watcher error", { err: err.message });
        return;
      }
      const rt = runtime;
      if (!rt || rt.vaultPath !== vaultPath) return;
      handleParcelEvents(rt, events);
    });
    runtime = {
      vaultPath,
      subscription,
      directories,
      queue: [],
      flushTimer: null,
      pendingUpdates: new Map(),
      broadcast: broadcaster,
    };
  } catch (err) {
    log.error("native watcher subscribe failed", {
      vaultPath,
      err: (err as Error).message,
    });
    return;
  }
  log.info("vault watcher started", { vaultPath });
}

export async function stop(): Promise<void> {
  const rt = detachRuntime();
  if (!rt) return;
  try {
    await rt.subscription.unsubscribe();
  } catch (err) {
    log.warn("native watcher unsubscribe failed", { err: (err as Error).message });
  }
  log.info("vault watcher stopped", { vaultPath: rt.vaultPath });
}

/**
 * Electron 已进入最终退出阶段时调用。此时不等待 native unsubscribe：
 * vault 切换和手动关闭 vault 仍必须使用 stop() 释放订阅。
 */
export function releaseForAppQuit(): void {
  const rt = detachRuntime();
  if (rt) log.info("vault watcher released for app quit", { vaultPath: rt.vaultPath });
}

function detachRuntime(): WatcherRuntime | null {
  if (!runtime) return null;
  const rt = runtime;
  runtime = null;
  if (rt.flushTimer) {
    clearTimeout(rt.flushTimer);
    rt.flushTimer = null;
  }
  for (const timer of rt.pendingUpdates.values()) clearTimeout(timer);
  rt.pendingUpdates.clear();
  rt.queue = [];
  return rt;
}
