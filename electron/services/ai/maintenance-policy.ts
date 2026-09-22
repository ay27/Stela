import type { LoadedAgentSkill } from "./agent-skills";
import { formatSkillMaintenanceEvidence, type SkillMaintenanceEvidence } from "./skill-maintenance";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { z } from "zod";
import type { Model } from "@earendil-works/pi-ai";
import { atomicWriteFile } from "../atomic-write";
import { ensureWithinVault } from "../vault-fs";
import type { SkillSourceNote } from "./skill-source-context";

export const MAINTENANCE_INPUT_CHARS = 12_000;
export const MAINTENANCE_OUTPUT_TOKENS = 2_048;
export const MAINTENANCE_COOLDOWN_MS = 60 * 60 * 1000;

/** Custom GLM gateways need an explicit disabled thinking payload, not omission. */
export function maintenanceModel(model: Model): Model {
  model = { ...model, maxTokens: Math.min(model.maxTokens, MAINTENANCE_OUTPUT_TOKENS) };
  return model.api === "openai-completions" && /^glm[-_]/i.test(model.id)
    ? { ...model, reasoning: true, compat: { ...model.compat, thinkingFormat: "zai" } }
    : model;
}

export function maintenanceHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Whole paragraphs / fenced blocks only. Oversized or unclosed blocks are omitted. */
export function maintenanceExcerpt(content: string, anchors: string[], budget: number): string {
  const lines = content.split("\n");
  const blocks: { start: number; end: number; text: string; score: number }[] = [];
  let start = 0;
  let fence: string | null = null;
  const add = (end: number) => {
    const text = lines.slice(start, end).join("\n").trim();
    if (text) blocks.push({ start: start + 1, end, text,
      score: anchors.reduce((sum, a) => sum + (text.toLowerCase().includes(a.toLowerCase()) ? 1 : 0), 0) });
    start = end;
  };
  for (let i = 0; i < lines.length; i++) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(lines[i])?.[1];
    if (marker) {
      if (!fence) { if (i > start) add(i); fence = marker; }
      else if (marker[0] === fence[0] && marker.length >= fence.length) { fence = null; add(i + 1); }
    } else if (!fence && !lines[i].trim()) add(i + 1);
  }
  if (!fence) add(lines.length);
  // Include adjacent explanatory paragraphs so a matching SQL block keeps its context.
  const matching = blocks.map((block, index) => block.score > 0 ? index : -1).filter(index => index >= 0);
  for (const index of matching) {
    for (const neighbor of [blocks[index - 1], blocks[index + 1]]) {
      if (neighbor && neighbor.score === 0) neighbor.score = 0.25;
    }
  }
  const picked: typeof blocks = [];
  let remaining = budget;
  for (const block of [...blocks].sort((a, b) => b.score - a.score || a.start - b.start)) {
    const size = block.text.length + 40;
    if (size > remaining) continue;
    if (block.score === 0 && matching.length > 0) continue;
    picked.push(block); remaining -= size;
  }
  return picked.sort((a, b) => a.start - b.start)
    .map(b => `[sanitized lines ${b.start}-${b.end}]\n${b.text}`).join("\n\n");
}

export function maintenanceNotes(notes: SkillSourceNote[], anchors: string[], budget: number): SkillSourceNote[] {
  const result: SkillSourceNote[] = [];
  let remaining = budget;
  for (const note of notes) {
    const headerSize = note.path.length + note.sha256.length + 100;
    const limit = Math.min(3500, remaining - headerSize);
    if (limit <= 0) break;
    const content = maintenanceExcerpt(note.content, anchors, limit);
    if (!content) continue;
    result.push({ ...note, content });
    remaining -= content.length + headerSize;
  }
  return result;
}

const receiptSchema = z.object({ key: z.string(), skills: z.string(), at: z.number(), outcome: z.string() });
const storeSchema = z.object({ version: z.literal(1), receipts: z.array(receiptSchema).max(256) });
type Receipt = z.infer<typeof receiptSchema>;
async function readReceipts(vault: string): Promise<Receipt[]> {
  const target = await ensureWithinVault(vault, ".stela/skill-maintenance.local.json");
  try { return storeSchema.parse(JSON.parse(await fs.readFile(target, "utf8"))).receipts; }
  catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError || (error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
export async function maintenanceSkip(vault: string, key: string, skills: string, now = Date.now()): Promise<"unchanged" | "cooldown" | null> {
  const previous = (await readReceipts(vault)).find(r => r.key === key);
  if (!previous || previous.skills !== skills) return null;
  if (previous.outcome === "saved" || previous.outcome === "no_change") return "unchanged";
  return now - previous.at < MAINTENANCE_COOLDOWN_MS ? "cooldown" : null;
}
export async function recordMaintenance(vault: string, receipt: Receipt): Promise<void> {
  const receipts = (await readReceipts(vault)).filter(r => r.key !== receipt.key);
  receipts.push(receipt);
  await atomicWriteFile(await ensureWithinVault(vault, ".stela/skill-maintenance.local.json"),
    JSON.stringify({ version: 1, receipts: receipts.slice(-256) }));
}

export function buildSkillMaintenanceInput(
  conversation: string,
  evidence: SkillMaintenanceEvidence[],
  notes: SkillSourceNote[],
  skills: LoadedAgentSkill[],
  refreshSkill?: LoadedAgentSkill,
): string {
  return [
    refreshSkill ? `Refresh only this Skill:\n${refreshSkill.content}` : "Create at most one new Skill.",
    `Current-task conversation (context, not proof):\n${conversation}`,
    "Automatic save requires claims=[{sourcePath, quote}] with exact independent excerpts. Only the cited excerpts are published; inferred prose stays a candidate. Absence claims need complete schema proof and are deferred.",
    "Observed tool evidence (success does not establish business meaning):",
    formatSkillMaintenanceEvidence(evidence) || "No tool evidence was available.",
    `Source excerpts, current-task sources first:\n${notes.map((note) =>
      `--- SOURCE ${note.path} · ${note.updatedAt} · SHA256 ${note.sha256} ---\n${note.content}`
    ).join("\n\n")}`,
    `Existing related Skill metadata:\n${skills.map((skill) =>
      `${skill.metadata.name} · ${skill.metadata.category} · ${skill.metadata.description}`
    ).join("\n") || "none"}`,
  ].join("\n\n");
}
