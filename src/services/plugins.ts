/**
 * Connector 插件管理（renderer 适配）。
 *
 * 走 main 进程 [`electron/services/connectors/registry.ts`](../../../electron/services/connectors/registry.ts)，
 * manifest 落 `{userData}/connector_plugins.json`，子进程 stderr 走内存 ring buffer。
 *
 * UI 通过 [`PluginsTab`](../components/settings/plugins-tab.tsx) 调本模块，再调
 * `window.stela.connector.{listPlugins, installPlugin, uninstallPlugin, getPluginLogs}`。
 */

import { useEffect } from "react";
import { create } from "zustand";

import type {
  BundledPluginInfo,
  ModulePluginInstallInput,
  PluginInfo,
  PluginInstallInput,
} from "@shared/types";

interface PluginsState {
  items: PluginInfo[];
  phase: "idle" | "loading" | "ready" | "error";
  error: string | null;
  refresh: () => Promise<void>;
  install: (input: PluginInstallInput) => Promise<PluginInfo>;
  installModule: (input: ModulePluginInstallInput) => Promise<PluginInfo>;
  installBundled: (id: string) => Promise<PluginInfo>;
  uninstall: (kind: string) => Promise<void>;
  start: (kind: string) => Promise<PluginInfo>;
  stop: (kind: string) => Promise<PluginInfo>;
  restart: (kind: string) => Promise<PluginInfo>;
  logsByKind: Record<string, string[]>;
  fetchLogs: (kind: string) => Promise<string[]>;
}

/**
 * Zustand store。直接 import 用于 React 外（比如 workspace.ts 在 vault 切换后
 * 通过 `usePluginsStore.getState().refresh()` 触发拉取）。
 *
 * React 组件优先用 [usePluginsList](#usepluginslist) hook（自带 idle→refresh）。
 */
export const usePluginsStore = create<PluginsState>((set, get) => ({
  items: [],
  phase: "idle",
  error: null,
  logsByKind: {},

  async refresh() {
    if (get().phase === "loading") return;
    set({ phase: "loading", error: null });
    try {
      const items = await window.stela.connector.listPlugins();
      set({ items, phase: "ready" });
    } catch (err) {
      // 注意：listPlugins 不需要 vault（内置 connector 跨 vault 共存），
      // 这里捕获是为了任何意外（IPC 路径错误等）都不让 UI 崩。
      console.error("[stela] plugins.refresh failed", err);
      set({
        phase: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  async install(input) {
    const info = await window.stela.connector.installPlugin(input);
    await get().refresh();
    return info;
  },

  async installModule(input) {
    const info = await window.stela.connector.installModulePlugin(input);
    await get().refresh();
    return info;
  },

  async installBundled(id) {
    const info = await window.stela.connector.installBundledPlugin(id);
    await get().refresh();
    return info;
  },

  async uninstall(kind) {
    await window.stela.connector.uninstallPlugin(kind);
    set((s) => {
      const next = { ...s.logsByKind };
      delete next[kind];
      return { logsByKind: next };
    });
    await get().refresh();
  },

  async start(kind) {
    const info = await window.stela.connector.startPlugin(kind);
    await get().refresh();
    return info;
  },

  async stop(kind) {
    const info = await window.stela.connector.stopPlugin(kind);
    await get().refresh();
    return info;
  },

  async restart(kind) {
    const info = await window.stela.connector.restartPlugin(kind);
    await get().refresh();
    return info;
  },

  async fetchLogs(kind) {
    const logs = await window.stela.connector.getPluginLogs(kind);
    set((s) => ({ logsByKind: { ...s.logsByKind, [kind]: logs } }));
    return logs;
  },
}));

export interface PluginsView {
  items: PluginInfo[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  install: (input: PluginInstallInput) => Promise<PluginInfo>;
  installModule: (input: ModulePluginInstallInput) => Promise<PluginInfo>;
  installBundled: (id: string) => Promise<PluginInfo>;
  uninstall: (kind: string) => Promise<void>;
  start: (kind: string) => Promise<PluginInfo>;
  stop: (kind: string) => Promise<PluginInfo>;
  restart: (kind: string) => Promise<PluginInfo>;
}

export function usePluginsList(): PluginsView {
  const items = usePluginsStore((s) => s.items);
  const phase = usePluginsStore((s) => s.phase);
  const error = usePluginsStore((s) => s.error);
  const refresh = usePluginsStore((s) => s.refresh);
  const install = usePluginsStore((s) => s.install);
  const installModule = usePluginsStore((s) => s.installModule);
  const installBundled = usePluginsStore((s) => s.installBundled);
  const uninstall = usePluginsStore((s) => s.uninstall);
  const start = usePluginsStore((s) => s.start);
  const stop = usePluginsStore((s) => s.stop);
  const restart = usePluginsStore((s) => s.restart);

  useEffect(() => {
    if (phase === "idle") {
      void refresh();
    }
  }, [phase, refresh]);

  return {
    items,
    loading: phase === "idle" || phase === "loading",
    error,
    refresh,
    install,
    installModule,
    installBundled,
    uninstall,
    start,
    stop,
    restart,
  };
}

/** 自带 catalog（可一键安装的内置 module 插件）。组件按需 fetch。 */
export async function fetchBundledPlugins(): Promise<BundledPluginInfo[]> {
  return window.stela.connector.listBundledPlugins();
}

export function usePluginLogs(kind: string | null): {
  logs: string[];
  refreshLogs: () => Promise<void>;
} {
  const logsByKind = usePluginsStore((s) => s.logsByKind);
  const fetchLogs = usePluginsStore((s) => s.fetchLogs);
  const logs = kind ? (logsByKind[kind] ?? []) : [];

  return {
    logs,
    refreshLogs: async () => {
      if (!kind) return;
      await fetchLogs(kind);
    },
  };
}
