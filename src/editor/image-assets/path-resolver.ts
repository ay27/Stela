/**
 * 图片相对路径解析。
 *
 * 笔记 `<note-stem>.assets/foo.png` 这类相对引用要在 renderer 里换算成
 * 真实绝对路径，才能通过 IPC 读字节、生成 blob URL。
 *
 * 同时把"是不是受我们管"判断收敛到一处：
 *   - http(s):, data:, blob:, mailto: → 不归我们管，不重写
 *   - 其他相对 / 绝对路径 → 归我们管
 *
 * 纯函数，不依赖 window / DOM，便于单测。
 */

export function isExternalUrl(url: string): boolean {
  // 注意：要处理大小写
  return /^(?:[a-z][a-z0-9+\-.]*:|\/\/)/i.test(url) === true && !isFsProtocol(url);
}

function isFsProtocol(url: string): boolean {
  // 我们只关心走绝对路径形态的 file://；其他 scheme 都视为外部。
  return /^file:/i.test(url);
}

/**
 * 把相对 `src` 解析为绝对路径。
 *
 * 规则：
 *   - http/https/data/blob/mailto 直接原样返回（外部资源）
 *   - file://... → strip protocol，返回剩下的绝对路径
 *   - 绝对路径（以 `/` 开头）→ 原样返回
 *   - 相对路径 → 相对 notePath 所在目录解析
 *
 * notePath 必须是绝对路径；vaultPath 用来兜底（notePath 缺失时）。
 *
 * 返回 null 表示外部资源、不需要改写。
 */
export function resolveImageSrc(
  src: string,
  notePath: string | null,
  vaultPath: string | null,
): string | null {
  if (!src) return null;
  if (src.startsWith("data:") || src.startsWith("blob:")) return null;
  if (isExternalUrl(src)) return null;
  if (/^file:/i.test(src)) {
    // file:///abs/path 或 file://abs/path
    const stripped = src.replace(/^file:\/{2,}/i, "/");
    return stripped;
  }
  if (src.startsWith("/")) return src;

  // 相对路径
  const baseDir = notePath
    ? dirOf(notePath)
    : vaultPath ?? null;
  if (!baseDir) return null;
  return joinPosix(baseDir, src);
}

function dirOf(absPath: string): string {
  // 兼容 Windows 风格分隔符；返回去掉最后一段的目录
  const norm = absPath.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  if (idx < 0) return norm;
  if (idx === 0) return "/";
  return norm.slice(0, idx);
}

/** POSIX 风格路径拼接 + `..` / `.` 折叠。 */
function joinPosix(base: string, rel: string): string {
  const baseSegs = base.replace(/\\/g, "/").split("/").filter((s) => s !== "");
  const relSegs = rel.replace(/\\/g, "/").split("/");
  const out = base.startsWith("/") ? [""] : []; // 保留绝对前导 /
  out.push(...baseSegs);
  for (const seg of relSegs) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      // 不允许越过 base 根；越界时停在根
      if (out.length > (out[0] === "" ? 1 : 0)) out.pop();
      continue;
    }
    out.push(seg);
  }
  // out[0] === "" 表示绝对路径
  if (out[0] === "") return "/" + out.slice(1).join("/");
  return out.join("/");
}

/** 仅暴露给单测 / 内部组件。 */
export const _internals = { dirOf, joinPosix };
