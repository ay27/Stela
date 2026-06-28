/**
 * SQL 补全用的 schema 拉取，抽成纯函数供多处复用：
 *   - `codeblock-nodeview.ts` 在补全触发时调用（走 autocomplete-cache 的 TTL）
 *   - `settings/connections-tab.tsx` 的"刷新"按钮调用，让用户看到 loading → ready
 *     的完整过程
 *
 * 对齐 legacy Obsidian 插件：
 *   1. 先 `listDatabases()` 枚举所有库；
 *   2. 对每个库并发 `listTables(db)`，结果拼成 `db.table`；
 *   3. 连接器不支持枚举库（HTTP 等）→ 退化到 config.database 单库或无前缀
 *      `listTables()`。
 */

import { electronConnectorRegistry } from "@/services/connectors/electron-connector";
import { useConnections } from "@/state/connections";
import { useAutocompleteCache } from "./autocomplete-cache";

function extractDefaultDb(config: unknown): string | null {
  if (!config || typeof config !== "object") return null;
  const obj = config as Record<string, unknown>;
  for (const key of ["database", "db", "defaultDatabase"]) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/**
 * 一组数据库 → 表的分组结果。
 *
 * - `db: null` 表示连接器不支持枚举库（典型：HTTP connector），此时所有表名
 *   按"无库"分组返回；UI 应当显示 group 标题为 "(no database)" 之类的占位。
 * - `db: string` 表示某一具体库，`tables` 即该库下表名列表（不含库前缀）。
 */
export interface SchemaGroup {
  db: string | null;
  tables: string[];
}

/**
 * 拉取连接下的库 → 表分组结构。Schema 浏览器侧栏 / autocomplete 共用。
 *
 * 不读缓存、不写状态。caller 自己决定要不要包 cache。
 *
 * 退化策略：
 *   1. listDatabases 成功 → 对每个 db 并发 listTables(db)
 *   2. listDatabases 空但 config 里有 database → 单 db 模式
 *   3. 都没有 → 一次无前缀 listTables，按 `db: null` 返回
 */
export async function fetchSchemaGroups(
  name: string,
): Promise<SchemaGroup[]> {
  const entry = useConnections.getState().get(name);
  if (!entry) return [];
  const { kind, config } = entry;

  const dbs = await electronConnectorRegistry
    .listDatabases(kind, config)
    .catch(() => [] as string[]);

  const fallbackDb = extractDefaultDb(config);
  const dbList = dbs.length > 0 ? dbs : fallbackDb ? [fallbackDb] : [];

  if (dbList.length === 0) {
    const tables = await electronConnectorRegistry
      .listTables(kind, config)
      .catch(() => [] as string[]);
    return [{ db: null, tables }];
  }

  const groups = await Promise.all(
    dbList.map(async (db) => {
      const tables = await electronConnectorRegistry
        .listTables(kind, config, db)
        .catch(() => [] as string[]);
      return { db, tables } satisfies SchemaGroup;
    }),
  );
  return groups;
}

/**
 * 真实拉取指定连接下所有表名（`db.table` 扁平形式）。autocomplete 用。
 */
export async function fetchTableNamesForConnection(
  name: string,
): Promise<string[]> {
  const groups = await fetchSchemaGroups(name);
  const flat: string[] = [];
  for (const g of groups) {
    for (const t of g.tables) {
      flat.push(g.db ? `${g.db}.${t}` : t);
    }
  }
  return Array.from(new Set(flat));
}

/**
 * 走 cache 的 ensure 入口：命中有效缓存直接返回，否则置 loading 并拉取。
 * NodeView 补全和 Settings 面板"刷新"都走这个——区别只在于 Settings 按刷新前
 * 会先 `invalidate(name)` 一下，强制重新拉。
 */
export function ensureAutocompleteFor(name: string): Promise<string[]> {
  return useAutocompleteCache
    .getState()
    .ensure(name, () => fetchTableNamesForConnection(name));
}

/**
 * "刷新"按钮专用：丢掉当前缓存 + 立刻重拉，返回新的表名列表。
 * 不吞 promise——调用方通常 `void` 忽略，UI 通过订阅 `useAutocompleteCache` 看状态。
 */
export function refreshAutocompleteFor(name: string): Promise<string[]> {
  useAutocompleteCache.getState().invalidate(name);
  return ensureAutocompleteFor(name);
}
