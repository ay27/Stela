/**
 * Vault 文件 watcher（v0.2 #7）。
 *
 * 职责：
 *   1. 在 vault 切换时启动 / 停止 chokidar 递归 watcher
 *   2. 过滤掉应用自身写入的事件（app-owned suppress）
 *   3. 过滤 `.stela.sqlite*` / `.stela/` / `.git/` / 隐藏文件等噪音
 *   4. 把短时间内的多条事件合并成 batch 通过事件 channel 广播给 renderer
 *
 * 不做的事：
 *   - 不做 rename 推断（remove + add 自然能在 renderer 侧实现"先删再建"逻辑）
 *   - 不做 polling 兜底（chokidar 默认 native fs events，跨平台够用；后续如有
 *     网络盘 / Docker 卷反馈再开 usePolling）
 *
 * 注意：chokidar 是 Node 模块；在 main 进程使用，**不能**直接被 renderer 引用。
 */

import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";

import type {
  VaultExternalChangePayload,
  VaultFsEvent,
  VaultFsEventType,
} from "@shared/ipc-events";

import { getLogger } from "./logger";

const log = getLogger("vault-watcher");

/** 事件合并窗口（ms）。窗口越大越省 IPC，但用户感知刷新会更迟。 */
const BATCH_DELAY_MS = 200;

/** app-owned 写入抑制时长（ms）。从 vault-fs.notifySelfWrite 落到 chokidar
 *  事件回调之间的最长抖动；实测 macOS fsevents 通常 < 80ms，留 1.5s 余量
 *  覆盖 GC / WAL 等场景。 */
const SUPPRESS_TTL_MS = 1500;

/**
 * 应用自身写入的路径 → 过期时间戳。chokidar 事件命中时若仍在 TTL 内则吞掉。
 * Map 而非 Set 是为了支持过期判断；过期 key 在每次 sweep / 命中时主动清理。
 */
const suppressed = new Map<string, number>();

interface WatcherRuntime {
  vaultPath: string;
  watcher: FSWatcher;
  /** 待 flush 的事件队列，flushTimer 触发时一次性广播 */
  queue: VaultFsEvent[];
  flushTimer: ReturnType<typeof setTimeout> | null;
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

function attachHandlers(rt: WatcherRuntime): void {
  const handle = (
    type: VaultFsEventType,
    isDir: boolean,
    absPath: string,
  ) => {
    if (shouldIgnore(absPath, rt.vaultPath)) return;
    // self-write suppress 只对 `changed` 事件生效。
    //
    // 背景：suppress 的唯一目的是防止 EditorView 把自己 onPersist 写回的 .md
    // 识别为外部修改而弹 conflict banner / reload。`applyExternalEvents`
    // 也只会因 changed/removed 改 tab 状态。
    //
    // 反过来：`added` 事件不会触发任何 tab 状态变化（新文件不会命中已打开
    // 的 tab 路径），却是 FileTree / vault-index 等订阅者唯一的"新增文件"
    // 信号。如果一并 suppress，粘贴附件 / createFile 等场景下文件树永远
    // 不刷新。`removed` 类似——renderer 主动删除的入口已经各自调过
    // closeTabsForPath，watcher 这条路只是给 FileTree 等订阅者兜底刷新。
    if (!isDir && type === "changed" && isSuppressed(absPath)) return;
    enqueue(rt, { type, path: absPath, isDir });
  };

  rt.watcher.on("add", (p) => handle("added", false, p));
  rt.watcher.on("addDir", (p) => handle("added", true, p));
  rt.watcher.on("change", (p) => handle("changed", false, p));
  rt.watcher.on("unlink", (p) => handle("removed", false, p));
  rt.watcher.on("unlinkDir", (p) => handle("removed", true, p));
  rt.watcher.on("error", (err) => {
    log.error("watcher error", { err: (err as Error).message });
  });
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
  let watcher: FSWatcher;
  try {
    watcher = chokidar.watch(vaultPath, {
      ignoreInitial: true,
      persistent: true,
      // 避免大型 vault 启动期 IO 抖动：暂停发送直到文件 size 稳定（chokidar 默认行为，显式写一下）
      awaitWriteFinish: {
        stabilityThreshold: 150,
        pollInterval: 50,
      },
      // 跳过 chokidar 内部对 .stela / .git 等目录的 stat：节省 fd 与 watcher slot
      ignored: (p: string) => {
        if (p === vaultPath) return false;
        return shouldIgnore(p, vaultPath);
      },
    });
  } catch (err) {
    log.error("chokidar.watch failed", {
      vaultPath,
      err: (err as Error).message,
    });
    return;
  }
  runtime = {
    vaultPath,
    watcher,
    queue: [],
    flushTimer: null,
    broadcast: broadcaster,
  };
  attachHandlers(runtime);
  log.info("vault watcher started", { vaultPath });
}

export async function stop(): Promise<void> {
  if (!runtime) return;
  const rt = runtime;
  runtime = null;
  if (rt.flushTimer) {
    clearTimeout(rt.flushTimer);
    rt.flushTimer = null;
  }
  rt.queue = [];
  try {
    await rt.watcher.close();
  } catch (err) {
    log.warn("watcher close failed", { err: (err as Error).message });
  }
  log.info("vault watcher stopped", { vaultPath: rt.vaultPath });
}
