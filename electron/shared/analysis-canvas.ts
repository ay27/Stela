import { z } from "zod";

import { stelaChartConfigSchema } from "./chart-spec";
import { valueFormatSchema } from "./value-format";

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
export const formattedFieldSchema = z.object({
  field: z.string().trim().min(1).max(256),
  title: z.string().trim().max(200).optional(),
  format: valueFormatSchema.optional(),
}).strict();

const flowPositionSchema = z.object({
  x: z.number().finite().min(-100_000).max(100_000),
  y: z.number().finite().min(-100_000).max(100_000),
}).strict();
export const analysisCanvasFlowLayoutPatchSchema = z.object({
  direction: z.enum(["TB", "LR"]).optional(),
  positions: z.array(z.object({ nodeId: id, position: flowPositionSchema }).strict()).max(100),
}).strict();
const flowToneSchema = z.enum(["neutral", "info", "success", "warning", "danger"]);
export const analysisCanvasFlowNodeSchema = z.object({
  id,
  kind: z.enum(["step", "decision", "source", "result", "note"]),
  label: z.string().trim().min(1).max(200),
  description: z.string().trim().max(500).optional(),
  tone: flowToneSchema.optional(),
  position: flowPositionSchema.optional(),
}).strict();
export const analysisCanvasFlowEdgeSchema = z.object({
  id,
  source: id,
  target: id,
  label: z.string().trim().max(200).optional(),
  tone: flowToneSchema.exclude(["info"]).optional(),
}).strict();

export const analysisCanvasCardSchema = z.discriminatedUnion("type", [
  z.object({ ...cardBase, type: z.literal("markdown"), markdown: z.string().max(100_000) }).strict(),
  z.object({ ...cardBase, type: z.literal("kpi"), sourceId: id, value: formattedFieldSchema, label: z.string().max(256).optional(), prefix: z.string().max(32).optional(), suffix: z.string().max(32).optional() }).strict(),
  z.object({ ...cardBase, type: z.literal("chart"), sourceId: id, chart: stelaChartConfigSchema }).strict(),
  z.object({ ...cardBase, type: z.literal("table"), sourceId: id, columns: z.array(formattedFieldSchema).max(100).optional(), maxRows: z.number().int().min(1).max(500).default(50) }).strict(),
  z.object({
    ...cardBase,
    type: z.literal("flow"),
    direction: z.enum(["TB", "LR"]).default("TB"),
    nodes: z.array(analysisCanvasFlowNodeSchema).max(100),
    edges: z.array(analysisCanvasFlowEdgeSchema).max(200),
  }).strict(),
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
      if (card.type !== "markdown" && card.type !== "flow" && !sourceIds.has(card.sourceId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sections", sectionIndex, "cards", cardIndex, "sourceId"], message: "Unknown source id." });
      if (card.type === "flow") {
        const nodeIds = new Set<string>();
        for (const [nodeIndex, node] of card.nodes.entries()) {
          if (nodeIds.has(node.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sections", sectionIndex, "cards", cardIndex, "nodes", nodeIndex, "id"], message: "Duplicate flow node id." });
          nodeIds.add(node.id);
        }
        const edgeIds = new Set<string>();
        for (const [edgeIndex, edge] of card.edges.entries()) {
          if (edgeIds.has(edge.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sections", sectionIndex, "cards", cardIndex, "edges", edgeIndex, "id"], message: "Duplicate flow edge id." });
          edgeIds.add(edge.id);
          if (!nodeIds.has(edge.source)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sections", sectionIndex, "cards", cardIndex, "edges", edgeIndex, "source"], message: "Unknown flow source node." });
          if (!nodeIds.has(edge.target)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sections", sectionIndex, "cards", cardIndex, "edges", edgeIndex, "target"], message: "Unknown flow target node." });
        }
      }
    }
  }
});

export type AnalysisCanvas = z.infer<typeof analysisCanvasSchema>;
export type AnalysisCanvasSource = z.infer<typeof analysisCanvasSourceSchema>;
export type AnalysisCanvasCard = z.infer<typeof analysisCanvasCardSchema>;
export type AnalysisCanvasSection = z.infer<typeof analysisCanvasSectionSchema>;
export type AnalysisCanvasFlowNode = z.infer<typeof analysisCanvasFlowNodeSchema>;
export type AnalysisCanvasFlowEdge = z.infer<typeof analysisCanvasFlowEdgeSchema>;
export type FormattedField = z.infer<typeof formattedFieldSchema>;
export type AnalysisCanvasFlowLayoutPatch = z.infer<typeof analysisCanvasFlowLayoutPatchSchema>;

export function parseAnalysisCanvas(raw: string): AnalysisCanvas {
  return analysisCanvasSchema.parse(JSON.parse(raw));
}

export function stringifyAnalysisCanvas(canvas: AnalysisCanvas): string {
  return `${JSON.stringify(analysisCanvasSchema.parse(canvas), null, 2)}\n`;
}
