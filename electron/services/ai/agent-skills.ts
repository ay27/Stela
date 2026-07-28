import { promises as fs } from "node:fs";
import path from "node:path";

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
  relativePath: string;
}

export interface LoadedAgentSkills {
  loaded: LoadedAgentSkill[];
}

export interface LoadedAgentSkill {
  skill: Skill;
  metadata: AgentSkillMetadata;
}

export interface AgentSkillMaintenanceRecord {
  action: "saved" | "archived";
  name: string;
  path: string;
  reason: string;
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

async function metadataForSkill(skill: Skill, vaultPath: string): Promise<AgentSkillMetadata> {
  // pi-agent-core intentionally exposes the Markdown body as `skill.content`;
  // Stela's category/tags stay in the source file frontmatter.
  const raw = await fs.readFile(skill.filePath, "utf-8").catch(() => skill.content);
  const { frontmatter } = splitFrontmatter(raw);
  const category = parseFrontmatterField(frontmatter, "category") as AgentSkillCategory | null;
  return {
    name: skill.name,
    description: skill.description,
    category: AGENT_SKILL_CATEGORIES.includes(category ?? "" as AgentSkillCategory) ? category : null,
    tags: parseTags(parseFrontmatterField(frontmatter, "tags")),
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
  return {
    name,
    description,
    category: category as AgentSkillCategory,
    tags,
    relativePath: `${AGENT_SKILLS_DIR}/${name}/SKILL.md`,
  };
}

async function atomicWrite(target: string, content: string): Promise<void> {
  const temp = path.join(path.dirname(target), `.SKILL.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(temp, content, "utf-8");
  await fs.rename(temp, target);
}

export async function loadAgentSkills(vaultPath: string): Promise<LoadedAgentSkills> {
  const result = await loadSkills(new NodeExecutionEnv({ cwd: vaultPath }), skillDir(vaultPath));
  return {
    loaded: await Promise.all(
      result.skills.map(async (skill) => ({
        skill,
        metadata: await metadataForSkill(skill, vaultPath),
      })),
    ),
  };
}

export async function listAgentSkills(vaultPath: string): Promise<AgentSkillListItem[]> {
  const env = new NodeExecutionEnv({ cwd: vaultPath });
  const [active, archived] = await Promise.all([
    loadSkills(env, skillDir(vaultPath)),
    loadSkills(env, path.join(skillDir(vaultPath), ".archive")),
  ]);
  const toListItems = async (skills: Skill[], status: AgentSkillListItem["status"]) =>
    Promise.all(
      skills.map(async (skill) => ({
        ...(await metadataForSkill(skill, vaultPath)),
        status,
      })),
    );
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
): Promise<AgentSkillMaintenanceRecord> {
  const skillName = assertSkillName(name);
  const metadata = validateSkillContent(skillName, content);
  const targetDir = await vaultFs.ensureWithinVault(vaultPath, path.join(skillDir(vaultPath), skillName));
  const target = await vaultFs.ensureWithinVault(vaultPath, path.join(targetDir, "SKILL.md"));
  await fs.mkdir(targetDir, { recursive: true });
  await atomicWrite(target, content.replace(/\r\n/g, "\n"));
  if ((await vaultFs.readFile(target)).replace(/\r\n/g, "\n") !== content.replace(/\r\n/g, "\n")) {
    throw new AppError("write_failed", `Write verification failed for ${metadata.relativePath}.`);
  }
  notifyFileChanged(target);
  return { action: "saved", name: skillName, path: metadata.relativePath, reason: reason.trim().slice(0, 240) };
}

export async function archiveAgentSkill(
  vaultPath: string,
  name: string,
  reason: string,
): Promise<AgentSkillMaintenanceRecord> {
  const skillName = assertSkillName(name);
  const source = await vaultFs.ensureWithinVault(vaultPath, path.join(skillDir(vaultPath), skillName));
  if (!(await vaultFs.pathExists(path.join(source, "SKILL.md")))) {
    throw new AppError("not_found", `Skill '${skillName}' does not exist.`);
  }
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

