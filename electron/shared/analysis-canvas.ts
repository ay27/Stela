import { z } from "zod";

import { stelaChartConfigSchema } from "./chart-spec";

export const ANALYSIS_CANVAS_EXTENSION = ".stela.canvas";
export const ANALYSIS_CANVAS_VERSION = 1 as const;

const id = z.string().trim().regex(/^[A-Za-z0-9_-]{1,128}$/);
const width = z.enum(["full", "half", "third"]).default("full");

export const analysisCanvasSourceSchema = z.object({
  id,
  title: z.string().trim().min(1).max(200),
  connectionName: z.string().trim().min(1).max(200),
  sql: z.string().trim().min(1).max(200_000),
  lastRunId: z.string().min(1).max(256).nullable().default(null),
  lastRunAt: z.number().int().nonnegative().nullable().default(null),
  lastError: z.object({ message: z.string().max(2_000), attemptedAt: z.number().int().nonnegative() }).strict().nullable().default(null),
}).strict();

const cardBase = { id, title: z.string().trim().max(200).optional(), width };
export const analysisCanvasCardSchema = z.discriminatedUnion("type", [
  z.object({ ...cardBase, type: z.literal("markdown"), markdown: z.string().max(100_000) }).strict(),
  z.object({ ...cardBase, type: z.literal("kpi"), sourceId: id, value: z.string().min(1).max(256), label: z.string().max(256).optional(), prefix: z.string().max(32).optional(), suffix: z.string().max(32).optional() }).strict(),
  z.object({ ...cardBase, type: z.literal("chart"), sourceId: id, chart: stelaChartConfigSchema }).strict(),
  z.object({ ...cardBase, type: z.literal("table"), sourceId: id, columns: z.array(z.string().min(1).max(256)).max(100).optional(), maxRows: z.number().int().min(1).max(500).default(50) }).strict(),
]);

export const analysisCanvasSectionSchema = z.object({
  id,
  title: z.string().trim().min(1).max(200),
  description: z.string().max(1_000).optional(),
  cards: z.array(analysisCanvasCardSchema).max(200),
}).strict();

export const analysisCanvasSchema = z.object({
  kind: z.literal("stela-analysis-canvas"),
  version: z.literal(ANALYSIS_CANVAS_VERSION),
  id,
  title: z.string().trim().min(1).max(200),
  status: z.enum(["working", "complete", "error"]).default("working"),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  createdBySessionId: z.string().max(256).nullable().default(null),
  sources: z.array(analysisCanvasSourceSchema).max(100),
  sections: z.array(analysisCanvasSectionSchema).max(100),
}).strict().superRefine((canvas, ctx) => {
  const sourceIds = new Set<string>();
  for (const [index, source] of canvas.sources.entries()) {
    if (sourceIds.has(source.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sources", index, "id"], message: "Duplicate source id." });
    sourceIds.add(source.id);
  }
  const sectionIds = new Set<string>();
  const cardIds = new Set<string>();
  for (const [sectionIndex, section] of canvas.sections.entries()) {
    if (sectionIds.has(section.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sections", sectionIndex, "id"], message: "Duplicate section id." });
    sectionIds.add(section.id);
    for (const [cardIndex, card] of section.cards.entries()) {
      if (cardIds.has(card.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sections", sectionIndex, "cards", cardIndex, "id"], message: "Duplicate card id." });
      cardIds.add(card.id);
      if (card.type !== "markdown" && !sourceIds.has(card.sourceId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sections", sectionIndex, "cards", cardIndex, "sourceId"], message: "Unknown source id." });
    }
  }
});

export type AnalysisCanvas = z.infer<typeof analysisCanvasSchema>;
export type AnalysisCanvasSource = z.infer<typeof analysisCanvasSourceSchema>;
export type AnalysisCanvasCard = z.infer<typeof analysisCanvasCardSchema>;
export type AnalysisCanvasSection = z.infer<typeof analysisCanvasSectionSchema>;

export function parseAnalysisCanvas(raw: string): AnalysisCanvas {
  return analysisCanvasSchema.parse(JSON.parse(raw));
}

export function stringifyAnalysisCanvas(canvas: AnalysisCanvas): string {
  return `${JSON.stringify(analysisCanvasSchema.parse(canvas), null, 2)}\n`;
}
