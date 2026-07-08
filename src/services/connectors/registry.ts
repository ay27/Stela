/**
 * 模块级 ConnectorKindMeta 缓存。第一次访问时拉一次，后续走内存。
 * UI 表单 / 选择器消费这份缓存做渲染。
 */

import type { SQLDialect } from "@codemirror/lang-sql";
import { lezerDialectFor, resolveDialect } from "@shared/sql-dialect";

import type { ConnectorKindMeta } from "@/contracts";
import { useConnections } from "@/state/connections";

import { electronConnectorRegistry } from "./electron-connector";

let cache: ConnectorKindMeta[] | null = null;
let pending: Promise<ConnectorKindMeta[]> | null = null;

export async function loadConnectorKinds(force = false): Promise<ConnectorKindMeta[]> {
  if (!force && cache) return cache;
  if (!force && pending) return pending;
  pending = electronConnectorRegistry
    .listKinds()
    .then((list) => {
      cache = list;
      pending = null;
      return list;
    })
    .catch((err) => {
      pending = null;
      throw err;
    });
  return pending;
}

export function getCachedKinds(): ConnectorKindMeta[] | null {
  return cache;
}

export function clearKindsCache(): void {
  cache = null;
  pending = null;
}

/**
 * 按 connectionName 同步解析出编辑器要用的 lezer `SQLDialect`。
 *
 * 纯同步、不发起任何 IPC：kind meta 缓存未加载（`getCachedKinds()` 为
 * null）或连接不存在时静默回退 `StandardSQL`——只影响语法高亮/补全的词法层
 * 细节，不是阻断性依赖，值得用"尽力而为"换取零延迟。
 */
export function resolveEditorDialect(
  connectionName: string | null | undefined,
): SQLDialect {
  if (!connectionName) return lezerDialectFor(null);
  const entry = useConnections.getState().get(connectionName);
  if (!entry) return lezerDialectFor(null);
  const kinds = getCachedKinds();
  if (!kinds) {
    // 缓存还没预热：后台拉一次（不等待），这次调用先按 kind 名启发式猜。下次
    // 该 note 的 codeblock 重新 mount（切文件 / 重新打开）时就能命中缓存。
    void loadConnectorKinds().catch(() => undefined);
  }
  const meta = kinds?.find((k) => k.kind === entry.kind);
  const displayName = meta?.displayName ?? entry.kind;
  const dialectName = resolveDialect({
    kind: entry.kind,
    displayName,
    dialect: meta?.dialect,
  });
  return lezerDialectFor(dialectName);
}
