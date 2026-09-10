import { z } from "zod";

const count = z.number().int().nonnegative();
/** Bounded observations for tools/history/UI; never an answer-authority token. */
export const analysisSnapshotSchema = z.object({
  runId: z.string().max(256),
  version: count,
  generation: z.string().max(128),
  status: z.enum(["observed", "partial_mutation_possible", "lost"]),
  missingClaims: z.array(z.string().max(128)).max(6),
  failedChecks: z.array(z.string().max(128)).max(20),
  claims: z.array(z.object({ field: z.string().max(128), value: z.string().max(500),
    source: z.string().max(256), evidence: z.string().max(500), sourceResolved: z.boolean() }).strict()).max(6),
  checks: z.array(z.object({ name: z.string().max(128), passed: z.boolean(), sourceResolved: z.boolean() }).strict()).max(20),
  sources: z.array(z.object({ ref: z.string().max(256), rowCount: count, incomplete: z.boolean(), previewTruncated: z.boolean().optional() }).strict()).max(16),
  coverage: z.object({ state: z.enum(["full", "subset", "unknown"]), total: count.nullable(),
    processed: count, unresolved: count, unprocessed: count, source: z.string().max(256).nullable() }).strict(),
  previousVersions: count,
  truncated: z.boolean(),
}).strict();
export type IAnalysisSnapshot = z.infer<typeof analysisSnapshotSchema>;

export function readAnalysisSnapshot(text: string | undefined): IAnalysisSnapshot | null {
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || !("analysis" in parsed)) return null;
    const result = analysisSnapshotSchema.safeParse(parsed.analysis);
    return result.success ? result.data : null;
  } catch { return null; }
}

/** Preserve machine-readable evidence through the normal short timeline summary. */
export function analysisToolSummary(text: string, limit: number): string {
  const analysis = readAnalysisSnapshot(text);
  return analysis ? JSON.stringify({ analysis, preview: text.slice(0, limit) }) : text.slice(0, limit);
}
