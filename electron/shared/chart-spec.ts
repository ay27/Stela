import { z } from "zod";

import type { ColumnDef } from "./types";

export const STELA_CHART_VERSION = 1 as const;
export const MAX_CHART_SOURCE_CHARS = 20_000;
export const MAX_CHART_ROWS = 5_000;

const fieldName = z.string().trim().min(1).max(256);
const common = {
  version: z.literal(STELA_CHART_VERSION),
  title: z.string().trim().max(200).optional(),
  description: z.string().trim().max(500).optional(),
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("run"), runId: z.string().min(1).max(256) }).strict(),
    z.object({ kind: z.literal("block"), blockId: z.string().min(1).max(256) }).strict(),
  ]),
};

const kpiSchema = z
  .object({
    ...common,
    type: z.literal("kpi"),
    value: fieldName,
    label: fieldName.optional(),
    prefix: z.string().max(32).optional(),
    suffix: z.string().max(32).optional(),
  })
  .strict();

const barSchema = z
  .object({
    ...common,
    type: z.literal("bar"),
    category: fieldName,
    value: fieldName,
    series: fieldName.optional(),
    orientation: z.enum(["horizontal", "vertical"]).default("horizontal"),
    stacked: z.boolean().default(false),
    sort: z.enum(["none", "asc", "desc"]).default("desc"),
  })
  .strict();

const lineSchema = z
  .object({
    ...common,
    type: z.literal("line"),
    x: fieldName,
    value: fieldName,
    series: fieldName.optional(),
    area: z.boolean().default(false),
  })
  .strict();

const pieSchema = z
  .object({
    ...common,
    type: z.literal("pie"),
    category: fieldName,
    value: fieldName,
    donut: z.boolean().default(true),
  })
  .strict();

const funnelSchema = z
  .object({
    ...common,
    type: z.literal("funnel"),
    stage: fieldName,
    value: fieldName,
  })
  .strict();

const histogramSchema = z
  .object({
    ...common,
    type: z.literal("histogram"),
    value: fieldName,
    bins: z.number().int().min(5).max(50).default(12),
  })
  .strict();

export const stelaChartSpecSchema = z.discriminatedUnion("type", [
  kpiSchema,
  barSchema,
  lineSchema,
  pieSchema,
  funnelSchema,
  histogramSchema,
]);

export type StelaChartSpec = z.infer<typeof stelaChartSpecSchema>;
export type StelaChartType = StelaChartSpec["type"];
export type StelaChartSource = StelaChartSpec["source"];
export type StelaRunChartSpec = StelaChartSpec & {
  source: { kind: "run"; runId: string };
};
export type StelaEmbeddedChartSpec = StelaChartSpec & {
  source: { kind: "block"; blockId: string };
};

export class StelaChartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StelaChartError";
  }
}

export function parseStelaChartSpec(source: string): StelaChartSpec {
  if (source.length > MAX_CHART_SOURCE_CHARS) {
    throw new StelaChartError(`Chart source exceeds ${MAX_CHART_SOURCE_CHARS} characters.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new StelaChartError(
      `Invalid chart JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = stelaChartSpecSchema.safeParse(parsed);
  if (!result.success) {
    throw new StelaChartError(result.error.issues.map((issue) => issue.message).join("; "));
  }
  return result.data;
}

export function stringifyStelaChartSpec(spec: StelaChartSpec): string {
  return JSON.stringify(stelaChartSpecSchema.parse(spec), null, 2);
}

export function parseEmbeddedStelaChartSpec(source: string): StelaEmbeddedChartSpec {
  const spec = parseStelaChartSpec(source);
  if (spec.source.kind !== "block") {
    throw new StelaChartError("A note chart must be associated with a RunSQL block.");
  }
  return spec as StelaEmbeddedChartSpec;
}

export function chartFields(spec: StelaChartSpec): string[] {
  switch (spec.type) {
    case "kpi":
      return [spec.value, ...(spec.label ? [spec.label] : [])];
    case "bar":
      return [spec.category, spec.value, ...(spec.series ? [spec.series] : [])];
    case "line":
      return [spec.x, spec.value, ...(spec.series ? [spec.series] : [])];
    case "pie":
      return [spec.category, spec.value];
    case "funnel":
      return [spec.stage, spec.value];
    case "histogram":
      return [spec.value];
  }
}

export function numericChartFields(spec: StelaChartSpec): string[] {
  return [spec.value];
}

export function toFiniteChartNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function validateStelaChartData(
  spec: StelaChartSpec,
  columns: ColumnDef[],
  rows: unknown[][],
): void {
  if (rows.length === 0) throw new StelaChartError("The query returned no rows to chart.");
  if (rows.length > MAX_CHART_ROWS) {
    throw new StelaChartError(
      `The query returned ${rows.length} rows; aggregate or filter it to at most ${MAX_CHART_ROWS} rows.`,
    );
  }
  const indexes = new Map(columns.map((column, index) => [column.name, index]));
  for (const field of chartFields(spec)) {
    if (!indexes.has(field)) throw new StelaChartError(`Column "${field}" does not exist in the query result.`);
  }
  for (const field of numericChartFields(spec)) {
    const index = indexes.get(field)!;
    if (rows.some((row) => row[index] != null && toFiniteChartNumber(row[index]) === null)) {
      throw new StelaChartError(`Column "${field}" contains non-numeric values.`);
    }
  }

  const uniqueCount = (field: string): number => {
    const index = indexes.get(field)!;
    return new Set(rows.map((row) => String(row[index] ?? "NULL"))).size;
  };
  const requireUniqueKeys = (fields: string[]): void => {
    const fieldIndexes = fields.map((field) => indexes.get(field)!);
    const keys = rows.map((row) => JSON.stringify(fieldIndexes.map((index) => row[index] ?? null)));
    if (new Set(keys).size !== keys.length) {
      throw new StelaChartError(
        `Chart keys (${fields.join(", ")}) are not unique; aggregate the duplicate rows in SQL.`,
      );
    }
  };
  if (spec.type === "kpi" && rows.length !== 1) {
    throw new StelaChartError("KPI charts require exactly one result row.");
  }
  if (spec.type === "bar" && uniqueCount(spec.category) > 100) {
    throw new StelaChartError("Bar charts support at most 100 categories; aggregate or filter the SQL.");
  }
  if (spec.type === "pie" && uniqueCount(spec.category) > 12) {
    throw new StelaChartError("Pie charts support at most 12 categories; use a bar chart or filter the SQL.");
  }
  if (spec.type === "funnel" && uniqueCount(spec.stage) > 20) {
    throw new StelaChartError("Funnel charts support at most 20 stages.");
  }
  if (spec.type === "bar") requireUniqueKeys([spec.category, ...(spec.series ? [spec.series] : [])]);
  if (spec.type === "line") requireUniqueKeys([spec.x, ...(spec.series ? [spec.series] : [])]);
  if (spec.type === "pie") requireUniqueKeys([spec.category]);
  if (spec.type === "funnel") requireUniqueKeys([spec.stage]);
}
