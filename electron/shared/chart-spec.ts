import { z } from "zod";

import type { ColumnDef } from "./types";
import { parseFormattedDate, valueFormatSchema } from "./value-format";

export const STELA_CHART_VERSION = 2 as const;
export const MAX_CHART_SOURCE_CHARS = 40_000;
export const MAX_CHART_ROWS = 5_000;

const fieldName = z.string().trim().min(1).max(256);
const fieldId = z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/);
const fieldType = z.enum(["nominal", "ordinal", "quantitative", "temporal", "boolean"]);
const chartPreset = z.enum(["trend", "ranking", "composition", "distribution", "correlation", "funnel", "retention", "comparison", "custom"]);
const chartMark = z.enum(["bar", "line", "area", "point", "arc", "rect", "rule", "histogram", "boxplot", "funnel"]);

export const chartFieldDefinitionSchema = z.object({
  field: fieldName,
  type: fieldType,
  title: z.string().trim().max(200).optional(),
  format: valueFormatSchema.optional(),
  temporalInput: z.enum(["iso", "epoch-ms", "epoch-seconds"]).optional(),
}).strict().superRefine((field, ctx) => {
  if (field.temporalInput && field.type !== "temporal") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["temporalInput"], message: "temporalInput is only valid for temporal fields." });
  }
});
const chartFieldsSchema = z.record(fieldId, chartFieldDefinitionSchema).refine(
  (fields) => Object.keys(fields).length <= 32,
  { message: "Charts support at most 32 semantic fields." },
);

const encodingSchema = z.object({
  x: fieldId.optional(),
  y: fieldId.optional(),
  color: fieldId.optional(),
  size: fieldId.optional(),
  theta: fieldId.optional(),
}).strict();

export const chartLayerSchema = z.object({
  mark: chartMark,
  encoding: encodingSchema,
  yAxis: z.enum(["left", "right"]).default("left"),
  stack: z.enum(["none", "normal", "percent"]).default("none"),
  bins: z.number().int().min(5).max(50).optional(),
}).strict();

const chartShape = {
  title: z.string().trim().max(200).optional(),
  description: z.string().trim().max(500).optional(),
  preset: chartPreset,
  fields: chartFieldsSchema,
  layers: z.array(chartLayerSchema).min(1).max(2),
};

type ChartShape = {
  preset: z.infer<typeof chartPreset>;
  fields: Record<string, z.infer<typeof chartFieldDefinitionSchema>>;
  layers: Array<z.infer<typeof chartLayerSchema>>;
};

const presetMarks: Record<ChartShape["preset"], ReadonlySet<z.infer<typeof chartMark>>> = {
  trend: new Set(["line", "area"]),
  ranking: new Set(["bar"]),
  composition: new Set(["arc"]),
  distribution: new Set(["histogram", "boxplot"]),
  correlation: new Set(["point"]),
  funnel: new Set(["funnel"]),
  retention: new Set(["rect"]),
  comparison: new Set(["bar", "line", "area", "point", "rule"]),
  custom: new Set(chartMark.options),
};

const layeredMarks = new Set(["bar", "line", "area", "point", "rule"]);

function refineChartShape(chart: ChartShape, ctx: z.RefinementCtx): void {
  const field = (id: string | undefined) => id ? chart.fields[id] : undefined;
  const requireType = (layerIndex: number, channel: keyof z.infer<typeof encodingSchema>, accepted: ReadonlySet<z.infer<typeof fieldType>>, message: string) => {
    const definition = field(chart.layers[layerIndex]!.encoding[channel]);
    if (definition && !accepted.has(definition.type)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["layers", layerIndex, "encoding", channel], message });
    }
  };
  const requireChannel = (layerIndex: number, channel: keyof z.infer<typeof encodingSchema>) => {
    if (!chart.layers[layerIndex]!.encoding[channel]) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["layers", layerIndex, "encoding", channel], message: `${channel} is required for ${chart.layers[layerIndex]!.mark}.` });
    }
  };
  for (const [index, layer] of chart.layers.entries()) {
    if (!presetMarks[chart.preset].has(layer.mark)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["layers", index, "mark"], message: `${layer.mark} is not valid for preset ${chart.preset}.` });
    }
    for (const [channel, id] of Object.entries(layer.encoding)) {
      if (id && !chart.fields[id]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["layers", index, "encoding", channel], message: `Unknown field id: ${id}.` });
    }
    if (["bar", "line", "area", "point"].includes(layer.mark)) { requireChannel(index, "x"); requireChannel(index, "y"); }
    if (layer.mark === "arc") { requireChannel(index, "theta"); requireChannel(index, "color"); }
    if (layer.mark === "rect") { requireChannel(index, "x"); requireChannel(index, "y"); requireChannel(index, "color"); }
    if (layer.mark === "rule") requireChannel(index, "y");
    if (layer.mark === "histogram") requireChannel(index, "x");
    if (layer.mark === "boxplot") requireChannel(index, "y");
    if (layer.mark === "funnel") { requireChannel(index, "x"); requireChannel(index, "y"); }
    if (layer.mark === "bar") {
      const xType = field(layer.encoding.x)?.type;
      const yType = field(layer.encoding.y)?.type;
      if (xType && yType && (xType === "quantitative") === (yType === "quantitative")) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["layers", index, "encoding"], message: "Bar charts require one quantitative axis and one categorical or temporal axis." });
      }
    }
    if (["line", "area", "rule"].includes(layer.mark)) {
      requireType(index, "y", new Set(["quantitative"]), `${layer.mark} y must be quantitative.`);
    }
    if (layer.mark === "point") {
      requireType(index, "y", new Set(["quantitative"]), "Point y must be quantitative.");
      if (chart.preset === "correlation") requireType(index, "x", new Set(["quantitative"]), "Correlation x must be quantitative.");
    }
    if (layer.mark === "arc") {
      requireType(index, "color", new Set(["nominal", "ordinal", "boolean"]), "Arc color must be categorical.");
    }
    if (layer.mark === "funnel") {
      requireType(index, "x", new Set(["quantitative"]), "Funnel x must be quantitative.");
      requireType(index, "y", new Set(["nominal", "ordinal"]), "Funnel y must be categorical.");
    }
    if (layer.mark === "rect") {
      requireType(index, "x", new Set(["nominal", "ordinal", "temporal"]), "Rect x must be categorical or temporal.");
      requireType(index, "y", new Set(["nominal", "ordinal", "temporal"]), "Rect y must be categorical or temporal.");
    }
    if (layer.encoding.theta && field(layer.encoding.theta)?.type !== "quantitative") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["layers", index, "encoding", "theta"], message: "theta must reference a quantitative field." });
    }
    if (layer.encoding.size && field(layer.encoding.size)?.type !== "quantitative") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["layers", index, "encoding", "size"], message: "size must reference a quantitative field." });
    }
    if (layer.mark === "histogram" && field(layer.encoding.x)?.type !== "quantitative") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["layers", index, "encoding", "x"], message: "Histogram x must be quantitative." });
    }
    if (layer.mark === "boxplot" && field(layer.encoding.y)?.type !== "quantitative") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["layers", index, "encoding", "y"], message: "Boxplot y must be quantitative." });
    }
    if (layer.mark === "rect" && field(layer.encoding.color)?.type !== "quantitative") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["layers", index, "encoding", "color"], message: "Rect color must be quantitative." });
    }
    if (layer.stack !== "none" && !["bar", "area"].includes(layer.mark)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["layers", index, "stack"], message: "Only bar and area marks can be stacked." });
    }
    if (layer.bins && layer.mark !== "histogram") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["layers", index, "bins"], message: "bins is only valid for histogram marks." });
    }
  }
  if (chart.layers.length === 2) {
    if (chart.preset !== "comparison" && chart.preset !== "custom") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["layers"], message: "Only comparison and custom presets support two layers." });
    }
    if (chart.layers.some((layer) => !layeredMarks.has(layer.mark))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["layers"], message: "Layered charts support only bar, line, area, point, and rule marks." });
    }
    const xFields = chart.layers.map((layer) => layer.encoding.x).filter(Boolean);
    if (new Set(xFields).size > 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["layers"], message: "Layered charts must share the same x field." });
    }
  }
}

export const stelaChartConfigSchema = z.object(chartShape).strict().superRefine(refineChartShape);

export const stelaChartSpecSchema = z.object({
  version: z.literal(STELA_CHART_VERSION),
  source: z.object({ kind: z.literal("run"), runId: z.string().min(1).max(256) }).strict(),
  ...chartShape,
}).strict().superRefine(refineChartShape);

export type ChartFieldDefinition = z.infer<typeof chartFieldDefinitionSchema>;
export type ChartLayer = z.infer<typeof chartLayerSchema>;
export type StelaChartSpec = z.infer<typeof stelaChartSpecSchema>;
export type StelaChartConfig = z.infer<typeof stelaChartConfigSchema>;
export type StelaChartType = ChartLayer["mark"];
export type StelaChartSource = StelaChartSpec["source"];
export type StelaRunChartSpec = StelaChartSpec & { source: { kind: "run"; runId: string } };

export class StelaChartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StelaChartError";
  }
}

export function parseStelaChartSpec(source: string): StelaChartSpec {
  if (source.length > MAX_CHART_SOURCE_CHARS) throw new StelaChartError(`Chart source exceeds ${MAX_CHART_SOURCE_CHARS} characters.`);
  let parsed: unknown;
  try { parsed = JSON.parse(source); }
  catch (error) { throw new StelaChartError(`Invalid chart JSON: ${error instanceof Error ? error.message : String(error)}`); }
  const result = stelaChartSpecSchema.safeParse(parsed);
  if (!result.success) throw new StelaChartError(result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  return result.data;
}

export function stringifyStelaChartSpec(spec: StelaChartSpec): string {
  return JSON.stringify(stelaChartSpecSchema.parse(spec), null, 2);
}

export function chartFields(spec: StelaChartSpec): string[] {
  return [...new Set(Object.values(spec.fields).map((definition) => definition.field))];
}

export function numericChartFields(spec: StelaChartSpec): string[] {
  return [...new Set(Object.values(spec.fields).filter((definition) => definition.type === "quantitative").map((definition) => definition.field))];
}

export function toFiniteChartNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function fieldColumnIndexes(spec: StelaChartSpec, columns: ColumnDef[]): Map<string, number> {
  const columnsByName = new Map(columns.map((column, index) => [column.name, index]));
  const indexes = new Map<string, number>();
  for (const [id, definition] of Object.entries(spec.fields)) {
    const index = columnsByName.get(definition.field);
    if (index === undefined) throw new StelaChartError(`Column "${definition.field}" does not exist in the query result.`);
    indexes.set(id, index);
  }
  return indexes;
}

export function validateStelaChartData(spec: StelaChartSpec, columns: ColumnDef[], rows: unknown[][]): void {
  if (rows.length === 0) throw new StelaChartError("The query returned no rows to chart.");
  if (rows.length > MAX_CHART_ROWS) throw new StelaChartError(`The query returned ${rows.length} rows; aggregate or filter it to at most ${MAX_CHART_ROWS} rows.`);
  const indexes = fieldColumnIndexes(spec, columns);
  for (const [id, definition] of Object.entries(spec.fields)) {
    const index = indexes.get(id)!;
    if (definition.type === "quantitative" && rows.some((row) => row[index] != null && toFiniteChartNumber(row[index]) === null)) {
      throw new StelaChartError(`Column "${definition.field}" contains non-numeric values.`);
    }
    if (definition.type === "quantitative" && rows.every((row) => toFiniteChartNumber(row[index]) === null)) {
      throw new StelaChartError(`Column "${definition.field}" contains no numeric values.`);
    }
    if (definition.type === "temporal" && rows.some((row) => row[index] != null && !parseFormattedDate(row[index], definition.temporalInput ?? "iso"))) {
      throw new StelaChartError(`Column "${definition.field}" contains invalid temporal values.`);
    }
  }
  const uniqueCount = (id: string): number => new Set(rows.map((row) => String(row[indexes.get(id)!] ?? "NULL"))).size;
  const requireUniqueKeys = (ids: string[]) => {
    const keys = rows.map((row) => JSON.stringify(ids.map((id) => row[indexes.get(id)!] ?? null)));
    if (new Set(keys).size !== keys.length) throw new StelaChartError(`Chart keys (${ids.join(", ")}) are not unique; aggregate duplicate rows in SQL.`);
  };
  const requireCompleteNumeric = (id: string) => {
    if (rows.some((row) => toFiniteChartNumber(row[indexes.get(id)!]) === null)) {
      throw new StelaChartError(`Column "${spec.fields[id]!.field}" contains null or missing numeric values; filter or coalesce them in SQL.`);
    }
  };
  for (const layer of spec.layers) {
    const { x, y, color } = layer.encoding;
    if (["line", "area"].includes(layer.mark) && x && y) requireUniqueKeys([x, ...(color ? [color] : [])]);
    if (layer.mark === "bar" && x && y) {
      const category = spec.fields[x]?.type === "quantitative" ? y : x;
      requireUniqueKeys([category, ...(color ? [color] : [])]);
    }
    if (layer.mark === "arc" && color) {
      requireCompleteNumeric(layer.encoding.theta!);
      requireUniqueKeys([color]);
      if (uniqueCount(color) > 12) throw new StelaChartError("Composition charts support at most 12 categories.");
    }
    if (layer.mark === "funnel" && y) {
      requireCompleteNumeric(layer.encoding.x!);
      requireUniqueKeys([y]);
      if (uniqueCount(y) > 20) throw new StelaChartError("Funnel charts support at most 20 stages.");
    }
    if (layer.mark === "bar" && x && y) {
      const category = spec.fields[x]?.type === "quantitative" ? y : x;
      if (uniqueCount(category) > 100) throw new StelaChartError("Bar charts support at most 100 categories; aggregate or filter the SQL.");
    }
    if (layer.mark === "rect" && x && y && uniqueCount(x) * uniqueCount(y) > 2_500) {
      throw new StelaChartError("Heatmaps support at most 2,500 cells.");
    }
    if (layer.mark === "rect" && x && y) {
      requireCompleteNumeric(layer.encoding.color!);
      requireUniqueKeys([x, y]);
    }
    if (layer.mark === "histogram") requireCompleteNumeric(layer.encoding.x!);
    if (layer.mark === "boxplot") requireCompleteNumeric(layer.encoding.y!);
  }
}
