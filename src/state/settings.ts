/**
 * App 全量 settings 的 Zustand 镜像。
 *
 * 数据来源（v0.1 vault 化重构后）：
 *   - `settings` —— 来自 `{vault}/.stela/settings.json`，per-vault；切 vault 时 reload
 *   - `recentVaults` / `lastVault` —— 来自 `{userData}/stela-cache.json`，跨 vault
 *
 * UI 应等到 `loaded=true` 再渲染依赖 settings 值的控件，避免主题闪烁 / 默认值跳变。
 *
 * 写入策略：本地 state 立即更新（乐观），失败 console.error 不回滚（写入失败基本是
 * 磁盘问题，回滚也救不回来）。
 */

import { create } from "zustand";

import {
  DEFAULT_APP_SETTINGS,
  type AppSettings,
  type PartialAppSettings,
  type RecentFileEntry,
} from "@/contracts/settings";
import { loadAppSettings, patchAppSettings } from "@/services/settings-store";
import { loadUserCache, patchUserCache } from "@/services/user-cache";

const RECENT_VAULTS_LIMIT = 8;
const RECENT_FILES_LIMIT = 24;

interface SettingsState {
  /** vault 级 settings；没打开 vault 时为 DEFAULT_APP_SETTINGS。 */
  settings: AppSettings;
  /** 跨 vault 的最近 vault 列表（user-cache）。 */
  recentVaults: string[];
  /** 上次打开的 vault；启动时 initialize 用来恢复。 */
  lastVault: string | null;
  /** initialize 完成（无论成功失败）；UI 应等到 true 再渲染依赖 settings 的控件。 */
  loaded: boolean;
  initialize: () => Promise<void>;
  /** 切 vault 后调；从新 vault 重新读 settings.json。 */
  reload: () => Promise<void>;
  patch: (partial: PartialAppSettings) => Promise<void>;
  /** prepend + 去重 + 截断；用于 chooseVault 成功后记录 */
  pushRecentVault: (path: string) => Promise<void>;
  /** 用于 vault 不存在 / 用户主动从 Welcome 中清理一项 */
  removeRecentVault: (path: string) => Promise<void>;
  /** prepend + 去重 + 截断；用于 openFile 成功后记录（vaultPath 仅用于 noop 校验） */
  pushRecentFile: (path: string, vaultPath: string) => Promise<void>;
  /** 用于文件不存在 / 用户主动从 Welcome 中清理一项 */
  removeRecentFile: (path: string) => Promise<void>;
}

function mergeSettings(
  base: AppSettings,
  partial: PartialAppSettings,
): AppSettings {
  return {
    vault: { ...base.vault, ...(partial.vault ?? {}) },
    appearance: { ...base.appearance, ...(partial.appearance ?? {}) },
    execution: { ...base.execution, ...(partial.execution ?? {}) },
    persistence: { ...base.persistence, ...(partial.persistence ?? {}) },
    ui: { ...base.ui, ...(partial.ui ?? {}) },
    // base.git / base.knowledge 兜底：dev 阶段 main 老 / renderer 新边界时 base 可能没这组
    git: {
      ...(base.git ?? DEFAULT_APP_SETTINGS.git),
      ...(partial.git ?? {}),
    },
    knowledge: {
      ...(base.knowledge ?? DEFAULT_APP_SETTINGS.knowledge),
      ...(partial.knowledge ?? {}),
    },
  };
}

function prependDistinct(list: string[], head: string, limit: number): string[] {
  return [head, ...list.filter((p) => p !== head)].slice(0, limit);
}

function prependDistinctFile(
  list: RecentFileEntry[],
  head: RecentFileEntry,
  limit: number,
): RecentFileEntry[] {
  return [head, ...list.filter((f) => f.path !== head.path)].slice(0, limit);
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULT_APP_SETTINGS,
  recentVaults: [],
  lastVault: null,
  loaded: false,
  async initialize() {
    if (get().loaded) return;
    // 等 workspace.initialize 完成（已发起就复用其 in-flight promise；未发起就触发它）。
    // 这是为了避免 settings.load 抢跑 vault.setCurrent → main 端报 no_vault 噪音。
    //
    // 用 dynamic import 打破 workspace.ts ↔ settings.ts 的循环引用：workspace.ts
    // 在 top-level 里 `import { useSettings }`（用于切 vault 时 reload），settings.ts
    // 这里只在运行时拿一次 useWorkspace，不参与 esm 解析图。
    try {
      const { useWorkspace } = await import("@/state/workspace");
      await useWorkspace.getState().initialize();
    } catch (err) {
      // workspace.initialize 本身已经 catch 了内部 IPC 错误，理论上不会 throw；
      // 但万一 dynamic import 失败也不能阻塞 settings 兜底加载（DEFAULT_APP_SETTINGS）
      console.error("[stela] workspace.initialize failed before settings.load", err);
    }
    // user-cache 与 vault settings 并行拉取——前者无关 vault，后者经 workspace 初始化
    // 后 main 端 currentVault 已 ready（或确认无 lastVault 走兜底）
    const [cache, s] = await Promise.all([
      loadUserCache(),
      loadAppSettings(),
    ]);
    set({
      settings: s,
      recentVaults: cache.recentVaults,
      lastVault: cache.lastVault,
      loaded: true,
    });
  },
  async reload() {
    try {
      const s = await loadAppSettings();
      set({ settings: s });
    } catch (err) {
      console.error("[stela] settings reload failed", err);
    }
  },
  async patch(partial) {
    const next = mergeSettings(get().settings, partial);
    set({ settings: next });
    try {
      const truth = await patchAppSettings(partial);
      if (truth) {
        // main 端 sanitize / 投影后的真值；覆盖乐观结果，确保 hasSecretAccessKey
        // 等"由 main 决定"的字段与磁盘一致
        set({ settings: truth });
      }
    } catch (err) {
      console.error("[stela] patchAppSettings failed", err);
    }
  },
  async pushRecentVault(path) {
    if (!path) return;
    const cur = get().recentVaults;
    const next = prependDistinct(cur, path, RECENT_VAULTS_LIMIT);
    // 乐观更新本地，再写盘
    set({ recentVaults: next });
    try {
      const updated = await patchUserCache({ recentVaults: next });
      set({
        recentVaults: updated.recentVaults,
        lastVault: updated.lastVault,
      });
    } catch (err) {
      console.error("[stela] pushRecentVault failed", err);
    }
  },
  async removeRecentVault(path) {
    const cur = get().recentVaults;
    if (!cur.includes(path)) return;
    const next = cur.filter((p) => p !== path);
    set({ recentVaults: next });
    try {
      const updated = await patchUserCache({ recentVaults: next });
      set({
        recentVaults: updated.recentVaults,
        lastVault: updated.lastVault,
      });
    } catch (err) {
      console.error("[stela] removeRecentVault failed", err);
    }
  },
  async pushRecentFile(path, vaultPath) {
    if (!path || !vaultPath) return;
    const cur = get().settings.vault.recentFiles;
    const next = prependDistinctFile(
      cur,
      { path, openedAt: Date.now() },
      RECENT_FILES_LIMIT,
    );
    await get().patch({ vault: { recentFiles: next } });
  },
  async removeRecentFile(path) {
    const cur = get().settings.vault.recentFiles;
    if (!cur.some((f) => f.path === path)) return;
    const next = cur.filter((f) => f.path !== path);
    await get().patch({ vault: { recentFiles: next } });
  },
}));
