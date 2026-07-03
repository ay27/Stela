import { writeFile } from "@/services/fs-write";

const PERSIST_DEBOUNCE_MS = 800;

const buffers = new Map<string, string>();
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function getTabBuffer(tabId: string): string | undefined {
  return buffers.get(tabId);
}

export function setTabBuffer(tabId: string, raw: string): void {
  buffers.set(tabId, raw);
}

export function clearTabBuffer(tabId: string): void {
  buffers.delete(tabId);
  const timer = persistTimers.get(tabId);
  if (timer) {
    clearTimeout(timer);
    persistTimers.delete(tabId);
  }
}

export function scheduleTabPersist(
  tabId: string,
  path: string,
  raw: string,
  onPersisted?: () => void,
): void {
  setTabBuffer(tabId, raw);
  const prev = persistTimers.get(tabId);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => {
    persistTimers.delete(tabId);
    void writeFile(path, raw)
      .then(() => {
        if (buffers.get(tabId) === raw) onPersisted?.();
      })
      .catch((err: unknown) => {
        console.error("[stela] tab buffer persist failed", err);
      });
  }, PERSIST_DEBOUNCE_MS);
  persistTimers.set(tabId, timer);
}
