export interface PreparedDemoFile {
  relativePath: string;
  contents: string;
}

interface DemoVaultSeedDependencies {
  pathExists: (path: string) => Promise<boolean>;
  createDir: (vaultPath: string, path: string) => Promise<void>;
  createFile: (vaultPath: string, path: string, contents: string) => Promise<void>;
}

interface SeedPreparedDemoVaultOptions {
  parentDir: string;
  folderName: string;
  files: readonly PreparedDemoFile[];
  dependencies: DemoVaultSeedDependencies;
}

export function demoVaultPath(base: string, relativePath = ""): string {
  const separator = base.includes("\\") ? "\\" : "/";
  const cleanBase = base.replace(/[\\/]+$/, "");
  const cleanRelative = relativePath
    .replace(/^[\\/]+/, "")
    .replace(/[\\/]/g, separator);
  return cleanRelative ? `${cleanBase}${separator}${cleanRelative}` : cleanBase;
}

export async function seedPreparedDemoVault({
  parentDir,
  folderName,
  files,
  dependencies,
}: SeedPreparedDemoVaultOptions): Promise<string> {
  const target = demoVaultPath(parentDir, folderName);
  if (!(await dependencies.pathExists(target).catch(() => false))) {
    await dependencies.createDir(parentDir, target);
  }
  for (const file of files) {
    const absolutePath = demoVaultPath(target, file.relativePath);
    if (await dependencies.pathExists(absolutePath).catch(() => false)) continue;
    await dependencies.createFile(target, absolutePath, file.contents);
  }
  return target;
}
