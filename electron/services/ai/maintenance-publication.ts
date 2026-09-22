import { z } from "zod";
import type { SkillSourceNote } from "./skill-source-context";

export const maintenanceClaimsSchema = z.array(z.object({
  sourcePath: z.string().min(1).max(512),
  quote: z.string().min(12).max(700),
}).strict()).min(1).max(4);

/** Automatic publication is extractive: model inferences cannot hitchhike on a file hash. */
export function reviewMaintenancePublication(name: string, claims: unknown, notes: SkillSourceNote[], observedColumns: string[] = []):
  { ok: true; content: string; sourcePaths: string[] } | { ok: false; reasons: string[] } {
  const parsed = maintenanceClaimsSchema.safeParse(claims);
  if (!parsed.success) return { ok: false, reasons: ["missing_source_claims: provide 1-4 exact independent source excerpts, not inferred rules"] };
  const reasons: string[] = [];
  for (const claim of parsed.data) {
    const note = notes.find(note => note.path === claim.sourcePath);
    if (!note || !note.content.includes(claim.quote)) reasons.push(`unsupported_excerpt: ${claim.sourcePath}`);
    // Absence claims require a complete schema, not a sample or prose. Defer them.
    if (/不存在|没有.*(?:字段|列)|无.*字段|\b(?:no|missing|absent|without|not have|does not exist)\b/i.test(claim.quote)) {
      reasons.push("absence_claim_requires_complete_schema");
      if (observedColumns.some(column => claim.quote.toLowerCase().includes(column.toLowerCase()))) reasons.push("possible_conflict_with_observed_column");
    }
  }
  if (new Set(parsed.data.map(claim => claim.sourcePath)).size > 3) reasons.push("too_many_sources");
  if (reasons.length) return { ok: false, reasons: [...new Set(reasons)] };
  // The model's proposed description/body is deliberately not published: it is not grounded by these excerpts.
  const content = `---\nname: ${name}\ndescription: Source excerpts for scoped data definitions; recheck applicability before use.\ncategory: business-glossary\ntags: [source-excerpts]\n---\n\n## Scope\nIndependent source excerpts; not verified cross-stage population mappings.\n## Term Mapping\n` +
    parsed.data.map(claim => `Source: ${claim.sourcePath}\n${claim.quote.split("\n").map(line => `> ${line}`).join("\n")}`).join("\n") +
    "\n## Rule\nApply only within the cited source scope. Do not infer absent columns or stage conversion from these excerpts.\n## Verify\nRecheck current schema, population, keys and stage relationships before comparing results.\n";
  return { ok: true, content, sourcePaths: [...new Set(parsed.data.map(claim => claim.sourcePath))] };
}
