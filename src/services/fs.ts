/**
 * Vault 文件系统：renderer 侧封装。
 *
 * 实现走 Electron preload 暴露的 `window.stela.vault`，main 进程在
 * `electron/services/vault-fs.ts` 实现具体逻辑。
 *
 * 写操作（createDir / createFile / renamePath / deletePath）会顺带调用
 * [`scheduleAutoGit`](./auto-git.ts)：让 AutoGit 在文件树操作后也能跟随提交。
 * 读操作（listDir / readFile / pathExists / storageDbSize）不触发提交。
 */

import { scheduleAutoGit } from "@/services/auto-git";

export interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
}

export async function listDir(path: string): Promise<FileNode[]> {
  return window.stela.vault.listDir(path);
}

export async function readFile(path: string): Promise<string> {
  return window.stela.vault.readFile(path);
}

export async function pathExists(path: string): Promise<boolean> {
  return window.stela.vault.pathExists(path);
}

export async function pickVault(): Promise<string | null> {
  return window.stela.dialog.pickVault();
}

export async function createDir(vaultPath: string, path: string): Promise<void> {
  await window.stela.vault.createDir(vaultPath, path);
  scheduleAutoGit("file-tree-create-dir");
}

export async function createFile(
  vaultPath: string,
  path: string,
  contents: string,
): Promise<void> {
  await window.stela.vault.createFile(vaultPath, path, contents);
  scheduleAutoGit("file-tree-create-file");
}

export async function renamePath(
  vaultPath: string,
  from: string,
  to: string,
): Promise<void> {
  await window.stela.vault.renamePath(vaultPath, from, to);
  scheduleAutoGit("file-tree-rename");
}

export async function deletePath(
  vaultPath: string,
  path: string,
): Promise<void> {
  await window.stela.vault.deletePath(vaultPath, path);
  scheduleAutoGit("file-tree-delete");
}

export async function importFile(
  vaultPath: string,
  sourcePath: string,
  destDir: string,
): Promise<string> {
  const finalPath = await window.stela.vault.importFile(
    vaultPath,
    sourcePath,
    destDir,
  );
  scheduleAutoGit("file-tree-import");
  return finalPath;
}

export async function storageDbSize(vaultPath: string): Promise<number> {
  return window.stela.vault.storageDbSize(vaultPath);
}
