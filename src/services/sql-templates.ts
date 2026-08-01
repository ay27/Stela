import {
  createDir,
  createFile,
  deletePath,
  listDir,
  pathExists,
  readFile,
  type FileNode,
} from "@/services/fs";
import { parseFrontmatterField, splitFrontmatter } from "@/core/markdown";

export const SQL_TEMPLATE_DIRECTORY = ".stela/sql-templates";
export const SQL_TEMPLATE_TYPE = "stela-sql-template";

export interface SqlTemplateMetadata {
  name: string;
  description: string;
}

export interface SqlTemplate extends SqlTemplateMetadata {
  relativePath: string;
  absolutePath: string;
  connectionName: string | null;
  sql: string;
}

function joinPath(left: string, right: string): string {
  return `${left.replace(/\/+$/, "")}/${right.replace(/^\/+/, "")}`;
}

function firstRunsqlBlock(body: string): string | null {
  const match = /^```runsql[^\n]*\n([\s\S]*?)^```[ \t]*$/m.exec(body);
  const sql = match?.[1]?.trim();
  return sql ? sql : null;
}

export function validateTemplateMetadata(
  name: string,
  description: string,
): string | null {
  if (!name.trim()) return "模板名称不能为空";
  if (/[\r\n]/.test(name) || /[\r\n]/.test(description)) {
    return "模板名称和描述必须为单行文本";
  }
  return null;
}

export function templateSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "template";
}

export function getSqlTemplateDirectory(vaultPath: string): string {
  return joinPath(vaultPath, SQL_TEMPLATE_DIRECTORY);
}

export function isSqlTemplatePath(path: string, vaultPath?: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  const directory = vaultPath
    ? getSqlTemplateDirectory(vaultPath).replace(/\\/g, "/")
    : SQL_TEMPLATE_DIRECTORY;
  return (
    normalized.startsWith(`${directory}/`) &&
    normalized.endsWith(".md")
  );
}

export function createSqlTemplateDocument(metadata: SqlTemplateMetadata): string {
  const error = validateTemplateMetadata(metadata.name, metadata.description);
  if (error) throw new Error(error);
  return `---\ntype: ${SQL_TEMPLATE_TYPE}\nname: ${metadata.name.trim()}\ndescription: ${metadata.description.trim()}\nconnection_name: ""\n---\n\n\`\`\`runsql\nSELECT *\nFROM {{table}}\nLIMIT {{limit}}\n\`\`\`\n`;
}

export function parseSqlTemplate(
  raw: string,
  relativePath: string,
  absolutePath = relativePath,
): SqlTemplate | null {
  const { frontmatter, body } = splitFrontmatter(raw);
  if (parseFrontmatterField(frontmatter, "type") !== SQL_TEMPLATE_TYPE) {
    return null;
  }
  const name = parseFrontmatterField(frontmatter, "name");
  const description = parseFrontmatterField(frontmatter, "description") ?? "";
  const sql = firstRunsqlBlock(body);
  if (!name || !sql || validateTemplateMetadata(name, description)) return null;
  return {
    name,
    description,
    relativePath,
    absolutePath,
    connectionName: parseFrontmatterField(frontmatter, "connection_name"),
    sql,
  };
}

async function nextTemplatePath(
  vaultPath: string,
  name: string,
): Promise<{ relativePath: string; absolutePath: string }> {
  const directory = getSqlTemplateDirectory(vaultPath);
  const entries = await listDir(directory).catch((): FileNode[] => []);
  const occupied = new Set(entries.filter((entry) => !entry.isDir).map((entry) => entry.name));
  const base = templateSlug(name);
  let number = 0;
  let fileName = `${base}.md`;
  while (occupied.has(fileName)) {
    number += 1;
    fileName = `${base}-${number}.md`;
  }
  return {
    relativePath: `${SQL_TEMPLATE_DIRECTORY}/${fileName}`,
    absolutePath: joinPath(directory, fileName),
  };
}

export async function listSqlTemplates(vaultPath: string): Promise<SqlTemplate[]> {
  const directory = getSqlTemplateDirectory(vaultPath);
  if (!(await pathExists(directory))) return [];
  const entries = await listDir(directory);
  const parsed = await Promise.all(
    entries
      .filter((entry) => !entry.isDir && entry.name.endsWith(".md"))
      .map(async (entry) =>
        parseSqlTemplate(
          await readFile(entry.path),
          `${SQL_TEMPLATE_DIRECTORY}/${entry.name}`,
          entry.path,
        ),
      ),
  );
  return parsed
    .filter((item): item is SqlTemplate => item !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function createSqlTemplate(
  vaultPath: string,
  metadata: SqlTemplateMetadata,
): Promise<SqlTemplate> {
  const contents = createSqlTemplateDocument(metadata);
  const directory = getSqlTemplateDirectory(vaultPath);
  if (!(await pathExists(directory))) {
    await createDir(vaultPath, directory);
  }
  const { relativePath, absolutePath } = await nextTemplatePath(vaultPath, metadata.name);
  await createFile(vaultPath, absolutePath, contents);
  const template = parseSqlTemplate(contents, relativePath, absolutePath);
  if (!template) throw new Error("无法创建模板");
  return template;
}

export async function removeSqlTemplate(
  vaultPath: string,
  template: SqlTemplate,
): Promise<void> {
  if (!isSqlTemplatePath(template.absolutePath, vaultPath)) {
    throw new Error("模板路径无效");
  }
  await deletePath(vaultPath, template.absolutePath);
}
