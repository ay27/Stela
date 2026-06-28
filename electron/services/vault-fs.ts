/**
 * Vault 文件系统 service。
 *
 * 安全约束：
 * - 所有写操作必须落在 vault 内（canonicalize 后 startsWith 校验）
 * - 大文件（> 10MB）的纯文本读取直接拒绝，避免阻塞 main event loop
 * - 删除走系统回收站（trash），不直接 rm，可恢复
 *
 * Renderer 传入的 path 永远不可信；ensureWithinVault 是边界守卫。
 *
 * 文件系统安全边界：
 * - listDir 跳过隐藏目录与 node_modules / target / dist / build / __pycache__
 * - 目录排在文件之前；同类按 lower-case name 升序
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { AppError } from "@shared/errors";
import type { FileNode } from "@shared/types";

import { notifySelfWrite } from "./vault-watcher";

/**
 * 懒加载 `electron.shell`。
 *
 * 同 [`secrets.ts`](./secrets.ts) 的 `getSafeStorage`：在普通 Node / tsx 下，
 * 顶层 `import { shell } from "electron"` 会因 ESM 严格命名导出校验直接抛错，
 * 让单元测试连模块加载都过不了。这里改为运行时 `createRequire` 取 shell；
 * Electron 内拿到完整 API，普通 Node 下拿到 null，由调用方决定是否降级。
 */
type ShellLike = {
  trashItem(p: string): Promise<void>;
  showItemInFolder(p: string): void;
  openPath(p: string): Promise<string>;
};

let _shellCached: ShellLike | null | undefined;

function getShell(): ShellLike | null {
  if (_shellCached !== undefined) return _shellCached;
  try {
    const req = createRequire(import.meta.url);
    const mod = req("electron") as { shell?: ShellLike } | string;
    _shellCached =
      typeof mod === "object" && mod !== null && "shell" in mod
        ? (mod as { shell?: ShellLike }).shell ?? null
        : null;
  } catch {
    _shellCached = null;
  }
  return _shellCached;
}

const MAX_TEXT_BYTES = 10 * 1024 * 1024;

const SKIPPED_DIRS = new Set([
  "node_modules",
  "target",
  "dist",
  "build",
  "__pycache__",
]);

function shouldSkip(name: string): boolean {
  if (name.startsWith(".")) return true;
  return SKIPPED_DIRS.has(name);
}

export async function listDir(p: string): Promise<FileNode[]> {
  let stat;
  try {
    stat = await fs.stat(p);
  } catch (err) {
    throw new AppError("not_found", `read_dir failed: ${(err as Error).message}`);
  }
  if (!stat.isDirectory()) {
    throw new AppError("not_a_directory", `not a directory: ${p}`);
  }
  const entries = await fs.readdir(p, { withFileTypes: true });
  const nodes: FileNode[] = [];
  for (const ent of entries) {
    if (shouldSkip(ent.name)) continue;
    const full = path.join(p, ent.name);
    nodes.push({
      name: ent.name,
      path: full,
      isDir: ent.isDirectory(),
    });
  }
  nodes.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
  return nodes;
}

export async function readFile(p: string): Promise<string> {
  let stat;
  try {
    stat = await fs.stat(p);
  } catch (err) {
    throw new AppError("read_failed", `stat failed: ${(err as Error).message}`);
  }
  if (stat.size > MAX_TEXT_BYTES) {
    throw new AppError(
      "file_too_large",
      `file too large (> ${MAX_TEXT_BYTES / 1024 / 1024} MB)`,
    );
  }
  try {
    return await fs.readFile(p, "utf-8");
  } catch (err) {
    throw new AppError("read_failed", `read failed: ${(err as Error).message}`);
  }
}

const MAX_BINARY_BYTES = 25 * 1024 * 1024;

/**
 * 把任意二进制文件读成 base64。renderer 用来加载 vault 内附件（图片）显示——
 * Markdown `<img src>` 是相对路径，CSP 不允许直接走 `file://`，所以要走 IPC
 * 拉字节再在 renderer 拼 blob URL。
 *
 * 限制：单文件 25MB，超出直接报错。也不要拿来读不在 vault 内的随便路径——
 * 调用侧应该先经过 ensureWithinVault。
 */
export async function readBinary(p: string): Promise<string> {
  let stat;
  try {
    stat = await fs.stat(p);
  } catch (err) {
    throw new AppError(
      "read_failed",
      `stat failed: ${(err as Error).message}`,
    );
  }
  if (!stat.isFile()) {
    throw new AppError("not_a_file", `not a regular file: ${p}`);
  }
  if (stat.size > MAX_BINARY_BYTES) {
    throw new AppError(
      "file_too_large",
      `binary too large (> ${MAX_BINARY_BYTES / 1024 / 1024} MB)`,
    );
  }
  try {
    const buf = await fs.readFile(p);
    return buf.toString("base64");
  } catch (err) {
    throw new AppError(
      "read_failed",
      `read failed: ${(err as Error).message}`,
    );
  }
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function writeFile(p: string, contents: string): Promise<void> {
  // 在写之前先标记 suppress——chokidar 可能在 fs.writeFile 完成的同一个 tick
  // 内就触发 change 事件，回调里再 notify 已经晚了。
  notifySelfWrite(p);
  try {
    await fs.writeFile(p, contents, "utf-8");
  } catch (err) {
    throw new AppError(
      "write_failed",
      `write failed: ${(err as Error).message}`,
    );
  }
}

/**
 * canonicalize vault；若 target 不存在，沿父目录回溯到第一个真实存在的祖先做
 * realpath，再拼回未创建的尾部。这样既能拒绝 .. / 软链跳出 vault，也允许
 * 目标尚未创建（新建文件 / 新建多级目录）。
 */
export async function ensureWithinVault(
  vaultPath: string,
  target: string,
): Promise<string> {
  let vaultReal: string;
  try {
    vaultReal = await fs.realpath(vaultPath);
  } catch (err) {
    throw new AppError(
      "invalid_vault",
      `invalid vault path: ${(err as Error).message}`,
    );
  }
  let probe: string;
  try {
    probe = await fs.realpath(target);
  } catch {
    // walk up to first existing ancestor
    let cursor = path.resolve(target);
    const tail: string[] = [];
    while (true) {
      try {
        const real = await fs.realpath(cursor);
        probe = path.join(real, ...tail.reverse());
        break;
      } catch {
        const parent = path.dirname(cursor);
        if (parent === cursor) {
          throw new AppError("invalid_path", `no existing ancestor for ${target}`);
        }
        tail.push(path.basename(cursor));
        cursor = parent;
      }
    }
  }
  if (probe !== vaultReal && !probe.startsWith(vaultReal + path.sep)) {
    throw new AppError(
      "outside_vault",
      `path '${probe}' escapes vault '${vaultReal}'`,
    );
  }
  return probe;
}

export async function createDir(
  vaultPath: string,
  p: string,
): Promise<void> {
  const target = await ensureWithinVault(vaultPath, p);
  if (await pathExists(target)) {
    throw new AppError("already_exists", `path already exists: ${target}`);
  }
  await fs.mkdir(target, { recursive: true });
}

export async function createFile(
  vaultPath: string,
  p: string,
  contents: string,
): Promise<void> {
  const target = await ensureWithinVault(vaultPath, p);
  if (await pathExists(target)) {
    throw new AppError("already_exists", `file already exists: ${target}`);
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  notifySelfWrite(target);
  await fs.writeFile(target, contents, "utf-8");
}

export async function renamePath(
  vaultPath: string,
  from: string,
  to: string,
): Promise<void> {
  const src = await ensureWithinVault(vaultPath, from);
  const dst = await ensureWithinVault(vaultPath, to);
  if (!(await pathExists(src))) {
    throw new AppError("not_found", `source does not exist: ${src}`);
  }
  if (await pathExists(dst)) {
    throw new AppError("already_exists", `destination already exists: ${dst}`);
  }
  await fs.mkdir(path.dirname(dst), { recursive: true });
  // 两端都要 suppress：rename 触发 unlink(src) + add(dst) 两条事件
  notifySelfWrite(src);
  notifySelfWrite(dst);
  await fs.rename(src, dst);
}

/** 删除走系统回收站（shell.trashItem 在 Electron 里跨平台可用） */
export async function deletePath(
  vaultPath: string,
  p: string,
): Promise<void> {
  const target = await ensureWithinVault(vaultPath, p);
  if (!(await pathExists(target))) {
    throw new AppError("not_found", `path does not exist: ${target}`);
  }
  const shell = getShell();
  if (!shell) {
    throw new AppError(
      "shell_unavailable",
      "electron.shell is not available in this runtime",
    );
  }
  notifySelfWrite(target);
  await shell.trashItem(target);
}

/**
 * 把任意 OS 路径下的文件复制进 vault 的某个目录。
 *
 * 使用场景：用户把 Finder / Explorer 里的文件拖到文件树。`destDir` 必须落在
 * vault 内（ensureWithinVault 守卫），`sourcePath` 不限位置（可以是 vault
 * 之外的桌面 / 下载目录）。
 *
 * 同名处理：若目标目录已有同名文件，自动加 ` (1)` / ` (2)` 后缀直到找到空位，
 * 避免覆盖现有内容。返回最终落地的绝对路径。
 *
 * 仅复制普通文件；目录递归复制不在范围内（v1 复杂度可控，留待后续）。
 */
export async function importFile(
  vaultPath: string,
  sourcePath: string,
  destDir: string,
): Promise<string> {
  const destDirAbs = await ensureWithinVault(vaultPath, destDir);
  let srcStat;
  try {
    srcStat = await fs.stat(sourcePath);
  } catch (err) {
    throw new AppError(
      "not_found",
      `source does not exist: ${(err as Error).message}`,
    );
  }
  if (!srcStat.isFile()) {
    throw new AppError(
      "not_a_file",
      `source is not a regular file: ${sourcePath}`,
    );
  }
  let destStat;
  try {
    destStat = await fs.stat(destDirAbs);
  } catch {
    throw new AppError("not_found", `dest dir does not exist: ${destDirAbs}`);
  }
  if (!destStat.isDirectory()) {
    throw new AppError(
      "not_a_directory",
      `dest is not a directory: ${destDirAbs}`,
    );
  }

  const baseName = path.basename(sourcePath);
  const finalName = await pickAvailableName(destDirAbs, baseName);
  const target = path.join(destDirAbs, finalName);
  notifySelfWrite(target);
  try {
    await fs.copyFile(sourcePath, target, fs.constants?.COPYFILE_EXCL ?? 0);
  } catch (err) {
    throw new AppError(
      "write_failed",
      `import copy failed: ${(err as Error).message}`,
    );
  }
  return target;
}

/**
 * 把 renderer 传入的二进制 blob（base64）写到 vault 根目录下的统一 `assets/`
 * 文件夹里。
 *
 * 使用场景：用户在 Markdown 编辑器里粘贴 / 拖入图片。renderer 拿到 ClipboardEvent
 * 的 File / Blob 后转 base64 通过 IPC 送过来；这里负责选目录、选文件名、写盘。
 *
 * 设计取舍：早期实现是每个 note 旁边放 `<stem>.assets/`，文件树会被几十个
 * 散落的 `*.assets` 文件夹刷得很乱。改成 vault 根 `assets/` 后，所有图片集中
 * 一处，note 旁边只剩 `.md`。代价是 markdown 里写相对路径时要 `../assets/...`，
 * 但同步 / 移植 vault 时整体仍然自洽。
 *
 * 安全：
 *   - notePath 必须落在 vault 内（ensureWithinVault）
 *   - 真实写入路径还会再走一次 ensureWithinVault，防止 fileName 含 `..` / `/` 越界
 *   - 单文件上限 25MB（base64 解码后字节数）
 *
 * 同名处理：复用 [pickAvailableName](#pickAvailableName) 的 ` (1)` / ` (2)` 后缀。
 *
 * 返回：
 *   - `absPath`：附件最终绝对路径（一定落在 `<vault>/assets/`）
 *   - `relPath`：相对于 note 所在目录的 POSIX 路径，可直接拼到 markdown `![](...)`
 */
export interface SavedAttachment {
  absPath: string;
  relPath: string;
}

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** vault 根目录下统一的附件文件夹名。 */
export const ATTACHMENTS_DIR_NAME = "assets";

/** 把任意 fileName 收敛到一个安全 basename：去路径分隔符、去控制字符、保留扩展名。 */
export function sanitizeAttachmentName(fileName: string): string {
  const base = path.basename(fileName);
  // 删 / \\ : * ? " < > | + ASCII 控制字符
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim();
  if (cleaned.length === 0) return "image";
  return cleaned.length > 200 ? cleaned.slice(0, 200) : cleaned;
}

export async function saveAttachment(
  vaultPath: string,
  notePath: string,
  fileName: string,
  base64: string,
): Promise<SavedAttachment> {
  // notePath 仅用于校验（必须在 vault 内）+ 计算 relPath；写入目录恒为
  // `<vault>/assets/`，跟 note 在哪一层无关。
  const noteAbs = await ensureWithinVault(vaultPath, notePath);
  const noteDir = path.dirname(noteAbs);
  const destDir = path.join(vaultPath, ATTACHMENTS_DIR_NAME);
  // ensureWithinVault 兼容尚未创建的目录：会回溯到第一个存在的祖先
  const destDirAbs = await ensureWithinVault(vaultPath, destDir);

  let buf: Buffer;
  try {
    buf = Buffer.from(base64, "base64");
  } catch (err) {
    throw new AppError(
      "invalid_attachment",
      `base64 decode failed: ${(err as Error).message}`,
    );
  }
  if (buf.length === 0) {
    throw new AppError("invalid_attachment", "attachment is empty");
  }
  if (buf.length > MAX_ATTACHMENT_BYTES) {
    throw new AppError(
      "attachment_too_large",
      `attachment exceeds ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`,
    );
  }

  const safeName = sanitizeAttachmentName(fileName);
  await fs.mkdir(destDirAbs, { recursive: true });
  const finalName = await pickAvailableName(destDirAbs, safeName);
  const targetCandidate = path.join(destDirAbs, finalName);
  // 再校验一次：把 fileName 拼进路径后必须仍在 vault 内
  const targetAbs = await ensureWithinVault(vaultPath, targetCandidate);
  notifySelfWrite(targetAbs);
  try {
    await fs.writeFile(targetAbs, buf);
  } catch (err) {
    throw new AppError(
      "write_failed",
      `attachment write failed: ${(err as Error).message}`,
    );
  }
  // 相对路径走 POSIX `/`，让 markdown 在所有平台都一致：
  //   - vault 根 note         → `assets/foo.png`
  //   - vault 子目录 note     → `../assets/foo.png` / `../../assets/foo.png` ...
  const rel = path
    .relative(noteDir, targetAbs)
    .split(path.sep)
    .join("/");
  return { absPath: targetAbs, relPath: rel };
}

/** 在目标目录里找一个可用的同名文件名，重复时按 `name (1).ext` / `name (2).ext` 递增。 */
async function pickAvailableName(
  dirAbs: string,
  baseName: string,
): Promise<string> {
  if (!(await pathExists(path.join(dirAbs, baseName)))) return baseName;
  const dot = baseName.lastIndexOf(".");
  const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
  const ext = dot > 0 ? baseName.slice(dot) : "";
  for (let i = 1; i < 10_000; i++) {
    const cand = `${stem} (${i})${ext}`;
    if (!(await pathExists(path.join(dirAbs, cand)))) return cand;
  }
  throw new AppError(
    "already_exists",
    `cannot find available name for ${baseName} in ${dirAbs}`,
  );
}

/**
 * 在系统文件管理器里高亮并显示给定路径（mac Finder / Windows Explorer / Linux DE）。
 * 必须经过 `ensureWithinVault` 守卫，避免 renderer 任意点开系统目录。
 */
export async function showItemInFolder(
  vaultPath: string,
  p: string,
): Promise<void> {
  const target = await ensureWithinVault(vaultPath, p);
  const shell = getShell();
  if (!shell) {
    throw new AppError(
      "shell_unavailable",
      "electron.shell is not available in this runtime",
    );
  }
  shell.showItemInFolder(target);
}

/**
 * 用系统默认行为打开路径（目录会在文件管理器中打开，文件会用关联程序打开）。
 * 同 showItemInFolder：必须落在 vault 内。
 */
export async function openPath(
  vaultPath: string,
  p: string,
): Promise<void> {
  const target = await ensureWithinVault(vaultPath, p);
  const shell = getShell();
  if (!shell) {
    throw new AppError(
      "shell_unavailable",
      "electron.shell is not available in this runtime",
    );
  }
  const err = await shell.openPath(target);
  if (err) {
    throw new AppError("open_failed", `openPath failed: ${err}`);
  }
}

export async function storageDbSize(vaultPath: string): Promise<number> {
  const dbPath = path.join(vaultPath, ".stela.sqlite");
  try {
    const s = await fs.stat(dbPath);
    return s.size;
  } catch {
    return 0;
  }
}
