import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { loadSkills, type Skill } from "@earendil-works/pi-agent-core";

import { AppError } from "@shared/errors";
import { parseFrontmatterField, splitFrontmatter } from "@shared/frontmatter";
import type { AgentSkillListItem } from "@shared/types";

import * as vaultFs from "../vault-fs";
import { notifyFileChanged } from "../vault-watcher";

export const AGENT_SKILLS_DIR = ".stela/skills";
export const AGENT_SKILL_CATEGORIES = [
  "sql-dialect",
  "metric-definition",
  "business-glossary",
  "data-lineage",
  "analysis-runbook",
] as const;
export const AGENT_SKILL_LIMITS = {
  maxChars: 6_000,
  maxDescriptionChars: 160,
  maxBodyLines: 80,
  maxCodeBlocks: 2,
  maxCodeLines: 20,
} as const;
export const MAX_AGENT_SKILL_CHARS = AGENT_SKILL_LIMITS.maxChars;
export const AGENT_SKILL_LIMITS_PROMPT =
  `Skill limits: full file <= ${AGENT_SKILL_LIMITS.maxChars} characters; description <= ${AGENT_SKILL_LIMITS.maxDescriptionChars} characters; body <= ${AGENT_SKILL_LIMITS.maxBodyLines} lines; at most ${AGENT_SKILL_LIMITS.maxCodeBlocks} code examples, each <= ${AGENT_SKILL_LIMITS.maxCodeLines} lines.`;

export type AgentSkillCategory = (typeof AGENT_SKILL_CATEGORIES)[number];

export interface AgentSkillMetadata {
  name: string;
  description: string;
  category: AgentSkillCategory | null;
  tags: string[];
  sources: AgentSkillSource[];
  sourceTables: string[];
  relativePath: string;
}

export interface AgentSkillSource {
  path: string;
  sha256: string;
}

export interface LoadedAgentSkills {
  loaded: LoadedAgentSkill[];
  rejected: Array<{ relativePath: string; reason: string }>;
}

export interface LoadedAgentSkill {
  skill: Skill;
  metadata: AgentSkillMetadata;
  /** Validated full SKILL.md, including Stela frontmatter extensions. */
  content: string;
}

export interface AgentSkillMaintenanceRecord {
  action: "saved" | "archived";
  name: string;
  category: AgentSkillCategory | null;
  path: string;
  reason: string;
}

const DIALECT_TAG_ALIASES: Record<string, string> = {
  postgres: "postgresql",
  postgresql: "postgresql",
  mysql: "mysql",
  starrocks: "starrocks",
  clickhouse: "clickhouse",
  sqlite: "sqlite",
  trino: "trino",
  bigquery: "bigquery",
  snowflake: "snowflake",
};

function toPosixPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function normalizeFileInfo<T extends { name: string; path: string }>(entry: T): T {
  const normalizedPath = toPosixPath(entry.path);
  return { ...entry, name: path.posix.basename(normalizedPath), path: normalizedPath };
}

class SkillExecutionEnv extends NodeExecutionEnv {
  override async fileInfo(filePath: string) {
    const result = await super.fileInfo(filePath);
    return result.ok ? { ...result, value: normalizeFileInfo(result.value) } : result;
  }

  override async listDir(dirPath: string) {
    const result = await super.listDir(dirPath);
    return result.ok
      ? {
          ...result,
          value: result.value.map(normalizeFileInfo),
        }
      : result;
  }

  override async canonicalPath(filePath: string) {
    const result = await super.canonicalPath(filePath);
    return result.ok ? { ...result, value: toPosixPath(result.value) } : result;
  }
}

function skillEnv(vaultPath: string): SkillExecutionEnv {
  return new SkillExecutionEnv({ cwd: vaultPath });
}

function skillDir(vaultPath: string): string {
  return path.join(vaultPath, AGENT_SKILLS_DIR);
}

function parseTags(value: string | null): string[] {
  if (!value) return [];
  const inner = value.trim().replace(/^\[/, "").replace(/\]$/, "");
  return Array.from(
    new Set(
      inner
        .split(",")
        .map((tag) => tag.trim().replace(/^["']|["']$/g, "").toLowerCase())
        .filter((tag) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(tag)),
    ),
  );
}

function parseJsonArray(value: string | null): unknown[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseSources(value: string | null): AgentSkillSource[] {
  return parseJsonArray(value).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    return typeof record.path === "string" &&
      record.path.endsWith(".md") &&
      !path.isAbsolute(record.path) &&
      !record.path.split(/[\\/]/).some((part) => !part || part === ".." || part.startsWith(".")) &&
      /^[a-f0-9]{64}$/.test(String(record.sha256))
      ? [{ path: toPosixPath(record.path), sha256: String(record.sha256) }]
      : [];
  });
}

function parseSourceTables(value: string | null): string[] {
  return parseJsonArray(value)
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => /^[a-z0-9_]+(?:\.[a-z0-9_]+)?$/.test(item));
}

export function skillSourceSha256(content: string): string {
  return createHash("sha256").update(content.replace(/\r\n/g, "\n")).digest("hex");
}

function injectSourceFrontmatter(
  content: string,
  sources: AgentSkillSource[],
  sourceTables: string[],
): string {
  const normalized = content.replace(/\r\n/g, "\n");
  const marker = normalized.indexOf("\n---", 4);
  if (marker < 0) return normalized;
  const head = normalized.slice(0, marker)
    .replace(/\n(?:sources|source_tables):[^\n]*/g, "");
  const fields = [
    sources.length > 0 ? `sources: ${JSON.stringify(sources)}` : "",
    sourceTables.length > 0 ? `source_tables: ${JSON.stringify(sourceTables)}` : "",
  ].filter(Boolean).join("\n");
  return `${head}${fields ? `\n${fields}` : ""}${normalized.slice(marker)}`;
}

const TEMPLATE_HEADINGS: Record<AgentSkillCategory, string[]> = {
  "sql-dialect": ["scope", "rule", "valid pattern", "verify"],
  "metric-definition": ["scope", "definition", "grain & filters", "verify"],
  "business-glossary": ["scope", "term mapping", "rule", "verify"],
  "data-lineage": ["scope", "source → transform → target", "keys & grain", "verify"],
  "analysis-runbook": ["scope / trigger", "preconditions", "ordered checks", "decision → action", "stop conditions", "verify"],
};

function assertTemplateShape(category: AgentSkillCategory, body: string): void {
  const headings = new Set(
    Array.from(body.matchAll(/^#{2,6}\s+(.+)$/gm), (match) => match[1]!.trim().toLowerCase()),
  );
  const missing = TEMPLATE_HEADINGS[category].filter((heading) => !headings.has(heading));
  if (missing.length > 0) {
    throw new AppError("invalid_skill", `Template for ${category} is missing headings: ${missing.join(", ")}.`);
  }
  if (category === "analysis-runbook") {
    const ordered = body.match(/## Ordered Checks\s+([\s\S]*?)(?=\n## |$)/i)?.[1] ?? "";
    const decisions = body.match(/## Decision → Action\s+([\s\S]*?)(?=\n## |$)/i)?.[1] ?? "";
    if ((ordered.match(/^\s*(?:[-*]|\d+\.)\s+/gm) ?? []).length < 2 || !/(?:\b(?:if|when)\b|如果|若|当)/i.test(decisions)) {
      throw new AppError("invalid_skill", "analysis-runbook requires at least two ordered checks and an evidence-based decision branch.");
    }
  }
}

async function metadataForSkill(skill: Skill, vaultPath: string): Promise<AgentSkillMetadata> {
  // pi-agent-core intentionally exposes the Markdown body as `skill.content`;
  // Stela's category/tags stay in the source file frontmatter.
  const raw = await fs.readFile(skill.filePath, "utf-8").catch(() => skill.content);
  const metadata = validateSkillContent(skill.name, raw);
  return {
    ...metadata,
    relativePath: path.relative(vaultPath, skill.filePath).split(path.sep).join("/"),
  };
}

function normalizeQuery(value: string): string[] {
  return Array.from(new Set(value.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []));
}

function scoreSkill(skill: LoadedAgentSkill, terms: string[]): number {
  const haystack = [
    skill.metadata.name,
    skill.metadata.description,
    skill.metadata.category ?? "",
    ...skill.metadata.tags,
  ].join(" ").toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

export function rankAgentSkills(skills: LoadedAgentSkill[], query: string, limit: number): LoadedAgentSkill[] {
  const terms = normalizeQuery(query);
  return [...skills]
    .map((skill) => ({ skill, score: scoreSkill(skill, terms) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.skill.metadata.name.localeCompare(b.skill.metadata.name))
    .slice(0, limit)
    .map(({ skill }) => skill);
}

function assertSkillName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(normalized)) {
    throw new AppError("invalid_skill", "Skill name must use lowercase letters, numbers, and hyphens.");
  }
  return normalized;
}

function validateSkillContent(name: string, content: string): AgentSkillMetadata {
  if (content.length > MAX_AGENT_SKILL_CHARS) {
    throw new AppError("invalid_skill", `Skill content must not exceed ${MAX_AGENT_SKILL_CHARS} characters.`);
  }
  const { frontmatter, body } = splitFrontmatter(content);
  const description = parseFrontmatterField(frontmatter, "description");
  const frontmatterName = parseFrontmatterField(frontmatter, "name");
  const category = parseFrontmatterField(frontmatter, "category");
  const tags = parseTags(parseFrontmatterField(frontmatter, "tags"));
  const rawSources = parseFrontmatterField(frontmatter, "sources");
  const rawSourceTables = parseFrontmatterField(frontmatter, "source_tables");
  const sources = parseSources(rawSources);
  const sourceTables = parseSourceTables(rawSourceTables);
  if (!frontmatter || !description) throw new AppError("invalid_skill", "SKILL.md requires a non-empty description.");
  if (!body.trim()) throw new AppError("invalid_skill", "Skill body must contain reusable guidance.");
  if (description.length > AGENT_SKILL_LIMITS.maxDescriptionChars) {
    throw new AppError("invalid_skill", `Skill description must be ${AGENT_SKILL_LIMITS.maxDescriptionChars} characters or fewer.`);
  }
  if (body.trim().split("\n").length > AGENT_SKILL_LIMITS.maxBodyLines) {
    throw new AppError("invalid_skill", `Skill body must be ${AGENT_SKILL_LIMITS.maxBodyLines} lines or fewer; keep only reusable rules and checks.`);
  }
  const codeBlocks = Array.from(
    body.matchAll(/^```[^\n]*\n([\s\S]*?)^```$/gm) as Iterable<RegExpMatchArray>,
    (match) => match[1] ?? "",
  );
  if (codeBlocks.length > AGENT_SKILL_LIMITS.maxCodeBlocks) {
    throw new AppError("invalid_skill", `Skill body may contain at most ${AGENT_SKILL_LIMITS.maxCodeBlocks} short code examples.`);
  }
  if (codeBlocks.some((block) => block.trim().split("\n").length > AGENT_SKILL_LIMITS.maxCodeLines)) {
    throw new AppError("invalid_skill", `Each Skill code example must be ${AGENT_SKILL_LIMITS.maxCodeLines} lines or fewer.`);
  }
  if (frontmatterName && assertSkillName(frontmatterName) !== name) {
    throw new AppError("invalid_skill", "Frontmatter name must match the Skill directory name.");
  }
  if (!AGENT_SKILL_CATEGORIES.includes(category as AgentSkillCategory)) {
    throw new AppError("invalid_skill", `category must be one of: ${AGENT_SKILL_CATEGORIES.join(", ")}.`);
  }
  if (tags.length === 0) throw new AppError("invalid_skill", "tags must be a non-empty inline YAML list.");
  if (rawSources && (sources.length !== parseJsonArray(rawSources).length || sources.length > 3)) {
    throw new AppError("invalid_skill", "sources must contain at most three valid Vault-relative Markdown paths and SHA-256 hashes.");
  }
  if (rawSourceTables && (sourceTables.length !== parseJsonArray(rawSourceTables).length || sourceTables.length > 8)) {
    throw new AppError("invalid_skill", "source_tables must contain at most eight normalized table names.");
  }
  return {
    name,
    description,
    category: category as AgentSkillCategory,
    tags,
    sources,
    sourceTables,
    relativePath: `${AGENT_SKILLS_DIR}/${name}/SKILL.md`,
  };
}

async function atomicWrite(target: string, content: string): Promise<void> {
  const temp = path.join(path.dirname(target), `.SKILL.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(temp, content, "utf-8");
  await fs.rename(temp, target);
}

export async function loadAgentSkills(vaultPath: string): Promise<LoadedAgentSkills> {
  const result = await loadSkills(skillEnv(vaultPath), skillDir(vaultPath));
  const checked = await Promise.all(
    result.skills.map(async (skill) => {
      try {
        const content = await fs.readFile(skill.filePath, "utf-8").catch(() => skill.content);
        return { skill, metadata: await metadataForSkill(skill, vaultPath), content };
      } catch (err) {
        return {
          rejected: {
            relativePath: path.relative(vaultPath, skill.filePath).split(path.sep).join("/"),
            reason: err instanceof Error ? err.message : String(err),
          },
        };
      }
    }),
  );
  return {
    loaded: checked.filter((item): item is LoadedAgentSkill => "skill" in item),
    rejected: checked
      .filter((item): item is { rejected: { relativePath: string; reason: string } } => "rejected" in item)
      .map((item) => item.rejected),
  };
}

export async function listAgentSkills(vaultPath: string): Promise<AgentSkillListItem[]> {
  const env = skillEnv(vaultPath);
  const [active, archived] = await Promise.all([
    loadSkills(env, skillDir(vaultPath)),
    loadSkills(env, path.join(skillDir(vaultPath), ".archive")),
  ]);
  const toListItems = async (skills: Skill[], status: AgentSkillListItem["status"]) =>
    (await Promise.all(
      skills.map(async (skill) => {
        try {
          return { ...(await metadataForSkill(skill, vaultPath)), status };
        } catch {
          return null;
        }
      }),
    )).filter((item): item is AgentSkillListItem => item !== null);
  return [
    ...(await toListItems(active.skills, "active")),
    ...(await toListItems(archived.skills, "archived")),
  ].sort((a, b) => a.status.localeCompare(b.status) || a.name.localeCompare(b.name));
}

export async function saveAgentSkill(
  vaultPath: string,
  name: string,
  content: string,
  reason: string,
  options: {
    overwrite?: boolean;
    dialect?: string | null;
    automatic?: boolean;
    templateDriven?: boolean;
    sourcePaths?: string[];
    sourceTables?: string[];
  } = {},
): Promise<AgentSkillMaintenanceRecord> {
  const skillName = assertSkillName(name);
  const initialMetadata = validateSkillContent(skillName, content);
  if (options.automatic && initialMetadata.category === "analysis-runbook") {
    throw new AppError("invalid_skill", "Automatic maintenance cannot create analysis-runbook Skills.");
  }
  if (options.templateDriven || initialMetadata.category === "analysis-runbook") {
    assertTemplateShape(initialMetadata.category!, splitFrontmatter(content).body);
  }
  const sourceTables = Array.from(new Set((options.sourceTables ?? [])
    .map((table) => table.trim().toLowerCase())
    .filter((table) => /^[a-z0-9_]+(?:\.[a-z0-9_]+)?$/.test(table))))
    .slice(0, 8);
  const sources: AgentSkillSource[] = [];
  for (const relativePath of Array.from(new Set(options.sourcePaths ?? [])).slice(0, 3)) {
    const normalizedPath = toPosixPath(relativePath);
    if (!normalizedPath.endsWith(".md") || normalizedPath.split("/").some((part) => part.startsWith("."))) {
      throw new AppError("invalid_skill", `Invalid Skill source path '${relativePath}'.`);
    }
    const target = await vaultFs.ensureWithinVault(vaultPath, normalizedPath);
    const raw = await fs.readFile(target, "utf-8");
    sources.push({ path: normalizedPath, sha256: skillSourceSha256(raw) });
  }
  if (options.automatic && sources.length === 0) {
    throw new AppError("invalid_skill", "Automatic maintenance requires at least one verified Vault source document.");
  }
  const finalContent = injectSourceFrontmatter(content, sources, sourceTables);
  const metadata = validateSkillContent(skillName, finalContent);
  const activeDialect = options.dialect ? DIALECT_TAG_ALIASES[options.dialect.toLowerCase()] : null;
  const mismatchedDialectTag = activeDialect
    ? metadata.tags.find((tag) => DIALECT_TAG_ALIASES[tag] && DIALECT_TAG_ALIASES[tag] !== activeDialect)
    : null;
  if (mismatchedDialectTag) {
    throw new AppError(
      "invalid_skill",
      `Skill tag '${mismatchedDialectTag}' does not match active SQL dialect '${activeDialect}'.`,
    );
  }
  const targetDir = await vaultFs.ensureWithinVault(vaultPath, path.join(skillDir(vaultPath), skillName));
  const target = await vaultFs.ensureWithinVault(vaultPath, path.join(targetDir, "SKILL.md"));
  if (options.overwrite === false && await vaultFs.pathExists(target)) {
    throw new AppError("invalid_skill", `Automatic maintenance cannot overwrite existing Skill '${skillName}'.`);
  }
  await fs.mkdir(targetDir, { recursive: true });
  await atomicWrite(target, finalContent);
  if ((await vaultFs.readFile(target)).replace(/\r\n/g, "\n") !== finalContent) {
    throw new AppError("write_failed", `Write verification failed for ${metadata.relativePath}.`);
  }
  notifyFileChanged(target);
  return {
    action: "saved",
    name: skillName,
    category: metadata.category,
    path: metadata.relativePath,
    reason: reason.trim().slice(0, 240),
  };
}

export async function archiveAgentSkill(
  vaultPath: string,
  name: string,
  reason: string,
): Promise<AgentSkillMaintenanceRecord> {
  const skillName = assertSkillName(name);
  const source = await vaultFs.ensureWithinVault(vaultPath, path.join(skillDir(vaultPath), skillName));
  const skillFile = path.join(source, "SKILL.md");
  if (!(await vaultFs.pathExists(skillFile))) {
    throw new AppError("not_found", `Skill '${skillName}' does not exist.`);
  }
  const metadata = validateSkillContent(skillName, await fs.readFile(skillFile, "utf-8"));
  const archiveDir = await vaultFs.ensureWithinVault(
    vaultPath,
    path.join(skillDir(vaultPath), ".archive", `${skillName}-${Date.now()}`),
  );
  await fs.mkdir(path.dirname(archiveDir), { recursive: true });
  await fs.rename(source, archiveDir);
  notifyFileChanged(archiveDir);
  return {
    action: "archived",
    name: skillName,
    category: metadata.category,
    path: path.relative(vaultPath, archiveDir).split(path.sep).join("/"),
    reason: reason.trim().slice(0, 240),
  };
}

export async function removeAgentSkill(vaultPath: string, relativePath: string): Promise<void> {
  const target = await vaultFs.ensureWithinVault(vaultPath, relativePath);
  const segments = path.relative(skillDir(vaultPath), target).split(path.sep);
  const isActiveSkill = segments.length === 2;
  const isArchivedSkill = segments.length === 3 && segments[0] === ".archive";
  if (
    (!isActiveSkill && !isArchivedSkill) ||
    segments.at(-1) !== "SKILL.md" ||
    segments.some((segment) => segment.length === 0 || segment === "..")
  ) {
    throw new AppError("invalid_skill", "Only a vault Skill directory can be deleted.");
  }
  await vaultFs.deletePath(vaultPath, path.dirname(target));
}
