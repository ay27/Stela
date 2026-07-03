export interface PendingRunKey {
  tabId: string;
  blockId?: string | null;
  blockIndex: number;
  sql: string;
}

const pending = new Map<string, PendingRunKey>();

export function beginPendingRun(key: PendingRunKey): string {
  const runKey = `${key.tabId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  pending.set(runKey, key);
  return runKey;
}

export function endPendingRun(runKey: string | null): void {
  if (!runKey) return;
  pending.delete(runKey);
}

export function isRunsqlBlockPending(key: PendingRunKey): boolean {
  for (const item of pending.values()) {
    if (item.tabId !== key.tabId) continue;
    if (item.blockId && key.blockId && item.blockId === key.blockId) return true;
    if (
      item.blockIndex === key.blockIndex &&
      item.sql.trim() === key.sql.trim()
    ) {
      return true;
    }
  }
  return false;
}

export function clearPendingRunsForTab(tabId: string): void {
  for (const [runKey, item] of pending) {
    if (item.tabId === tabId) pending.delete(runKey);
  }
}
