import fs from "node:fs/promises";
import path from "node:path";

import type { SqlIndexFilter, SqlIndexHit } from "@shared/types";

import { ensureWithinVault } from "../vault-fs";
import { redactForPrompt } from "./redaction";
import { skillSourceSha256, type LoadedAgentSkill } from "./agent-skills";

export interface SkillSourceNote {
  path: string;
  updatedAt: string;
  sha256: string;
  content: string;
}

export type SkillSourceQuery = (filter: SqlIndexFilter) => Promise<SqlIndexHit[]>;
export type AgentSkillFreshness = "fresh" | "stale" | "untracked";

export function tablesFromSkill(skill: LoadedAgentSkill): string[] {
  if (skill.metadata.sourceTables.length > 0) return skill.metadata.sourceTables;
  return Array.from(new Set(
    (skill.content.match(/\b[a-zA-Z_][\w]*\.[a-zA-Z_][\w]*\b/g) ?? [])
      .map((table) => table.toLowerCase()),
  )).slice(0, 8);
}

function sanitizeDocument(content: string): string {
  return redactForPrompt(content)
    .replace(/<first-row>[\s\S]*?<\/first-row>/gi, "<first-row>***redacted***</first-row>")
    .replace(/<result-ref-id>[\s\S]*?<\/result-ref-id>/gi, "<result-ref-id>***redacted***</result-ref-id>");
}

export async function collectSkillSourceNotes(
  vaultPath: string,
  tables: string[],
  query: SkillSourceQuery,
  maxNotes = 3,
  preferredPaths: string[] = [],
): Promise<SkillSourceNote[]> {
  const hits = (await Promise.all(
    Array.from(new Set(tables)).slice(0, 8).flatMap((table) => [
      query({ readTable: table, maxHits: 60 }),
      query({ writeTable: table, maxHits: 60 }),
    ]),
  )).flat();
  const preferred = new Set(preferredPaths.filter(p => p.endsWith(".md")).map(p => path.isAbsolute(p) ? path.relative(vaultPath, p).split(path.sep).join("/") : p));
  const paths = Array.from(new Set([...preferred, ...hits.map((hit) => hit.relPath)])).slice(0, 120);
  const candidates = await Promise.all(paths.map(async (relativePath) => {
    try {
      const absolutePath = await ensureWithinVault(vaultPath, relativePath);
      const stat = await fs.stat(absolutePath);
      if (!stat.isFile()) return null;
      return { path: relativePath.split(path.sep).join("/"), updatedAt: stat.mtime.toISOString() };
    } catch { return null; }
  }));
  const selected = candidates.filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => Number(preferred.has(b.path)) - Number(preferred.has(a.path)) || b.updatedAt.localeCompare(a.updatedAt) || a.path.localeCompare(b.path))
    .slice(0, maxNotes);
  const notes = await Promise.all(selected.map(async note => {
    try {
      const raw = await fs.readFile(await ensureWithinVault(vaultPath, note.path), "utf-8");
      return { ...note, sha256: skillSourceSha256(raw), content: sanitizeDocument(raw) };
    } catch { return null; }
  }));
  return notes.filter((note): note is SkillSourceNote => note !== null);

}

export async function getSkillFreshness(
  vaultPath: string,
  skill: LoadedAgentSkill,
  query: SkillSourceQuery,
): Promise<AgentSkillFreshness> {
  if (skill.metadata.origin === "system") return "fresh";
  if (skill.metadata.sources.length === 0) return "untracked";
  for (const source of skill.metadata.sources) {
    try {
      const raw = await fs.readFile(path.join(vaultPath, source.path), "utf-8");
      if (skillSourceSha256(raw) !== source.sha256) return "stale";
    } catch {
      return "stale";
    }
  }
  const tables = tablesFromSkill(skill);
  if (tables.length === 0) return "fresh";
  const current = await collectSkillSourceNotes(vaultPath, tables, query, 3, skill.metadata.sources.map(source => source.path));
  const recorded = new Set(skill.metadata.sources.map((source) => source.path));
  const currentPaths = new Set(current.map((source) => source.path));
  const sourceSetChanged = currentPaths.size !== recorded.size
    || Array.from(currentPaths).some((sourcePath) => !recorded.has(sourcePath));
  return sourceSetChanged ? "stale" : "fresh";
}

export async function isSkillStale(
  vaultPath: string,
  skill: LoadedAgentSkill,
  query: SkillSourceQuery,
): Promise<boolean> {
  return await getSkillFreshness(vaultPath, skill, query) === "stale";
}
