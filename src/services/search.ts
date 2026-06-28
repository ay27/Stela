/**
 * 跨文件搜索 / 文件列表服务（Electron 适配）。
 *
 * 走 main 进程 `electron/services/search.ts`：
 *   - searchVault：行级 substring 命中（字符级别 Unicode-safe）
 *   - listVaultFiles：递归列出指定扩展名的文件，给命令面板用
 */

import { STELA_EXTENSIONS } from "@/core/stela-file";

export interface SearchHit {
  path: string;
  line: number;
  column: number;
  snippet: string;
}

export async function searchVault(
  vaultPath: string,
  keyword: string,
  options: { caseSensitive?: boolean; maxHits?: number } = {},
): Promise<SearchHit[]> {
  return window.stela.search.vault(vaultPath, keyword, {
    caseSensitive: options.caseSensitive ?? false,
    maxHits: options.maxHits,
  });
}

export async function listVaultFiles(
  vaultPath: string,
  extensions: string[] = [...STELA_EXTENSIONS],
): Promise<string[]> {
  return window.stela.search.listFiles(vaultPath, extensions);
}
