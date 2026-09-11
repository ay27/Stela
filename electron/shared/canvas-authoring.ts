import { z } from "zod";
import { analysisCanvasSectionSchema, analysisCanvasSourceSchema } from "./analysis-canvas";

/** Model-owned content only; identity, timestamps and query provenance are host-owned. */
export const canvasAuthoringSchema = z.object({
  title: z.string().trim().min(1).max(200),
  status: z.enum(["working", "complete"]).default("working"),
  sources: z.array(analysisCanvasSourceSchema.pick({ id: true, title: true })).max(100),
  sections: z.array(analysisCanvasSectionSchema).min(1).max(100),
}).strict().superRefine((value, ctx) => {
  const cards = value.sections.flatMap(section => section.cards);
  if (!cards.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sections"], message: "An Agent Canvas must contain at least one card." });
  for (const [si, section] of value.sections.entries()) for (const [ci, card] of section.cards.entries()) {
    if (card.type === "flow" && !card.nodes.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sections", si, "cards", ci, "nodes"], message: "A Flow card must contain at least one node." });
    if (card.type === "markdown" && !card.markdown.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sections", si, "cards", ci, "markdown"], message: "A Markdown card must contain text." });
  }
});
export const canvasSourceRunsSchema = z.array(z.object({ sourceId: z.string().min(1), runId: z.string().min(1) }).strict()).max(100);
export const createCanvasToolSchema = z.object({
  directory: z.string().optional(), canvas: canvasAuthoringSchema, sourceRuns: canvasSourceRunsSchema,
}).strict();
export const updateCanvasToolSchema = z.object({
  path: z.string().min(1), etag: z.string().min(1), canvas: canvasAuthoringSchema, sourceRuns: canvasSourceRunsSchema,
}).strict();
