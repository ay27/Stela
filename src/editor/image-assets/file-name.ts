/**
 * 图片附件文件名生成。
 *
 * 输入：
 *   - 原始文件名（File.name；剪贴板截图通常是 `image.png`，浏览器拖入是真名）
 *   - MIME 类型（截图来源没有扩展名时用来兜底推断）
 *   - 时间戳（默认 Date.now()）
 *
 * 输出：合理的纯文件名（不含路径分隔符），形如：
 *   - 用户给了 `screenshot.png` → `screenshot.png`（保留原名，service 层会再做
 *     冲突后缀；这里不做加时间戳，避免文件树里满屏 `xxx-20260518-1702`）
 *   - 用户给了 `image.png`（系统截图常用占位）→ `image-20260518-150207.png`
 *   - 没给名也没给 MIME → `image-<ts>.bin`
 *
 * 抽出来纯函数方便单测，不依赖 DOM / window。
 */

const MIME_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/bmp": ".bmp",
  "image/avif": ".avif",
  "image/heic": ".heic",
  "image/heif": ".heif",
};

/** 浏览器/系统粘贴占位名，命中即视为"没有真实文件名"，要补时间戳。 */
const GENERIC_PLACEHOLDERS = new Set([
  "image",
  "image.png",
  "image.jpg",
  "image.jpeg",
  "image.gif",
  "image.webp",
  "image.heic",
  "image.heif",
  "untitled",
  "untitled.png",
  "screenshot",
  "screenshot.png",
  "图片",
  "图片.png",
  "未命名",
]);

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** `20260518-150207` 时间戳串：稳定、按字典序就是按时间序。 */
export function formatTimestamp(d: Date): string {
  return (
    `${d.getFullYear()}` +
    `${pad2(d.getMonth() + 1)}` +
    `${pad2(d.getDate())}` +
    `-` +
    `${pad2(d.getHours())}` +
    `${pad2(d.getMinutes())}` +
    `${pad2(d.getSeconds())}`
  );
}

export function extFromMime(mime: string | null | undefined): string {
  if (!mime) return ".bin";
  return MIME_EXT[mime.toLowerCase()] ?? ".bin";
}

/** 提取扩展名（含 `.`，小写）；没有时返回空串。 */
export function extOf(name: string): string {
  const idx = name.lastIndexOf(".");
  if (idx <= 0) return "";
  return name.slice(idx).toLowerCase();
}

/** 去掉路径分隔符与不安全字符，返回安全的 basename（不再含目录段）。 */
export function sanitizeBaseName(name: string): string {
  // path 分隔符与控制字符
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim();
  if (cleaned.length === 0) return "image";
  return cleaned.length > 200 ? cleaned.slice(0, 200) : cleaned;
}

interface BuildOptions {
  /** 原始 File.name；可能为空字符串或占位符 */
  rawName?: string;
  /** File.type / Blob.type；用于推扩展名 */
  mime?: string;
  /** 注入时间戳，方便单测；默认 Date.now() */
  now?: Date;
}

/**
 * 决定附件文件名。规则：
 *   1. rawName 是有意义的真实文件名 → 直接用（仅 sanitize），由 main 端做冲突后缀
 *   2. rawName 缺失 / 是占位符（image.png 等）→ 使用 `image-<timestamp><ext>`
 *   3. ext 优先级：原文件名扩展 > MIME 推断 > `.bin`
 */
export function buildAttachmentFileName(opts: BuildOptions): string {
  const { rawName, mime, now } = opts;
  const ts = formatTimestamp(now ?? new Date());
  const trimmed = (rawName ?? "").trim();
  const lowered = trimmed.toLowerCase();
  const isPlaceholder =
    trimmed.length === 0 || GENERIC_PLACEHOLDERS.has(lowered);

  if (!isPlaceholder) {
    return sanitizeBaseName(trimmed);
  }

  const fromName = extOf(trimmed);
  const ext = fromName.length > 0 ? fromName : extFromMime(mime);
  return `image-${ts}${ext}`;
}
