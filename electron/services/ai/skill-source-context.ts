import fs from "node:fs/promises";
import path from "node:path";

import type { SqlIndexFilter, SqlIndexHit } from "@shared/types";

import { redactForPrompt } from "./redaction";
import { skillSourceSha256, type LoadedAgentSkill } from "./agent-skills";

export interface SkillSourceNote {
  path: string;
  updatedAt: string;
  sha256: string;
  content: string;
}

export type SkillSourceQuery = (filter: SqlIndexFilter) => Promise<SqlIndexHit[]>;

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
): Promise<SkillSourceNote[]> {
  const hits = (await Promise.all(
    Array.from(new Set(tables)).slice(0, 8).flatMap((table) => [
      query({ readTable: table, maxHits: 60 }),
      query({ writeTable: table, maxHits: 60 }),
    ]),
  )).flat();
  const paths = Array.from(new Set(hits.map((hit) => hit.relPath)));
  const candidates = await Promise.all(paths.map(async (relativePath) => {
    const absolutePath = path.join(vaultPath, relativePath);
    try {
      const [stat, raw] = await Promise.all([fs.stat(absolutePath), fs.readFile(absolutePath, "utf-8")]);
      return {
        path: relativePath.split(path.sep).join("/"),
        updatedAt: stat.mtime.toISOString(),
        sha256: skillSourceSha256(raw),
        content: sanitizeDocument(raw),
      };
    } catch {
      return null;
    }
  }));
  return candidates
    .filter((item): item is SkillSourceNote => item !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.path.localeCompare(b.path))
    .slice(0, maxNotes);
}

export async function isSkillStale(
  vaultPath: string,
  skill: LoadedAgentSkill,
  query: SkillSourceQuery,
): Promise<boolean> {
  if (skill.metadata.sources.length === 0) return true;
  for (const source of skill.metadata.sources) {
    try {
      const raw = await fs.readFile(path.join(vaultPath, source.path), "utf-8");
      if (skillSourceSha256(raw) !== source.sha256) return true;
    } catch {
      return true;
    }
  }
  const tables = tablesFromSkill(skill);
  if (tables.length === 0) return false;
  const current = await collectSkillSourceNotes(vaultPath, tables, query);
  const recorded = new Set(skill.metadata.sources.map((source) => source.path));
  const currentPaths = new Set(current.map((source) => source.path));
  return currentPaths.size !== recorded.size
    || Array.from(currentPaths).some((sourcePath) => !recorded.has(sourcePath));
}
