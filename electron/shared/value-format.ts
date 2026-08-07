import { z } from "zod";

const fractionDigits = z.number().int().min(0).max(12).optional();
const common = { nullLabel: z.string().max(32).optional() };

const valueFormatUnion = z.discriminatedUnion("kind", [
  z.object({ ...common, kind: z.literal("auto") }).strict(),
  z.object({ ...common, kind: z.literal("text") }).strict(),
  z.object({ ...common, kind: z.literal("number"), minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits }).strict(),
  z.object({ ...common, kind: z.literal("compact"), maximumFractionDigits: fractionDigits }).strict(),
  z.object({ ...common, kind: z.literal("percent"), input: z.enum(["ratio", "whole"]), maximumFractionDigits: fractionDigits }).strict(),
  z.object({ ...common, kind: z.literal("currency"), currency: z.string().regex(/^[A-Z]{3}$/), maximumFractionDigits: fractionDigits }).strict(),
  z.object({ ...common, kind: z.literal("date"), style: z.enum(["short", "medium", "long"]).default("medium"), input: z.enum(["iso", "epoch-ms", "epoch-seconds"]).default("iso"), timeZone: z.enum(["local", "UTC"]).default("local") }).strict(),
  z.object({ ...common, kind: z.literal("datetime"), style: z.enum(["short", "medium", "long"]).default("medium"), input: z.enum(["iso", "epoch-ms", "epoch-seconds"]).default("iso"), timeZone: z.enum(["local", "UTC"]).default("local") }).strict(),
  z.object({ ...common, kind: z.literal("duration"), input: z.enum(["milliseconds", "seconds"]), style: z.enum(["short", "clock"]).default("short") }).strict(),
  z.object({ ...common, kind: z.literal("boolean"), trueLabel: z.string().max(64).default("True"), falseLabel: z.string().max(64).default("False") }).strict(),
]);

export const valueFormatSchema = valueFormatUnion.superRefine((format, ctx) => {
  if (
    format.kind === "number" &&
    format.minimumFractionDigits !== undefined &&
    format.maximumFractionDigits !== undefined &&
    format.minimumFractionDigits > format.maximumFractionDigits
  ) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["minimumFractionDigits"], message: "minimumFractionDigits cannot exceed maximumFractionDigits." });
  }
});

export type ValueFormat = z.infer<typeof valueFormatSchema>;

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseFormattedDate(value: unknown, input: "iso" | "epoch-ms" | "epoch-seconds"): Date | null {
  const raw = input === "iso" ? value : finiteNumber(value);
  if (raw === null || raw === undefined || raw === "") return null;
  const date = input === "iso"
    ? new Date(String(raw))
    : new Date((raw as number) * (input === "epoch-seconds" ? 1_000 : 1));
  return Number.isFinite(date.getTime()) ? date : null;
}

function formatDuration(value: number, input: "milliseconds" | "seconds", style: "short" | "clock"): string {
  const totalSeconds = Math.max(0, input === "milliseconds" ? value / 1_000 : value);
  if (style === "short") {
    if (totalSeconds < 60) return `${totalSeconds.toLocaleString(undefined, { maximumFractionDigits: totalSeconds < 10 ? 1 : 0 })}s`;
    if (totalSeconds < 3_600) return `${(totalSeconds / 60).toLocaleString(undefined, { maximumFractionDigits: 1 })}m`;
    return `${(totalSeconds / 3_600).toLocaleString(undefined, { maximumFractionDigits: 1 })}h`;
  }
  const rounded = Math.round(totalSeconds);
  const hours = Math.floor(rounded / 3_600);
  const minutes = Math.floor((rounded % 3_600) / 60);
  const seconds = rounded % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function formatValue(value: unknown, format?: ValueFormat, locale?: string): string {
  if (value == null) return format?.nullLabel ?? "NULL";
  if (!format || format.kind === "auto" || format.kind === "text") return String(value);
  if (format.kind === "boolean") {
    const normalized = typeof value === "string" ? value.trim().toLowerCase() : value;
    const truthy = normalized === true || normalized === 1 || normalized === "1" || normalized === "true";
    const falsy = normalized === false || normalized === 0 || normalized === "0" || normalized === "false";
    return truthy ? format.trueLabel : falsy ? format.falseLabel : String(value);
  }
  if (format.kind === "date" || format.kind === "datetime") {
    const date = parseFormattedDate(value, format.input);
    if (!date) return String(value);
    const timeZone = format.timeZone === "UTC" ? "UTC" : undefined;
    return format.kind === "date"
      ? new Intl.DateTimeFormat(locale, { dateStyle: format.style, timeZone }).format(date)
      : new Intl.DateTimeFormat(locale, { dateStyle: format.style, timeStyle: format.style, timeZone }).format(date);
  }
  const numeric = finiteNumber(value);
  if (numeric === null) return String(value);
  if (format.kind === "duration") return formatDuration(numeric, format.input, format.style);
  if (format.kind === "percent") {
    return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: format.maximumFractionDigits ?? 2 }).format(format.input === "whole" ? numeric / 100 : numeric);
  }
  if (format.kind === "currency") {
    return new Intl.NumberFormat(locale, { style: "currency", currency: format.currency, maximumFractionDigits: format.maximumFractionDigits }).format(numeric);
  }
  return new Intl.NumberFormat(locale, {
    notation: format.kind === "compact" ? "compact" : "standard",
    minimumFractionDigits: format.kind === "number" ? format.minimumFractionDigits : undefined,
    maximumFractionDigits: format.maximumFractionDigits,
  }).format(numeric);
}
