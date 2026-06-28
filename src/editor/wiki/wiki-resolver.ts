/**
 * Wiki link target 解析（v0.3 M1）。
 *
 * 约定（path-strict + 相对路径混合，与 markdown 相对链接对齐）：
 *   - `[[foo]]`           → vault 根下 `foo`
 *   - `[[notes/bar]]`     → vault 根下 `notes/bar`
 *   - `[[/foo]]`          → vault 根下 `foo`（前导 `/` 容错）
 *   - `[[./foo]]`         → 当前笔记同目录下 `foo`
 *   - `[[../foo]]`        → 当前笔记父目录下 `foo`
 *   - `[[../sub/baz]]`    → 多级 `..` 同理；越界（爬出 vault）视为 missing
 *
 * 候选后缀依次 `.md` / 精确（target 已带任一扩展名时只尝试精确）。
 * 返回第一个存在的绝对路径；都不存在时返回首选候选 + `exists: false`，让
 * NodeView 切到 unresolved 样式。
 *
 * 缓存：`(vaultRoot|basePath|target) → 结果` 走 LRU（256 条），watcher 收到
 * 任意外部变更时由 [./../../services/vault-watcher-subscriber.ts](../../services/vault-watcher-subscriber.ts)
 * 调 `clearWikiResolverCache()` 清空。
 */
import { probeFirstExisting } from "@/services/link-resolver";

export interface WikiResolveResult {
  /** 首选候选绝对路径（无论是否存在）。 */
  path: string;
  /** 候选文件是否实际存在。 */
  exists: boolean;
  /** target 里 `#` 之后的 heading anchor（如有），点击后用作 scrollToSlug。 */
  anchor: string | null;
}

/** 把 wiki target 拆成 pathPart + anchor。`pathPart` 可能为空（仅 `#anchor` 不允许）。 */
function splitTarget(target: string): { pathPart: string; anchor: string | null } {
  const i = target.indexOf("#");
  if (i < 0) return { pathPart: target, anchor: null };
  const anchor = target.slice(i + 1).trim();
  return {
    pathPart: target.slice(0, i),
    anchor: anchor.length > 0 ? anchor : null,
  };
}

const CACHE_LIMIT = 256;
const cache = new Map<string, WikiResolveResult>();

function rememberResult(key: string, value: WikiResolveResult): WikiResolveResult {
  if (cache.size >= CACHE_LIMIT) {
    const firstKey = cache.keys().next().value;
    if (typeof firstKey === "string") cache.delete(firstKey);
  }
  cache.set(key, value);
  return value;
}

export function clearWikiResolverCache(): void {
  cache.clear();
}

/** 把分段路径里的 `.` / `..` 折叠掉。返回归一化后的 segments；越界返回 null。 */
function normalizeSegments(segs: string[]): string[] | null {
  const out: string[] = [];
  for (const s of segs) {
    if (!s || s === ".") continue;
    if (s === "..") {
      if (out.length === 0) return null; // 爬出 vault
      out.pop();
      continue;
    }
    out.push(s);
  }
  return out;
}

/**
 * 解析 target 的"目录起点 + 文件段"。
 *
 *   - `./foo`、`../foo`：相对当前笔记目录（basePath 必须给）；basePath 不传时
 *     退化成 vault 根（虽然语义不太对，但好过把链接判死）
 *   - 其它（`/foo` / `foo` / `notes/bar`）：vault 根
 */
function resolveSegments(
  vaultRoot: string,
  basePath: string | null,
  pathPart: string,
): { segs: string[] } | null {
  const cleaned = pathPart.trim().replace(/\\/g, "/");
  if (!cleaned) return null;

  const vaultSegs = vaultRoot.replace(/\\/g, "/").split("/").filter(Boolean);
  let rootSegs: string[];
  let relSource: string;

  // markdown 风相对：以 ./ 或 ../ 开头时，按 basePath 所在目录算
  if (/^\.\.?\//.test(cleaned) || cleaned === "." || cleaned === "..") {
    if (basePath) {
      const baseNorm = basePath.replace(/\\/g, "/");
      const lastSlash = baseNorm.lastIndexOf("/");
      const dirAbs = lastSlash >= 0 ? baseNorm.slice(0, lastSlash) : baseNorm;
      const baseSegs = dirAbs.split("/").filter(Boolean);
      // basePath 必须落在 vault 内：否则不合法，按 vault 根回退（不会走到，但稳妥）
      const within =
        vaultSegs.length === 0 ||
        vaultSegs.every((seg, i) => baseSegs[i] === seg);
      rootSegs = within ? baseSegs : vaultSegs;
      relSource = cleaned;
    } else {
      rootSegs = vaultSegs;
      relSource = cleaned.replace(/^\.\/+/, "");
    }
  } else {
    rootSegs = vaultSegs;
    // 前导 `/` 容错（[[/foo]] 与 [[foo]] 等价）
    relSource = cleaned.replace(/^\/+/, "");
  }

  const relSegs = relSource.split("/");
  // 用 vault 内"已 normalized"的 rootSegs 直接拼，再 normalize 整体——
  // 这样 `..` 在 vault 根内合法，越过根则被 normalizeSegments 判为 null
  const combined = normalizeSegments([...rootSegs, ...relSegs]);
  if (combined === null) return null;

  // 安全闸：归一化后必须仍然以 vaultSegs 为前缀；否则当 missing
  if (
    vaultSegs.length > 0 &&
    !vaultSegs.every((seg, i) => combined[i] === seg)
  ) {
    return null;
  }
  if (combined.length <= vaultSegs.length) return null;

  return { segs: combined };
}

export function buildWikiCandidates(
  vaultRoot: string,
  target: string,
  basePath: string | null = null,
): string[] {
  const { pathPart } = splitTarget(target);
  const resolved = resolveSegments(vaultRoot, basePath, pathPart);
  if (!resolved) return [];

  const isPosixAbs = vaultRoot.replace(/\\/g, "/").startsWith("/");
  const joined = resolved.segs.join("/");
  const abs = isPosixAbs ? `/${joined}` : joined;

  const hasKnownSuffix = /\.md$/i.test(abs);
  return hasKnownSuffix ? [abs] : [`${abs}.md`, abs];
}

export async function resolveWikiTarget(
  vaultRoot: string,
  target: string,
  basePath: string | null = null,
): Promise<WikiResolveResult | null> {
  const candidates = buildWikiCandidates(vaultRoot, target, basePath);
  if (candidates.length === 0) return null;
  const { anchor } = splitTarget(target);

  const cacheKey = `${vaultRoot}|${basePath ?? ""}|${target.trim()}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const probed = await probeFirstExisting(candidates);
  const full: WikiResolveResult = { ...probed, anchor };
  return rememberResult(cacheKey, full);
}
