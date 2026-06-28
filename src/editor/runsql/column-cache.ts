/**
 * 表列元数据缓存。模式与 `autocomplete-cache.ts` 对齐：
 *
 *   - key = `${connectionName}::${qualifiedTable}`，`qualifiedTable` 与 Schema
 *     侧栏的 tableKey（`db.table` 或裸表名）保持一致；
 *   - 成功 TTL 1 小时（与表名缓存同节奏），失败 TTL 30 秒，避免拉错的表反复打后端；
 *   - 并发同 key 的 `ensure` 共享一个 pending promise；
 *   - 连接被 upsert / remove 时调 `invalidateConnection(name)` 一次性丢掉相关条目。
 *
 * 设计取舍：
 *   - 不预热整库（几百张表 × N 个连接 = 上千个 LIMIT 0，没必要）；
 *   - SQL 补全 source 在解析出"光标作用域 = 某张表"时才 `ensure`，第一次会有
 *     一次往返延迟（典型 100~300ms），之后命中缓存即时返回。
 */
import { create } from "zustand";

import type { ColumnDef } from "@/contracts";

import { fetchColumnsForTable, qualifiedTableName } from "./fetch-columns";

export type ColumnStatus =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; columns: ColumnDef[]; fetchedAt: number }
  | { kind: "error"; message: string; fetchedAt: number };

interface ColumnCacheState {
  byKey: Record<string, ColumnStatus>;
  _pending: Record<string, Promise<ColumnDef[]>>;

  /** 同步读：UI / 补全 source 用。 */
  getStatus: (connection: string, db: string | null, table: string) => ColumnStatus;

  /**
   * 取列元数据：命中有效缓存直接 resolve；缺失 / 过期 → 拉一次 LIMIT 0 探针。
   * 失败一律 resolve 空数组（不再向上抛），调用方按"没列可补"自然降级。
   */
  ensure: (
    connection: string,
    db: string | null,
    table: string,
  ) => Promise<ColumnDef[]>;

  /** 连接被改 / 删时调；删掉该连接下所有表的缓存。 */
  invalidateConnection: (connection: string) => void;
  invalidateAll: () => void;
}

const TTL_SUCCESS_MS = 60 * 60 * 1000;
const TTL_FAILURE_MS = 30 * 1000;

function isFresh(status: ColumnStatus, now: number): boolean {
  if (status.kind === "ready") return now - status.fetchedAt < TTL_SUCCESS_MS;
  if (status.kind === "error") return now - status.fetchedAt < TTL_FAILURE_MS;
  return false;
}

function makeKey(connection: string, db: string | null, table: string): string {
  return `${connection}::${qualifiedTableName(db, table)}`;
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(err);
}

export const useColumnCache = create<ColumnCacheState>((set, get) => ({
  byKey: {},
  _pending: {},

  getStatus(connection, db, table) {
    return get().byKey[makeKey(connection, db, table)] ?? { kind: "idle" };
  },

  async ensure(connection, db, table) {
    const key = makeKey(connection, db, table);
    const now = Date.now();
    const cur = get().byKey[key] ?? { kind: "idle" };

    if (cur.kind === "ready" && cur.columns.length > 0 && isFresh(cur, now)) {
      return cur.columns;
    }
    if (cur.kind === "error" && isFresh(cur, now)) return [];

    const pending = get()._pending[key];
    if (pending) return pending;

    const promise = (async () => {
      try {
        const columns = await fetchColumnsForTable(connection, db, table);
        set((s) => ({
          byKey: {
            ...s.byKey,
            [key]: { kind: "ready", columns, fetchedAt: Date.now() },
          },
        }));
        return columns;
      } catch (err) {
        const message = errorMessage(err);
        set((s) => ({
          byKey: {
            ...s.byKey,
            [key]: { kind: "error", message, fetchedAt: Date.now() },
          },
        }));
        console.warn("[stela] column fetch failed", connection, db, table, err);
        return [];
      } finally {
        set((s) => {
          const { [key]: _removed, ...rest } = s._pending;
          void _removed;
          return { _pending: rest };
        });
      }
    })();

    set((s) => ({
      byKey: { ...s.byKey, [key]: { kind: "loading" } },
      _pending: { ...s._pending, [key]: promise },
    }));

    return promise;
  },

  invalidateConnection(connection) {
    const prefix = `${connection}::`;
    set((s) => {
      const next: Record<string, ColumnStatus> = {};
      for (const [k, v] of Object.entries(s.byKey)) {
        if (!k.startsWith(prefix)) next[k] = v;
      }
      return { byKey: next };
    });
  },

  invalidateAll() {
    set({ byKey: {} });
  },
}));
