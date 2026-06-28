/**
 * 凭据保护：Electron 内置 safeStorage 包裹（macOS Keychain / Windows DPAPI / Linux libsecret）。
 *
 * 用法：connections-store 在写入连接 entry 之前，把 entry.config.password
 * 用 `encryptToken` 加密成 base64 字符串，存盘时使用 `__enc:<base64>` 前缀；
 * 读取时检测前缀，调 `decryptToken` 解回明文，再返回给 renderer。
 *
 * 不支持时（safeStorage.isEncryptionAvailable() === false）：
 *   - Linux 上某些场景缺 desktop session → 直接返回原文（带前缀 `__plain:`）
 *   - 提供 `isAvailable()` 给 UI 显示降级 banner
 */

import { createRequire } from "node:module";

import type { CredentialStorageStatus } from "@shared/types";

const ENC_PREFIX = "__enc:";
const PLAIN_PREFIX = "__plain:";

/**
 * 懒加载 `electron.safeStorage`。
 *
 * 直接 `import { safeStorage } from "electron"` 在 ESM 严格命名导出校验下会
 * 抛 `does not provide an export named 'safeStorage'`，因为 `electron` 包在
 * 普通 Node 进程下的 entry 只导出一个字符串（electron 二进制路径）。这会让
 * 任何不是在 Electron 内运行的脚本（例如基于 tsx 的单元测试）连模块加载都
 * 过不了，无法只 stub safeStorage。
 *
 * 这里用 `createRequire` 在运行时按需取 safeStorage：
 *   - Electron 主进程内：require("electron") 返回完整 API，能拿到 safeStorage。
 *   - 普通 Node / tsx 内：返回字符串路径，访问 .safeStorage 拿到 undefined，
 *     `isAvailable()` 的 try/catch 兜底 → 走 `__plain:` 降级路径。
 */
type SafeStorageLike = {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(buf: Buffer): string;
};

let _safeStorageCached: SafeStorageLike | null | undefined;

function getSafeStorage(): SafeStorageLike | null {
  if (_safeStorageCached !== undefined) return _safeStorageCached;
  try {
    const req = createRequire(import.meta.url);
    const mod = req("electron") as { safeStorage?: SafeStorageLike } | string;
    _safeStorageCached =
      typeof mod === "object" && mod !== null && "safeStorage" in mod
        ? (mod as { safeStorage?: SafeStorageLike }).safeStorage ?? null
        : null;
  } catch {
    _safeStorageCached = null;
  }
  return _safeStorageCached;
}

/** 视为敏感的 config 字段名（小写匹配）。redactConfig 会把它们替换成占位串。 */
const SECRET_KEYS = new Set([
  "password",
  "token",
  "secret",
  "apikey",
  "api_key",
  "accesskey",
  "access_key",
  "authorization",
]);

const REDACTED = "***redacted***";

/**
 * 字段名是否视为凭据（小写匹配）。connections-store 用它决定哪些 config 字段
 * 在写盘前经 safeStorage 加密、读出时解密；与 redactConfig 共用同一份口径。
 */
export function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key.toLowerCase());
}

export function isAvailable(): boolean {
  const sa = getSafeStorage();
  if (!sa) return false;
  try {
    return sa.isEncryptionAvailable();
  } catch {
    return false;
  }
}

export function getStatus(): CredentialStorageStatus {
  const available = isAvailable();
  return {
    available,
    backend: available ? "safeStorage" : "plain",
    platform: process.platform,
  };
}

/**
 * 把 config 对象里所有「看起来是凭据」的字段替换成占位符，便于 main 进程
 * 安全地打日志 / 错误上报。**仅用于日志展示**——绝不要把 redacted 后的对象
 * 当作真实 config 写回磁盘或转发给 connector。
 *
 * 浅层处理已经覆盖现有 mysql / http connector 的 config；如果未来插件用嵌套
 * 字段存 token，再扩展为深拷贝即可。
 */
export function redactConfig(config: unknown): unknown {
  if (!config || typeof config !== "object") return config;
  const src = config as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (SECRET_KEYS.has(k.toLowerCase())) {
      out[k] = typeof v === "string" && v.length === 0 ? "" : REDACTED;
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function encryptToken(plain: string): string {
  if (!plain) return plain;
  const sa = getSafeStorage();
  if (!sa || !isAvailable()) {
    return PLAIN_PREFIX + plain;
  }
  const buf = sa.encryptString(plain);
  return ENC_PREFIX + buf.toString("base64");
}

export function decryptToken(stored: string): string {
  if (!stored) return stored;
  if (stored.startsWith(ENC_PREFIX)) {
    const sa = getSafeStorage();
    if (!sa || !isAvailable()) {
      // 加密过的串现在解不开 → 返回空串，UI 提示用户重输
      return "";
    }
    const buf = Buffer.from(stored.slice(ENC_PREFIX.length), "base64");
    try {
      return sa.decryptString(buf);
    } catch {
      return "";
    }
  }
  if (stored.startsWith(PLAIN_PREFIX)) {
    return stored.slice(PLAIN_PREFIX.length);
  }
  // 兼容老明文（迁移期）
  return stored;
}

/**
 * 标记一条字符串是否「看起来已被 wrapped」。用于避免对已加密数据二次加密。
 */
export function isWrapped(s: string): boolean {
  return s.startsWith(ENC_PREFIX) || s.startsWith(PLAIN_PREFIX);
}
