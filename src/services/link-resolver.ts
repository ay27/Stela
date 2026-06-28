/**
 * Markdown 相对链接解析工具。
 *
 * 负责把像 `./sub/b.md`、`../parent.md`、`/root-rel/x.md#heading`、
 * `Page` 这样的 href 解析为 vault 内的绝对路径 + 可选 heading slug，并提供
 * `.md` 后缀探测。
 *
 * 约束：
 *   - 纯静态函数，不触网；`probeFirstExisting` 才会调 `path_exists` invoke。
 *   - 分隔符统一用 `/`。Tauri / Rust 侧在 Windows 上接受 `/`，无须在这里改回 `\`。
 */

import { pathExists } from "./fs";

/** 把 `foo.md#bar` 拆成 path + slug。`#` 后留空时 slug 为 undefined。 */
export function parseHrefHash(href: string): { pathPart: string; slug?: string } {
  const hashIdx = href.indexOf("#");
  if (hashIdx < 0) return { pathPart: href };
  const pathPart = href.slice(0, hashIdx);
  const raw = href.slice(hashIdx + 1);
  return { pathPart, slug: raw.length > 0 ? raw : undefined };
}

/** 安全地 URL decode；解码失败保持原样（防止被坏 `%` 截断）。 */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * 判定一个 href 是否为"vault 内相对/绝对路径链接"。
 *
 * 排除项：
 *   - 外部协议（`http:` `https:` `mailto:` `tauri:` `stela:` 等）
 *   - 纯 `#anchor`（文档内跳转，由上层单独处理）
 *   - 空字符串
 *
 * 规则：任何形如 `./x`、`../x`、`x/y`、`x.md`、`/x` 的都算相对链接。
 */
export function isVaultRelativeHref(href: string): boolean {
  if (!href) return false;
  if (href.startsWith("#")) return false;
  // 协议前缀；scheme 后紧跟 `:`
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return false;
  return true;
}

/**
 * 把一段路径段按 `.`/`..` 语义合并。不依赖 Node `path`——前端 bundle 干净。
 *
 * 输入已按 `/` split 过；输出是合并后的 segment 数组。非法越过根（`..` 比正向段
 * 多）时仍然最多退到 0 长度，调用方处理"越界"语义。
 */
function normalizeSegments(segs: string[]): string[] {
  const out: string[] = [];
  for (const s of segs) {
    if (s === "" || s === ".") continue;
    if (s === "..") {
      out.pop();
      continue;
    }
    out.push(s);
  }
  return out;
}

/**
 * Resolve a relative/absolute-in-vault href against the current document's
 * absolute path. Returns 1..2 candidate absolute paths (for `.md`
 * suffix probing) + optional slug. `null` 表示 href 根本不是路径链接。
 *
 * 约定（与 Obsidian 对齐）：
 *   - 前导 `/` 表示 vault 根相对；解析时跳过 basePath。
 *   - 其它（包括不以 `./` 开头的）都按 basePath 所在目录解析。
 *   - 候选后缀：精确 → `.md`。如果用户写的 href 已经有任一后缀，
 *     就只返回精确一项；否则返回 2 个（精确、+.md）。
 */
export function resolveHrefToCandidates(args: {
  basePath: string;
  vaultRoot: string;
  href: string;
}): { candidates: string[]; slug?: string } | null {
  const { basePath, vaultRoot, href } = args;
  if (!isVaultRelativeHref(href)) return null;

  const { pathPart, slug } = parseHrefHash(href);
  if (pathPart === "") {
    // 形如 `#foo` 走不到这里（上面已拦掉），但 `foo.md#bar` 没走到；保护性返回。
    return slug ? { candidates: [basePath], slug } : null;
  }

  const decoded = safeDecode(pathPart).replace(/\\/g, "/");

  // 确定 "base 目录"
  let rootSegs: string[];
  if (decoded.startsWith("/")) {
    rootSegs = vaultRoot.replace(/\\/g, "/").split("/").filter(Boolean);
  } else {
    const baseNorm = basePath.replace(/\\/g, "/");
    const lastSlash = baseNorm.lastIndexOf("/");
    rootSegs = (lastSlash >= 0 ? baseNorm.slice(0, lastSlash) : baseNorm)
      .split("/")
      .filter(Boolean);
  }

  const relSegs = decoded.split("/");
  const combined = normalizeSegments([...rootSegs, ...relSegs]);
  // POSIX 风绝对路径前补 `/`；Windows 绝对路径（`C:/...`）第一段带 `:`，不需要
  const isPosixAbs =
    (decoded.startsWith("/") ? vaultRoot : basePath).replace(/\\/g, "/").startsWith("/");
  const joined = combined.join("/");
  const abs = isPosixAbs ? `/${joined}` : joined;

  // 后缀探测候选
  const hasKnownSuffix = /\.md$/i.test(abs);
  const candidates = hasKnownSuffix ? [abs] : [abs, `${abs}.md`];
  return { candidates, slug };
}

/**
 * 依次 `path_exists` 一组候选，返回第一个存在的绝对路径；全都不存在时返回
 * `candidates[0]`——让上层去决定"提示用户"还是"按 `.md` 创建"（A/B）。
 *
 * 并发注意：这里顺序 await，对文件系统友好；候选数 <= 2，延迟可忽略。
 */
export async function probeFirstExisting(candidates: string[]): Promise<{
  path: string;
  exists: boolean;
}> {
  for (const c of candidates) {
    const ok = await pathExists(c).catch(() => false);
    if (ok) return { path: c, exists: true };
  }
  return { path: candidates[0] ?? "", exists: false };
}
