/**
 * 图片附件 blob URL 缓存。
 *
 * 背景：编辑器里 `<img>` 的 `src` 是 `report.assets/foo.png` 这样的相对
 * 路径。CSP 不允许 `file://`，dev / prod 也都不会走「相对到磁盘文件」的
 * 加载，所以我们把绝对路径里的字节通过 IPC 读出来，包装成 `blob:` URL
 * 设回 `<img src>`。
 *
 * 缓存策略：
 *   - key = 绝对路径
 *   - value = `{ url: string; revoke: () => void }`
 *   - 同一路径的多次请求复用同一个 URL，避免反复 IPC + 反复创建 Blob
 *   - 单一全局上限 64 条；超出 LRU 释放最早的（撤销 URL，下次请求重读）
 *
 * 调用方一般不需要主动 revoke——重新 load 同一路径会自动复用；切换 vault
 * 应该 `clearAll()` 把全部释放掉。
 */

const MAX_ENTRIES = 64;

interface CacheEntry {
  url: string;
  promise: Promise<string>;
  /** 仅 stub：URL.createObjectURL 在 jsdom / 测试环境可能不存在 */
  revoke: () => void;
}

const entries = new Map<string, CacheEntry>();

function touch(key: string): void {
  const e = entries.get(key);
  if (!e) return;
  entries.delete(key);
  entries.set(key, e);
}

function evictIfNeeded(): void {
  while (entries.size > MAX_ENTRIES) {
    const oldestKey = entries.keys().next().value;
    if (typeof oldestKey !== "string") break;
    const e = entries.get(oldestKey);
    if (e) e.revoke();
    entries.delete(oldestKey);
  }
}

/** 释放所有 blob URL；切 vault / 卸载主窗口时调。 */
export function clearAll(): void {
  for (const e of entries.values()) {
    try {
      e.revoke();
    } catch {
      // ignore
    }
  }
  entries.clear();
}

/** 释放某个绝对路径对应的 blob URL（写入新内容、外部 watcher 触发等场景）。 */
export function invalidate(absPath: string): void {
  const e = entries.get(absPath);
  if (!e) return;
  try {
    e.revoke();
  } catch {
    // ignore
  }
  entries.delete(absPath);
}

export interface ImageCacheDeps {
  /** 读字节并返回 base64；默认走 window.stela.vault.readBinary */
  readBinary: (absPath: string) => Promise<string>;
  /** mime 推断；默认从扩展名 */
  mimeFromPath?: (absPath: string) => string;
}

const EXT_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".heic": "image/heic",
  ".heif": "image/heif",
};

export function defaultMimeFromPath(absPath: string): string {
  const idx = absPath.lastIndexOf(".");
  if (idx < 0) return "application/octet-stream";
  const ext = absPath.slice(idx).toLowerCase();
  return EXT_MIME[ext] ?? "application/octet-stream";
}

function defaultDeps(): ImageCacheDeps {
  return {
    readBinary: (p) => window.stela.vault.readBinary(p),
    mimeFromPath: defaultMimeFromPath,
  };
}

function base64ToBlob(b64: string, mime: string): Blob {
  // atob 在 main / preload 里可能不存在；renderer 一定有
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/**
 * 拿一个绝对路径对应的 blob URL。同一路径多次调用复用同一 URL。
 *
 * 失败时 reject；调用方自行决定是显示 broken icon 还是 fallback。
 */
export async function getImageObjectURL(
  absPath: string,
  deps: ImageCacheDeps = defaultDeps(),
): Promise<string> {
  const cached = entries.get(absPath);
  if (cached) {
    touch(absPath);
    return cached.promise;
  }

  let resolveUrl: (url: string) => void = () => {};
  let rejectUrl: (err: unknown) => void = () => {};
  const promise = new Promise<string>((res, rej) => {
    resolveUrl = res;
    rejectUrl = rej;
  });

  // 占位 entry，避免并发同 path 重复发起
  const placeholder: CacheEntry = {
    url: "",
    promise,
    revoke: () => {},
  };
  entries.set(absPath, placeholder);

  try {
    const b64 = await deps.readBinary(absPath);
    const mimeFn = deps.mimeFromPath ?? defaultMimeFromPath;
    const blob = base64ToBlob(b64, mimeFn(absPath));
    const url = URL.createObjectURL(blob);
    placeholder.url = url;
    placeholder.revoke = () => URL.revokeObjectURL(url);
    evictIfNeeded();
    resolveUrl(url);
    return url;
  } catch (err) {
    entries.delete(absPath);
    rejectUrl(err);
    throw err;
  }
}

/**
 * 直接缓存一段刚刚拿到的字节（粘贴/拖拽场景：renderer 已经有 blob 了，
 * 不用再走 IPC 读回来）。
 */
export function cacheBlob(absPath: string, blob: Blob): string {
  const existing = entries.get(absPath);
  if (existing) {
    try {
      existing.revoke();
    } catch {
      // ignore
    }
    entries.delete(absPath);
  }
  const url = URL.createObjectURL(blob);
  const entry: CacheEntry = {
    url,
    promise: Promise.resolve(url),
    revoke: () => URL.revokeObjectURL(url),
  };
  entries.set(absPath, entry);
  evictIfNeeded();
  return url;
}

/** 仅暴露给单测；返回值不要持有，随时会被 LRU 撤掉。 */
export function _peek(absPath: string): string | undefined {
  return entries.get(absPath)?.url || undefined;
}
