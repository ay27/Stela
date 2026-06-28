/**
 * SQL 自动补全的表名缓存。
 *
 * 对齐当前编辑器执行上下文：
 *   - 按 connectionName 缓存；
 *   - 成功 TTL 1 小时（schema 变化不频繁，用户说"真变了重启 app 就行"）；
 *   - 失败 TTL 30 秒（瞬时故障可以很快重试）；
 *   - 并发相同 key 的 ensure 请求共享同一个 pending promise，不重复打后端；
 *   - Settings 里改了连接 → 调用方显式 `invalidate(name)`。
 *
 * 为什么用 zustand 而不是纯 Map：
 *   Settings → Connections 里要展示每个连接的"补全就绪"状态徽章（未加载 / 加载中
 *   / 就绪 N 表 / 失败），徽章需要响应式订阅 —— zustand store 现成就满足，也避免
 *   再在 Map 上自己加 Observer。
 */

import { create } from "zustand";

export type AutocompleteStatus =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; tableNames: string[]; fetchedAt: number }
  | { kind: "error"; message: string; fetchedAt: number };

interface AutocompleteCacheState {
  /** 每个连接当前的最新状态。UI 直接订阅这里。 */
  byConnection: Record<string, AutocompleteStatus>;
  /** 正在飞的请求 promise。不放 byConnection 里（那里要保持可序列化），单独一张表。 */
  _pending: Record<string, Promise<string[]>>;

  /** 同步读某连接的当前状态（徽章展示用）。 */
  getStatus: (name: string) => AutocompleteStatus;

  /**
   * 取该连接的表名列表。
   *   - 已有 ready 且未过期 → 直接返回；
   *   - 已有 error 且未过期 → 返回空数组（不重试，避免雪崩）；
   *   - 正在 loading → 复用同一个 pending promise；
   *   - 其它情况 → 置 loading、调用 fetcher；成功写 ready，失败写 error。
   */
  ensure: (name: string, fetcher: () => Promise<string[]>) => Promise<string[]>;

  /** 连接被 upsert / remove 时调用，强制下次重拉。 */
  invalidate: (name: string) => void;
  invalidateAll: () => void;
}

const TTL_SUCCESS_MS = 60 * 60 * 1000; // 1 小时
const TTL_FAILURE_MS = 30 * 1000;       // 失败 30 秒后可重试

function isFresh(status: AutocompleteStatus, now: number): boolean {
  if (status.kind === "ready") return now - status.fetchedAt < TTL_SUCCESS_MS;
  if (status.kind === "error") return now - status.fetchedAt < TTL_FAILURE_MS;
  return false;
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(err);
}

export const useAutocompleteCache = create<AutocompleteCacheState>((set, get) => ({
  byConnection: {},
  _pending: {},

  getStatus(name) {
    return get().byConnection[name] ?? { kind: "idle" };
  },

  async ensure(name, fetcher) {
    const now = Date.now();
    const state = get();
    const cur = state.byConnection[name] ?? { kind: "idle" };

    if (cur.kind === "ready" && isFresh(cur, now)) {
      return cur.tableNames;
    }
    if (cur.kind === "error" && isFresh(cur, now)) {
      return [];
    }

    const pending = state._pending[name];
    if (pending) return pending;

    const promise = (async () => {
      try {
        const tableNames = await fetcher();
        set((s) => ({
          byConnection: {
            ...s.byConnection,
            [name]: { kind: "ready", tableNames, fetchedAt: Date.now() },
          },
        }));
        return tableNames;
      } catch (err) {
        const message = errorMessage(err);
        set((s) => ({
          byConnection: {
            ...s.byConnection,
            [name]: { kind: "error", message, fetchedAt: Date.now() },
          },
        }));
        console.warn("[stela] autocomplete fetch failed", name, err);
        return [];
      } finally {
        set((s) => {
          const { [name]: _removed, ...rest } = s._pending;
          void _removed;
          return { _pending: rest };
        });
      }
    })();

    set((s) => ({
      byConnection: { ...s.byConnection, [name]: { kind: "loading" } },
      _pending: { ...s._pending, [name]: promise },
    }));

    return promise;
  },

  invalidate(name) {
    set((s) => {
      const { [name]: _removed, ...rest } = s.byConnection;
      void _removed;
      return { byConnection: rest };
    });
  },

  invalidateAll() {
    set({ byConnection: {} });
  },
}));
