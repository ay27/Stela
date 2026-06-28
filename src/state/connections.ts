/**
 * 连接配置 store。RunSQL 执行时按 frontmatter.connection_name 拿 entry。
 */

import { create } from "zustand";

import {
  loadConnections,
  removeConnection,
  upsertConnection,
  type ConnectionEntry,
  type ConnectionMap,
} from "@/services/connections";
import { useAutocompleteCache } from "@/editor/runsql/autocomplete-cache";
import { useColumnCache } from "@/editor/runsql/column-cache";

interface ConnectionsState {
  entries: ConnectionMap;
  loaded: boolean;
  reload: () => Promise<void>;
  upsert: (name: string, entry: ConnectionEntry) => Promise<void>;
  remove: (name: string) => Promise<void>;
  get: (name: string) => ConnectionEntry | undefined;
}

export const useConnections = create<ConnectionsState>((set, getStore) => ({
  entries: {},
  loaded: false,
  async reload() {
    const m = await loadConnections();
    set({ entries: m, loaded: true });
  },
  async upsert(name, entry) {
    const m = await upsertConnection(name, entry);
    set({ entries: m });
    // 连接改动后，已缓存的表名 / 列元数据都可能失效（endpoint / database 都可能变）
    useAutocompleteCache.getState().invalidate(name);
    useColumnCache.getState().invalidateConnection(name);
  },
  async remove(name) {
    const m = await removeConnection(name);
    set({ entries: m });
    useAutocompleteCache.getState().invalidate(name);
    useColumnCache.getState().invalidateConnection(name);
  },
  get(name: string) {
    return getStore().entries[name];
  },
}));
