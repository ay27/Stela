import { create } from "zustand";
import { pathExists, pickVault } from "@/services/fs";
import { electronStorage } from "@/services/storage/electron-storage";
import { loadUserCache, patchUserCache } from "@/services/user-cache";
import { useSettings } from "@/state/settings";
import { useConnections } from "@/state/connections";
import { usePluginsStore } from "@/services/plugins";
import { resetAutoGit, scheduleAutoGit, startAutoPull } from "@/services/auto-git";
import { refreshGitStatus } from "@/state/git";
import { clearTabBuffer } from "@/state/tab-buffer";
import type { VaultFsEvent } from "@shared/ipc-events";

/**
 * Tab 模型。
 *
 * 历史：v0.1 之前 "welcome" 是一个常驻 tab；为它在 close/pin/reorder/拖拽
 * 处处开豁免分支。重构后 Welcome 不再作为 tab 存在——`tabs` 真为空时
 * `Workspace` 直接渲染 `<WelcomeView />`（参考 obsidian 的 empty editor）。
 * `TabKind` 暂时只剩 `"file"`，但保留这个 union 以便未来扩展（settings / search 等）。
 */
export type TabKind = "file";

export interface Tab {
  id: string;
  kind: TabKind;
  title: string;
  path?: string;
  dirty?: boolean;
  /** 钉住的 tab 排在前面；设计上不可被「关闭其他/右侧/已保存」误关。 */
  pinned?: boolean;
  /**
   * Obsidian 风格的预览 tab。**全局至多 1 个**。
   *
   * - 文件树单击 → 复用该位置覆盖打开新文件
   * - 任意"承诺动作"自动升级为永久 tab：dirty=true / pin / 拖拽 / tab 双击 / 文件树双击
   * - 视觉上标题斜体且关闭按钮始终可见
   */
  ephemeral?: boolean;
  /**
   * 外部变更状态（v0.2 #7）。
   *   - `undefined`：无外部变更
   *   - `"changed"`：磁盘文件被外部改写 + 当前 tab dirty，等待用户 reload / keep
   *   - `"removed"`：磁盘文件被外部删除，等待用户关闭 tab
   *
   * "changed-clean"（dirty=false 时被外部改写）不进这里——会通过 `reloadToken`
   * 自动 reload，避免给用户加一个不必要的 banner。
   */
  externalChange?: "changed" | "removed";
  /**
   * 强制 EditorView 重读磁盘的递增令牌。watcher 检测到外部变更且当前 tab 不
   * dirty 时 +1；EditorView 把它放进 readFile 的 effect 依赖里。
   */
  reloadToken?: number;
  /**
   * Backlinks 面板（v0.3 双链 M3）的折叠状态。`undefined` 视为默认折叠。
   * 切 tab / 重新打开同一文件时该偏好仍跟随该 tab。
   */
  backlinksOpen?: boolean;
  /** 当前 tab 内正在执行的 RunSQL 数量；>0 时 TabBar 显示执行中。 */
  sqlRunningCount?: number;
}

/** 最近关闭历史栈上限。超过会从栈底丢弃。 */
const CLOSED_STACK_LIMIT = 20;

/**
 * 共享的 initialize promise。
 *
 * 让 `useSettings.initialize`、`ThemeProvider`、`AppShell` 等并发调用方都 await
 * 同一个 promise，避免：
 *   1. 重复执行 vault.setCurrent / storage.open
 *   2. settings.load 抢跑 vault.setCurrent 导致 main 端报 no_vault
 *
 * 完成后保留 promise（resolve 状态），后续调用走 fast-path return。重置只在
 * `closeVault` 显式发生（当前实现没有反复 init 的需求）。
 */
let initInFlight: Promise<void> | null = null;

/**
 * 一个被关闭的 file tab 的最小快照，用于 Mod+Shift+T 恢复。
 * 只保留 path/title——dirty 状态在外存（编辑器 buffer）已丢失，恢复后从磁盘重读。
 */
export interface ClosedTabSnapshot {
  path: string;
  title: string;
  /** Unix epoch ms，仅作展示/调试 */
  closedAt: number;
}

/** 来自搜索结果等处的"打开并滚到某行/锚点"请求。token 让相同定位的重复请求也能触发。 */
export interface PendingReveal {
  path: string;
  /**
   * 1-based 源码行号（相对于完整文件，含 frontmatter）。当 `nthInFile` 缺省时作为
   * fallback 定位走 LineMap；同时给了 keyword+nthInFile 时仅在 PM 命中不到第 N 个匹配
   * 的兜底场景（如 `<detail>` 被合并）下使用。
   */
  line?: number;
  /** 1-based 源码列号；当前仅 fallback 路径会用到，主路径不依赖 column。 */
  column?: number;
  /** heading slug（GitHub 风，由 heading-anchor plugin 生成）；与 line 二选一 */
  slug?: string;
  token: number;
  /** 搜索关键字：keyword + nthInFile 走 PM doc.descendants 精确定位。 */
  keyword?: string;
  /** 大小写敏感（与 SearchPanel 当前 toggle 对齐） */
  caseSensitive?: boolean;
  /**
   * 该 keyword 命中在该文件命中数组中的 0-based 索引。与 keyword 同时给出时走 keyword
   * 主路径——不依赖 LineMap，编辑后仍准。SearchPanel 在 groupByFile 后逐条标号。
   */
  nthInFile?: number;
}

export interface OpenFileOptions {
  title?: string;
  /** 1-based 源码行号；MilkdownEditor 会尝试滚动到对应 block 并短暂高亮 */
  scrollToLine?: number;
  /** 1-based 源码列号；仅作为 fallback 路径辅助 */
  scrollToColumn?: number;
  /** heading slug；优先级高于 scrollToLine（两者都给时以 slug 为准） */
  scrollToSlug?: string;
  /** 搜索关键字；与 nthInFile 配合走 PM doc.descendants 精确定位主路径 */
  keyword?: string;
  caseSensitive?: boolean;
  /** 0-based: 该 keyword 命中在该文件命中数组中的索引 */
  nthInFile?: number;
  /**
   * true 时按 ephemeral 预览语义打开（文件树单击专用）：
   *   - 命中已开 tab：复用，**保留**该 tab 当前 ephemeral 状态
   *   - 未命中、有现存 ephemeral：原地替换那个 ephemeral 为新文件（保留 idx）
   *   - 未命中、无 ephemeral：在末尾新建一个 ephemeral tab
   * 缺省/false：永久 tab 语义；命中且现有为 ephemeral 时自动升级为永久。
   */
  ephemeral?: boolean;
}

interface WorkspaceState {
  vaultPath: string | null;
  vaultReady: boolean;

  tabs: Tab[];
  /** 当前激活的 tab id；`tabs` 为空时为 null（此时 Workspace 渲染 Welcome 空态）。 */
  activeTabId: string | null;

  /**
   * 按"最近使用"排序的 tab id 列表（MRU，栈顶在前）。
   *
   * 用途：
   *   - `Ctrl+Tab` 切换器按 MRU 顺序列出 tab，与 VS Code / IntelliJ 行为一致：
   *     Ctrl+Tab 默认跳到"上一次活跃"的 tab，松开 Ctrl 完成切换
   *   - 未来可扩展给"关闭当前 tab 后跳到上次活跃 tab"等启发式
   *
   * 不变量：
   *   - `mruTabIds` 中的每个 id 都对应当前 `tabs` 中的某个 tab
   *   - `activeTabId` 非 null 时一定是 `mruTabIds[0]`
   *   - 不持久化（应用重启从空开始重建）
   */
  mruTabIds: string[];

  /** 最近关闭的 file tab 快照栈（栈顶最近）。Mod+Shift+T 弹一个出来重开。 */
  closedTabsStack: ClosedTabSnapshot[];

  /** MilkdownEditor 订阅此字段并消费；消费后应立即调用 consumeReveal */
  pendingReveal: PendingReveal | null;

  initialize: () => Promise<void>;
  chooseVault: () => Promise<void>;
  /** 直接按路径打开 vault（用于 Welcome 页 recent vaults / demo seed）。
   *  路径不存在会从 recent 列表移除并 alert，不切换 vault。 */
  openVaultByPath: (path: string) => Promise<void>;
  closeVault: () => Promise<void>;

  openFile: (path: string, optionsOrTitle?: string | OpenFileOptions) => void;
  /** 关闭指定 tab；id=null 时为 no-op（Welcome 空态下 Mod+W 不应崩）。 */
  closeTab: (id: string | null) => void;
  /** 关闭除目标 tab 外的所有可关闭 tab（保留 Welcome 与目标本身） */
  closeOtherTabs: (id: string) => void;
  /** 关闭目标 tab 右侧所有 tab（不动目标本身与左侧） */
  closeTabsToRight: (id: string) => void;
  /** 关闭所有 dirty=false 的 file tab（保留 Welcome 与未保存 tab） */
  closeSavedTabs: () => void;
  /** 弹出最近关闭栈顶 → openFile 重开。空栈时 no-op */
  reopenLastClosed: () => void;
  setActive: (id: string | null) => void;
  setDirty: (id: string, dirty: boolean) => void;
  getTabIdByPath: (path: string) => string | null;
  incrementSqlRunning: (id: string) => void;
  decrementSqlRunning: (id: string) => void;
  reloadTabFromBuffer: (id: string) => void;
  /** 把指定 ephemeral tab 升级为永久 tab；非 ephemeral 时 no-op。 */
  promoteEphemeral: (id: string) => void;
  /** 切换 tab 的 pinned 状态。pinned 的 tab 会被搬到 pinned 区末尾，
   *  unpinned 的 tab 会被搬到 unpinned 区开头（紧跟最后一个 pinned）。
   *  Welcome tab 不允许被 pin（它本来就在最前）。 */
  setPinned: (id: string, pinned: boolean) => void;
  /** 拖拽重排：把 sourceId 移到 targetId 前面；targetId=null 表示移到末尾。
   *  规则：Welcome 不能拖；pinned 与 unpinned 区不能跨界（跨界时 no-op）。 */
  reorderTab: (sourceId: string, targetId: string | null) => void;
  /** 文件被外部删除/移到回收站时，关闭所有指向 path（或其子路径）的 tab */
  closeTabsForPath: (path: string) => void;
  /** 文件/目录被重命名或移动时，把命中的 tab path/title/id 同步更新 */
  renameTabsForPath: (from: string, to: string) => void;
  /** 消费 pendingReveal —— Editor 完成滚动后调用 */
  consumeReveal: () => void;
  /**
   * 让文件树重新 reveal 当前活跃 file tab：bump pendingReveal.token，FileTree
   * 的 useEffect 监听到后会展开祖先 + 滚到目标行。无活跃 file tab 时 no-op。
   * Mod+Shift+E 与"定位当前文件"按钮共用此 action。
   */
  revealActiveFile: () => void;
  /** 用户确认接受外部变更：清掉 externalChange + 触发一次 reload */
  acceptExternalChange: (id: string) => void;
  /** 用户选择保留本地（忽略外部变更）：仅清掉 externalChange，不动 buffer */
  dismissExternalChange: (id: string) => void;
  /** Backlinks 面板折叠状态切换（v0.3 双链 M3） */
  setBacklinksOpen: (id: string, open: boolean) => void;
  /**
   * 把 main 进程 vault watcher 推送来的事件 batch 应用到 tab 状态（v0.2 #7）。
   *
   *   - 删除事件命中某 tab：标 externalChange="removed"，由 EditorView banner 提示
   *   - 修改事件 + 当前 tab dirty：不立即 banner，返回 tabId 供 subscriber 异步读盘比对
   *   - 修改事件 + 当前 tab clean：bump reloadToken 自动重读磁盘
   *   - 新增 / 目录事件：tab 维度无影响（FileTree 自己订阅刷新）
   *
   * @returns 需要异步验证「是否真外部变更」的 dirty tab id 列表
   */
  applyExternalEvents: (events: VaultFsEvent[]) => string[];
  /** subscriber 异步比对后确认真冲突时调用 */
  markExternalChange: (id: string, kind: "changed" | "removed") => void;
  /**
   * 批量外部同步（git pull 等）成功且有更新后调用：clean file tab 直接 bump
   * reloadToken 重读磁盘（EditorView 内容比对去抖，内容没变不闪），dirty tab
   * 保护本地 buffer 不动（借鉴 tolaria refreshPulledVaultState）。
   */
  reloadCleanFileTabsAfterSync: () => void;
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function pushClosedSnapshot(
  stack: ClosedTabSnapshot[],
  snap: ClosedTabSnapshot,
): ClosedTabSnapshot[] {
  // 同 path 去重 → prepend → 截断
  const filtered = stack.filter((s) => s.path !== snap.path);
  return [snap, ...filtered].slice(0, CLOSED_STACK_LIMIT);
}

function snapshotFor(tab: Tab): ClosedTabSnapshot | null {
  if (tab.kind !== "file" || !tab.path) return null;
  return { path: tab.path, title: tab.title, closedAt: Date.now() };
}

/** 把 id prepend 到 MRU；同 id 去重。null 时直接返回原数组。 */
function pushMru(mru: string[], id: string | null): string[] {
  if (!id) return mru;
  const filtered = mru.filter((x) => x !== id);
  return [id, ...filtered];
}

/** 从 MRU 中移除一组 id。 */
function dropMru(mru: string[], removed: Iterable<string>): string[] {
  const set = new Set(removed);
  return mru.filter((x) => !set.has(x));
}

/**
 * 把 MRU 与当前 tabs 调和：丢掉已不存在的 id，把 tabs 中未出现的 id 追加到末尾，
 * 保证活跃 tab 始终在 MRU[0]。renameTab / 多步合并场景下用来保证不变量。
 */
function reconcileMru(
  mru: string[],
  tabs: Tab[],
  activeId: string | null,
): string[] {
  const tabIds = new Set(tabs.map((t) => t.id));
  const filtered = mru.filter((id) => tabIds.has(id));
  const known = new Set(filtered);
  const tail = tabs
    .map((t) => t.id)
    .filter((id) => !known.has(id) && id !== activeId);
  let next = [...filtered, ...tail];
  if (activeId && tabIds.has(activeId)) {
    next = next.filter((id) => id !== activeId);
    next = [activeId, ...next];
  }
  return next;
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  vaultPath: null,
  vaultReady: false,
  tabs: [],
  activeTabId: null,
  mruTabIds: [],
  closedTabsStack: [],
  pendingReveal: null,

  initialize: async () => {
    // 幂等：多次调用复用同一个 in-flight promise。让 useSettings.initialize、
    // ThemeProvider、AppShell 都能 await 它而不会重复执行（也避免它们的并发
    // 调用产生 settings.load 抢跑 vault.setCurrent 的 race）。
    //
    // 启动顺序（关键，不要乱）：
    //   1. 拉 user-cache 拿 lastVault；如果不存在/路径无效就走空态
    //   2. 调 vault.setCurrent → main 端 seed `.stela/` + reload connector registry
    //   3. 此时 main 端有 currentVault，settings/connections/plugins 才能 load
    //   4. useSettings.initialize 内部 await 这个 initialize，再 loadAppSettings
    if (initInFlight) return initInFlight;
    initInFlight = (async () => {
      const cache = await loadUserCache();
      const saved = cache.lastVault;
      if (saved) {
        const exists = await pathExists(saved).catch(() => false);
        if (exists) {
          try {
            await window.stela.vault.setCurrent(saved);
          } catch (err) {
            console.error("[stela] vault.setCurrent failed", err);
          }
          // 先暴露 vaultPath 让 file-tree 等无依赖 storage 的 UI 启动加载，
          // 但 vaultReady 必须等到 storage.open 完成 —— 否则用户启动后立即点开
          // 含 RunSQL 块的文件会触发 BlockResult.getSchema 在 storage 未开时报错
          // ("storage not opened; call storage.open(vaultPath) first")。
          // electronStorage 内部也维护 openInFlight 兜底，但这里把语义对齐。
          set({ vaultPath: saved });
          await electronStorage
            .open(saved)
            .catch((err) => console.error("[stela] storage_open failed", err));
          set({ vaultReady: true });
          return;
        }
        // 老路径已删除：清掉 lastVault，避免下次启动再卡
        await patchUserCache({ lastVault: null }).catch(() => {});
      }
      set({ vaultReady: true });
    })();
    return initInFlight;
  },

  chooseVault: async () => {
    const picked = await pickVault();
    if (!picked) return;
    await get().openVaultByPath(picked);
  },

  openVaultByPath: async (picked) => {
    if (!picked) return;
    const exists = await pathExists(picked).catch(() => false);
    if (!exists) {
      void useSettings.getState().removeRecentVault(picked);
      window.alert(`Vault 路径不存在，已从最近列表移除：\n${picked}`);
      return;
    }
    // 关键热路径：先切 main 端 currentVault，再统一 refetch 各 store
    try {
      await window.stela.vault.setCurrent(picked);
    } catch (err) {
      console.error("[stela] vault.setCurrent failed", err);
    }
    await patchUserCache({ lastVault: picked }).catch((err) =>
      console.error("[stela] patch lastVault failed", err),
    );
    set({
      vaultPath: picked,
      tabs: [],
      activeTabId: null,
      mruTabIds: [],
    });
    // AutoGit 状态属于 vault 级，切 vault 时必须 reset，否则旧 vault 的
    // lastError 会串台到新 vault；随后按新 vault 的 git 设置重启自动 pull。
    resetAutoGit();
    void useSettings.getState().pushRecentVault(picked);
    // 切 vault 后所有 vault 级 store 都需要重读
    void useSettings.getState().reload();
    void useConnections.getState().reload();
    void usePluginsStore.getState().refresh();
    refreshGitStatus();
    startAutoPull();
    await electronStorage
      .open(picked)
      .catch((err) => console.error("[stela] storage_open failed", err));
  },

  closeVault: async () => {
    try {
      await window.stela.vault.setCurrent(null);
    } catch (err) {
      console.error("[stela] vault.setCurrent(null) failed", err);
    }
    await patchUserCache({ lastVault: null }).catch(() => {});
    set({
      vaultPath: null,
      tabs: [],
      activeTabId: null,
      mruTabIds: [],
    });
    resetAutoGit();
    refreshGitStatus();
    // 清掉各 store 缓存（reload 会从 main 拿到 no_vault → 兜底回 defaults / 空 map）
    void useSettings.getState().reload();
    void useConnections.getState().reload();
    void usePluginsStore.getState().refresh();
  },

  openFile: (path, optionsOrTitle) => {
    const opts: OpenFileOptions =
      typeof optionsOrTitle === "string"
        ? { title: optionsOrTitle }
        : optionsOrTitle ?? {};
    const wantEphemeral = opts.ephemeral === true;
    const { tabs, pendingReveal, vaultPath, mruTabIds } = get();
    const existing = tabs.find((t) => t.kind === "file" && t.path === path);

    const hasReveal =
      opts.scrollToLine !== undefined ||
      opts.scrollToSlug !== undefined ||
      (opts.keyword !== undefined && opts.nthInFile !== undefined);
    const nextReveal: PendingReveal | null = hasReveal
      ? {
          path,
          line: opts.scrollToLine,
          column: opts.scrollToColumn,
          slug: opts.scrollToSlug,
          token: (pendingReveal?.token ?? 0) + 1,
          keyword: opts.keyword,
          caseSensitive: opts.caseSensitive,
          nthInFile: opts.nthInFile,
        }
      : pendingReveal;

    // 推 recent files：fire-and-forget，仅在真有 vault 时记录。
    // 失败会在 settings store 内部 console.error，不影响 openFile 主流程。
    if (vaultPath) {
      void useSettings.getState().pushRecentFile(path, vaultPath);
    }

    // Case 1：命中已开 tab → 复用；如果命中的是 ephemeral 且本次想要永久，则升级
    if (existing) {
      const shouldPromote = !!existing.ephemeral && !wantEphemeral;
      const nextTabs = shouldPromote
        ? tabs.map((t) =>
            t.id === existing.id ? { ...t, ephemeral: false } : t,
          )
        : tabs;
      set({
        tabs: nextTabs,
        activeTabId: existing.id,
        mruTabIds: pushMru(mruTabIds, existing.id),
        pendingReveal: nextReveal,
      });
      return;
    }

    // Case 2：未命中 + 想要 ephemeral，且当前已存在一个 ephemeral tab
    //         → 原地替换那个 ephemeral，保留位置（典型场景：连续单击不同文件预览）
    const id = `file:${path}`;
    const newTab: Tab = {
      id,
      kind: "file",
      title: opts.title ?? basename(path),
      path,
      ...(wantEphemeral ? { ephemeral: true } : {}),
    };
    if (wantEphemeral) {
      const ephIdx = tabs.findIndex((t) => t.ephemeral);
      if (ephIdx >= 0) {
        const next = [...tabs];
        const replaced = next[ephIdx]!;
        next[ephIdx] = newTab;
        // 把被替换的 ephemeral id 从 MRU 里抹掉，再 prepend 新 id
        const cleared = dropMru(mruTabIds, [replaced.id]);
        set({
          tabs: next,
          activeTabId: id,
          mruTabIds: pushMru(cleared, id),
          pendingReveal: nextReveal,
        });
        return;
      }
    }

    // Case 3：默认追加新 tab（永久或全局首个 ephemeral）
    set({
      tabs: [...tabs, newTab],
      activeTabId: id,
      mruTabIds: pushMru(mruTabIds, id),
      pendingReveal: nextReveal,
    });
  },

  promoteEphemeral: (id) => {
    const { tabs } = get();
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    if (!tabs[idx]?.ephemeral) return;
    const next = tabs.map((t) =>
      t.id === id ? { ...t, ephemeral: false } : t,
    );
    set({ tabs: next });
  },

  consumeReveal: () => set({ pendingReveal: null }),

  revealActiveFile: () => {
    const { activeTabId, tabs, pendingReveal } = get();
    if (!activeTabId) return;
    const active = tabs.find((t) => t.id === activeTabId);
    if (!active || active.kind !== "file" || !active.path) return;
    set({
      pendingReveal: {
        path: active.path,
        token: (pendingReveal?.token ?? 0) + 1,
      },
    });
  },

  closeTab: (id) => {
    if (!id) return;
    const { tabs, activeTabId, closedTabsStack, mruTabIds } = get();
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const target = tabs[idx]!;
    const next = tabs.filter((t) => t.id !== id);
    let nextActive: string | null = activeTabId;
    if (activeTabId === id) {
      const fallback = next[idx] ?? next[idx - 1] ?? next[0];
      nextActive = fallback?.id ?? null;
    }
    const snap = snapshotFor(target);
    const droppedMru = dropMru(mruTabIds, [id]);
    clearTabBuffer(id);
    set({
      tabs: next,
      activeTabId: nextActive,
      mruTabIds: pushMru(droppedMru, nextActive),
      closedTabsStack: snap
        ? pushClosedSnapshot(closedTabsStack, snap)
        : closedTabsStack,
    });
  },

  closeOtherTabs: (id) => {
    const { tabs, closedTabsStack, mruTabIds } = get();
    if (!tabs.some((t) => t.id === id)) return;
    let stack = closedTabsStack;
    const next = tabs.filter((t) => {
      if (t.id === id) return true;
      // pinned tab 在「关闭其他」时保留——pin 的语义是显式想留下
      if (t.pinned) return true;
      const snap = snapshotFor(t);
      if (snap) stack = pushClosedSnapshot(stack, snap);
      clearTabBuffer(t.id);
      return false;
    });
    if (next.length === tabs.length) return;
    set({
      tabs: next,
      activeTabId: id,
      mruTabIds: reconcileMru(mruTabIds, next, id),
      closedTabsStack: stack,
    });
  },

  closeTabsToRight: (id) => {
    const { tabs, activeTabId, closedTabsStack, mruTabIds } = get();
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx < 0 || idx === tabs.length - 1) return;
    let stack = closedTabsStack;
    const removed: Tab[] = [];
    const next = tabs.filter((t, i) => {
      if (i <= idx) return true;
      if (t.pinned) return true;
      const snap = snapshotFor(t);
      if (snap) stack = pushClosedSnapshot(stack, snap);
      removed.push(t);
      clearTabBuffer(t.id);
      return false;
    });
    if (removed.length === 0) return;
    const nextActive = removed.some((t) => t.id === activeTabId)
      ? id
      : activeTabId;
    set({
      tabs: next,
      activeTabId: nextActive,
      mruTabIds: reconcileMru(mruTabIds, next, nextActive),
      closedTabsStack: stack,
    });
  },

  closeSavedTabs: () => {
    const { tabs, activeTabId, closedTabsStack, mruTabIds } = get();
    let stack = closedTabsStack;
    const next = tabs.filter((t) => {
      if (t.kind !== "file") return true;
      if (t.dirty) return true;
      // pinned tab 视为「明确想留下来」，即便 saved 也不关
      if (t.pinned) return true;
      const snap = snapshotFor(t);
      if (snap) stack = pushClosedSnapshot(stack, snap);
      clearTabBuffer(t.id);
      return false;
    });
    if (next.length === tabs.length) return;
    const stillActive = next.some((t) => t.id === activeTabId);
    const nextActive: string | null = stillActive
      ? activeTabId
      : next[next.length - 1]?.id ?? null;
    set({
      tabs: next,
      activeTabId: nextActive,
      mruTabIds: reconcileMru(mruTabIds, next, nextActive),
      closedTabsStack: stack,
    });
  },

  reopenLastClosed: () => {
    const { closedTabsStack } = get();
    if (closedTabsStack.length === 0) return;
    const [head, ...rest] = closedTabsStack;
    set({ closedTabsStack: rest });
    if (!head) return;
    // openFile 内部会 push 当前文件到 recentFiles，这里完成正确 UX
    get().openFile(head.path, { title: head.title });
  },

  setActive: (id) => {
    const { activeTabId, mruTabIds } = get();
    if (activeTabId === id) return;
    set({ activeTabId: id, mruTabIds: pushMru(mruTabIds, id) });
  },

  closeTabsForPath: (path) => {
    const { tabs, activeTabId, mruTabIds } = get();
    const isMatch = (p: string) => p === path || p.startsWith(`${path}/`);
    tabs.forEach((t) => {
      if (t.kind === "file" && t.path && isMatch(t.path)) clearTabBuffer(t.id);
    });
    const next = tabs.filter((t) => !(t.kind === "file" && t.path && isMatch(t.path)));
    if (next.length === tabs.length) return;
    let nextActive: string | null = activeTabId;
    const stillActive = next.some((t) => t.id === activeTabId);
    if (!stillActive) {
      nextActive = next[next.length - 1]?.id ?? null;
    }
    set({
      tabs: next,
      activeTabId: nextActive,
      mruTabIds: reconcileMru(mruTabIds, next, nextActive),
    });
  },

  renameTabsForPath: (from, to) => {
    const { tabs, activeTabId, mruTabIds } = get();
    let mutated = false;
    let nextActive = activeTabId;
    const idRemap = new Map<string, string>();
    const next = tabs.map((t) => {
      if (t.kind !== "file" || !t.path) return t;
      if (t.path === from || t.path.startsWith(`${from}/`)) {
        const remapped = t.path === from ? to : `${to}${t.path.slice(from.length)}`;
        const newId = `file:${remapped}`;
        idRemap.set(t.id, newId);
        if (activeTabId === t.id) nextActive = newId;
        mutated = true;
        return { ...t, id: newId, path: remapped, title: basename(remapped) };
      }
      return t;
    });
    if (!mutated) return;
    const remappedMru = mruTabIds.map((id) => idRemap.get(id) ?? id);
    set({
      tabs: next,
      activeTabId: nextActive,
      mruTabIds: reconcileMru(remappedMru, next, nextActive),
    });
  },

  setDirty: (id, dirty) => {
    const { tabs } = get();
    let changed = false;
    const next = tabs.map((t) => {
      if (t.id !== id) return t;
      // dirty=true 且当前 ephemeral → 顺手升级为永久
      const wantPromote = dirty && !!t.ephemeral;
      if ((t.dirty ?? false) === dirty && !wantPromote) return t;
      changed = true;
      const updated: Tab = { ...t, dirty };
      if (wantPromote) updated.ephemeral = false;
      return updated;
    });
    if (changed) {
      set({ tabs: next });
      if (!dirty) scheduleAutoGit("tab-clean");
    }
  },

  getTabIdByPath: (path) => {
    const tab = get().tabs.find((t) => t.kind === "file" && t.path === path);
    return tab?.id ?? null;
  },

  incrementSqlRunning: (id) => {
    const { tabs } = get();
    let changed = false;
    const next = tabs.map((t) => {
      if (t.id !== id) return t;
      changed = true;
      return { ...t, sqlRunningCount: (t.sqlRunningCount ?? 0) + 1 };
    });
    if (changed) set({ tabs: next });
  },

  decrementSqlRunning: (id) => {
    const { tabs } = get();
    let changed = false;
    const next = tabs.map((t) => {
      if (t.id !== id) return t;
      const count = Math.max(0, (t.sqlRunningCount ?? 0) - 1);
      changed = count !== (t.sqlRunningCount ?? 0);
      return count > 0
        ? { ...t, sqlRunningCount: count }
        : { ...t, sqlRunningCount: undefined };
    });
    if (changed) set({ tabs: next });
  },

  reloadTabFromBuffer: (id) => {
    const { tabs } = get();
    let changed = false;
    const next = tabs.map((t) => {
      if (t.id !== id) return t;
      changed = true;
      return { ...t, reloadToken: (t.reloadToken ?? 0) + 1 };
    });
    if (changed) set({ tabs: next });
  },

  setPinned: (id, pinned) => {
    const { tabs } = get();
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const cur = tabs[idx]!;
    if ((cur.pinned ?? false) === pinned) return;

    // 1) 从原位置取出 → 标记新 pinned 状态；pin 时顺手摘 ephemeral
    const updated: Tab = { ...cur, pinned };
    if (pinned) updated.ephemeral = false;
    const without = tabs.filter((t) => t.id !== id);

    // 2) pinned 区与 unpinned 区的边界 = 第一个非 pinned 的位置。
    //    无论目标是 pin 还是 unpin，都把目标插入到这个边界处——
    //      pin=true: 插入后位于 pinned 区末尾
    //      pin=false: 插入后位于 unpinned 区开头
    let boundary = 0;
    while (boundary < without.length && without[boundary]?.pinned) {
      boundary++;
    }

    const next = [
      ...without.slice(0, boundary),
      updated,
      ...without.slice(boundary),
    ];
    set({ tabs: next });
  },

  reorderTab: (sourceId, targetId) => {
    if (sourceId === targetId) return;
    const { tabs } = get();
    const srcIdx = tabs.findIndex((t) => t.id === sourceId);
    if (srcIdx < 0) return;
    const src = tabs[srcIdx]!;

    let dstIdx: number;
    if (targetId === null) {
      dstIdx = tabs.length;
    } else {
      const ti = tabs.findIndex((t) => t.id === targetId);
      if (ti < 0) return;
      const target = tabs[ti]!;
      // 跨界（pinned ↔ unpinned）的拖拽不处理；用户应通过右键菜单 Pin/Unpin
      if ((target.pinned ?? false) !== (src.pinned ?? false)) return;
      dstIdx = ti;
    }

    const without = tabs.filter((_, i) => i !== srcIdx);
    // 取出 source 后下标会前移：当 src 在 dst 之前时，dst 需要 -1
    const insertAt = srcIdx < dstIdx ? dstIdx - 1 : dstIdx;
    // 拖拽视为「承诺操作」：源 tab 若是 ephemeral 顺手升级
    const movedSrc: Tab = src.ephemeral ? { ...src, ephemeral: false } : src;
    const next = [
      ...without.slice(0, insertAt),
      movedSrc,
      ...without.slice(insertAt),
    ];
    set({ tabs: next });
  },

  acceptExternalChange: (id) => {
    const { tabs } = get();
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const target = tabs[idx]!;
    if (!target.externalChange) return;
    // 接受变更：清 dirty/externalChange，bump reloadToken 让 EditorView 重读磁盘。
    // dirty=false 是因为本地未保存的内容被显式抛弃了，磁盘版本即真相。
    const updated: Tab = {
      ...target,
      dirty: false,
      externalChange: undefined,
      reloadToken: (target.reloadToken ?? 0) + 1,
    };
    const next = tabs.map((t) => (t.id === id ? updated : t));
    set({ tabs: next });
  },

  dismissExternalChange: (id) => {
    const { tabs } = get();
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const target = tabs[idx]!;
    if (!target.externalChange) return;
    const next = tabs.map((t) =>
      t.id === id ? { ...t, externalChange: undefined } : t,
    );
    set({ tabs: next });
  },

  setBacklinksOpen: (id, open) => {
    const { tabs } = get();
    if (!tabs.some((t) => t.id === id)) return;
    const next = tabs.map((t) =>
      t.id === id ? { ...t, backlinksOpen: open } : t,
    );
    set({ tabs: next });
  },

  applyExternalEvents: (events) => {
    if (events.length === 0) return [];
    const { tabs } = get();
    if (tabs.length === 0) return [];

    // 收集每个 tab path 命中的最强事件类型。优先级：removed > changed > added。
    type Hit = { kind: "removed" | "changed" };
    const byTabId = new Map<string, Hit>();

    for (const ev of events) {
      for (const tab of tabs) {
        if (tab.kind !== "file" || !tab.path) continue;
        const isMatch =
          ev.path === tab.path ||
          (ev.isDir && tab.path.startsWith(ev.path + "/"));
        if (!isMatch) continue;
        const cur = byTabId.get(tab.id);
        if (ev.type === "removed") {
          byTabId.set(tab.id, { kind: "removed" });
        } else if (ev.type === "changed") {
          if (!cur) byTabId.set(tab.id, { kind: "changed" });
          // 若已经有 removed，保留 removed
        }
      }
    }
    if (byTabId.size === 0) return [];

    const pendingDirtyChanged: string[] = [];
    let mutated = false;
    const next = tabs.map((t) => {
      const hit = byTabId.get(t.id);
      if (!hit) return t;
      if (hit.kind === "removed") {
        if (t.externalChange === "removed") return t;
        mutated = true;
        return { ...t, externalChange: "removed" as const };
      }
      // changed
      if (t.dirty) {
        if (t.externalChange === "changed" || t.externalChange === "removed") {
          return t;
        }
        // 延迟 banner：subscriber 读盘并与 lastKnownDisk 比对后再 markExternalChange
        pendingDirtyChanged.push(t.id);
        return t;
      }
      // clean tab + 外部修改 → bump reloadToken，让 EditorView 重读磁盘并按内容
      // 决定是否真的重载（EditorView 会先比对磁盘内容与当前 buffer，一致则不闪）。
      clearTabBuffer(t.id);
      mutated = true;
      return { ...t, reloadToken: (t.reloadToken ?? 0) + 1 };
    });
    if (mutated) set({ tabs: next });
    return pendingDirtyChanged;
  },

  markExternalChange: (id, kind) => {
    const { tabs } = get();
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const target = tabs[idx]!;
    if (target.externalChange === kind) return;
    if (kind === "changed" && target.externalChange === "removed") return;
    const next = tabs.map((t) =>
      t.id === id ? { ...t, externalChange: kind } : t,
    );
    set({ tabs: next });
  },

  reloadCleanFileTabsAfterSync: () => {
    const { tabs } = get();
    let mutated = false;
    const next = tabs.map((t) => {
      if (t.kind !== "file" || !t.path) return t;
      // dirty tab 保护本地未保存改动，不重读（watcher 路径会按内容比对决定是否提示）
      if (t.dirty) return t;
      mutated = true;
      return { ...t, reloadToken: (t.reloadToken ?? 0) + 1 };
    });
    if (mutated) set({ tabs: next });
  },
}));
