/**
 * 模块级 ConnectorKindMeta 缓存。第一次访问时拉一次，后续走内存。
 * UI 表单 / 选择器消费这份缓存做渲染。
 */

import type { ConnectorKindMeta } from "@/contracts";

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
