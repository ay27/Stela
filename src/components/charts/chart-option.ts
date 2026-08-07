import type { EChartsOption, SeriesOption } from "echarts";

import type { ColumnDef } from "@/contracts";
import {
  toFiniteChartNumber,
  type ChartFieldDefinition,
  type ChartLayer,
  type StelaChartSpec,
} from "@shared/chart-spec";
import { formatValue, parseFormattedDate } from "@shared/value-format";

function indexColumns(columns: ColumnDef[]): Map<string, number> {
  return new Map(columns.map((column, index) => [column.name, index]));
}

function text(value: unknown): string {
  return value == null ? "NULL" : String(value);
}

function number(value: unknown): number | null {
  return toFiniteChartNumber(value);
}

function paletteTextColor(dark?: boolean): string {
  const isDark = dark ?? document.documentElement.classList.contains("dark");
  return isDark ? "#d4d4d8" : "#3f3f46";
}

function fieldValue(definition: ChartFieldDefinition, value: unknown): unknown {
  if (definition.type === "quantitative") return toFiniteChartNumber(value);
  if (definition.type === "temporal") return parseFormattedDate(value, definition.temporalInput ?? "iso")?.getTime() ?? null;
  return value == null ? "NULL" : String(value);
}

function axisType(definition: ChartFieldDefinition): "value" | "time" | "category" {
  if (definition.type === "quantitative") return "value";
  if (definition.type === "temporal") return "time";
  return "category";
}

function quantile(sorted: number[], position: number): number {
  if (sorted.length === 0) return 0;
  const index = (sorted.length - 1) * position;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
}

function box(values: number[]): [number, number, number, number, number] {
  const sorted = [...values].sort((a, b) => a - b);
  return [sorted[0] ?? 0, quantile(sorted, 0.25), quantile(sorted, 0.5), quantile(sorted, 0.75), sorted.at(-1) ?? 0];
}

function commonSeries(
  mark: ChartLayer["mark"],
  name: string,
  layer: ChartLayer,
  yAxisIndex: number,
): Record<string, unknown> {
  const type = mark === "point" ? "scatter" : mark === "area" || mark === "rule" ? "line" : mark;
  return {
    name,
    type,
    yAxisIndex,
    stack: layer.stack === "none" ? undefined : `stack-${yAxisIndex}`,
    areaStyle: mark === "area" ? {} : undefined,
    smooth: mark === "line" || mark === "area",
    symbol: mark === "rule" ? "none" : undefined,
    lineStyle: mark === "rule" ? { type: "dashed", width: 2 } : undefined,
  };
}

export function buildStelaChartOption(
  spec: StelaChartSpec,
  columns: ColumnDef[],
  rows: unknown[][],
  dark?: boolean,
  locale?: string,
): EChartsOption {
  const indexes = indexColumns(columns);
  const color = paletteTextColor(dark);
  const valueAt = (row: unknown[], fieldId: string): unknown => {
    const definition = spec.fields[fieldId]!;
    return fieldValue(definition, row[indexes.get(definition.field)!]);
  };
  const labelFor = (fieldId: string, value: unknown): string => {
    const definition = spec.fields[fieldId]!;
    if (definition.type === "temporal") {
      const format = definition.format?.kind === "date" || definition.format?.kind === "datetime"
        ? { ...definition.format, input: "epoch-ms" as const }
        : { kind: "date" as const, input: "epoch-ms" as const, style: "medium" as const, timeZone: "local" as const };
      return formatValue(value, format, locale);
    }
    return formatValue(value, definition.format, locale);
  };
  const firstLayer = spec.layers[0]!;
  const standalone = spec.layers.length === 1;
  const common: EChartsOption = {
    animationDuration: 350,
    textStyle: { color, fontFamily: "Inter, system-ui, sans-serif" },
    title: spec.title ? { text: spec.title, left: 12, top: 8, textStyle: { fontSize: 14, color } } : undefined,
    tooltip: { trigger: ["arc", "funnel"].includes(firstLayer.mark) ? "item" : "axis" },
  };

  if (standalone && firstLayer.mark === "arc") {
    const category = firstLayer.encoding.color!;
    const theta = firstLayer.encoding.theta!;
    return {
      ...common,
      legend: { type: "scroll", bottom: 0, textStyle: { color } },
      series: [{
        type: "pie",
        radius: ["42%", "68%"],
        center: ["50%", "46%"],
        label: { formatter: "{b}: {d}%", color },
        tooltip: { valueFormatter: (value: unknown) => labelFor(theta, value) },
        data: rows.map((row) => ({ name: text(valueAt(row, category)), value: number(valueAt(row, theta))! })),
      }],
    };
  }

  if (standalone && firstLayer.mark === "funnel") {
    const stage = firstLayer.encoding.y!;
    const value = firstLayer.encoding.x!;
    return {
      ...common,
      series: [{
        type: "funnel",
        top: spec.title ? 52 : 24,
        bottom: 16,
        left: "12%",
        width: "76%",
        sort: "none",
        label: { formatter: (params: { name?: string; value?: unknown }) => `${params.name ?? ""}: ${labelFor(value, params.value)}`, color },
        tooltip: { valueFormatter: (raw: unknown) => labelFor(value, raw) },
        data: rows.map((row) => ({ name: text(valueAt(row, stage)), value: number(valueAt(row, value))! })),
      }],
    };
  }

  if (standalone && firstLayer.mark === "histogram") {
    const valueId = firstLayer.encoding.x!;
    const values = rows.flatMap((row) => {
      const value = number(valueAt(row, valueId));
      return value === null ? [] : [value];
    });
    const min = Math.min(...values);
    const max = Math.max(...values);
    const bins = firstLayer.bins ?? 12;
    const width = max === min ? 1 : (max - min) / bins;
    const counts = Array.from({ length: bins }, () => 0);
    for (const value of values) {
      const bin = max === min ? 0 : Math.min(bins - 1, Math.floor((value - min) / width));
      counts[bin] = (counts[bin] ?? 0) + 1;
    }
    const labels = counts.map((_, index) => `${labelFor(valueId, min + index * width)}–${labelFor(valueId, min + (index + 1) * width)}`);
    return {
      ...common,
      grid: { left: 52, right: 20, top: spec.title ? 52 : 24, bottom: 72 },
      xAxis: { type: "category", data: labels, axisLabel: { rotate: 35, color } },
      yAxis: { type: "value", name: "Count", axisLabel: { color } },
      series: [{ type: "bar", data: counts, barMaxWidth: 48 }],
    };
  }

  if (standalone && firstLayer.mark === "boxplot") {
    const valueId = firstLayer.encoding.y!;
    const groupId = firstLayer.encoding.x;
    const groups = new Map<string, number[]>();
    for (const row of rows) {
      const group = groupId ? text(valueAt(row, groupId)) : "Distribution";
      const value = number(valueAt(row, valueId));
      if (value !== null) groups.set(group, [...(groups.get(group) ?? []), value]);
    }
    return {
      ...common,
      grid: { left: 64, right: 20, top: spec.title ? 52 : 24, bottom: 48 },
      xAxis: { type: "category", data: [...groups.keys()], axisLabel: { color } },
      yAxis: { type: "value", axisLabel: { color, formatter: (value: unknown) => labelFor(valueId, value) } },
      series: [{ type: "boxplot", data: [...groups.values()].map(box) }],
    };
  }

  if (standalone && firstLayer.mark === "rect") {
    const xId = firstLayer.encoding.x!;
    const yId = firstLayer.encoding.y!;
    const valueId = firstLayer.encoding.color!;
    const xs = [...new Set(rows.map((row) => text(valueAt(row, xId))))];
    const ys = [...new Set(rows.map((row) => text(valueAt(row, yId))))];
    const values = rows.flatMap((row) => {
      const value = number(valueAt(row, valueId));
      return value === null ? [] : [value];
    });
    return {
      ...common,
      grid: { left: 72, right: 72, top: spec.title ? 52 : 24, bottom: 52 },
      xAxis: { type: "category", data: xs, axisLabel: { color, hideOverlap: true } },
      yAxis: { type: "category", data: ys, axisLabel: { color } },
      visualMap: { min: Math.min(...values), max: Math.max(...values), calculable: true, right: 0, top: "middle", textStyle: { color } },
      series: [{ type: "heatmap", data: rows.map((row) => [xs.indexOf(text(valueAt(row, xId))), ys.indexOf(text(valueAt(row, yId))), number(valueAt(row, valueId))]) }],
    };
  }

  const sharedX = spec.layers.find((layer) => layer.encoding.x)?.encoding.x;
  const series: SeriesOption[] = [];
  for (const layer of spec.layers) {
    const xId = layer.encoding.x ?? sharedX!;
    const yId = layer.encoding.y!;
    const colorId = layer.encoding.color;
    const groups = colorId ? [...new Set(rows.map((row) => text(valueAt(row, colorId))))] : [spec.fields[yId]?.title ?? spec.fields[yId]?.field ?? yId];
    const totals = new Map<string, number>();
    if (layer.stack === "percent" && colorId) {
      for (const row of rows) {
        const key = text(valueAt(row, xId));
        totals.set(key, (totals.get(key) ?? 0) + (number(valueAt(row, yId)) ?? 0));
      }
    }
    for (const group of groups) {
      const filtered = colorId ? rows.filter((row) => text(valueAt(row, colorId)) === group) : rows;
      const data = filtered.map((row) => {
        const x = valueAt(row, xId);
        let y = number(valueAt(row, yId));
        if (layer.stack === "percent" && y !== null) y = (totals.get(text(x)) ?? 0) === 0 ? 0 : y / totals.get(text(x))!;
        return [x, y, ...(layer.encoding.size ? [number(valueAt(row, layer.encoding.size))] : [])];
      });
      series.push({
        ...commonSeries(layer.mark, group, layer, layer.yAxis === "right" ? 1 : 0),
        data,
        tooltip: { valueFormatter: (value: unknown) => {
          const tuple = Array.isArray(value) ? value : [];
          return labelFor(yId, tuple[1] ?? value);
        } },
        symbolSize: layer.mark === "point" && layer.encoding.size ? (value: unknown) => {
          const row = Array.isArray(value) ? value : [];
          return Math.max(6, Math.min(42, Math.sqrt(number(row[2]) ?? 0) * 2));
        } : undefined,
      } as SeriesOption);
    }
  }

  const xId = sharedX ?? firstLayer.encoding.x!;
  const xDefinition = spec.fields[xId]!;
  const yDefinitions = ["left", "right"].map((side) => {
    const layer = spec.layers.find((item) => item.yAxis === side) ?? spec.layers[0]!;
    return spec.fields[layer.encoding.y!]!;
  });
  const hasRightAxis = spec.layers.some((layer) => layer.yAxis === "right");
  return {
    ...common,
    legend: series.length > 1 ? { type: "scroll", bottom: 0, textStyle: { color } } : undefined,
    grid: { left: 64, right: hasRightAxis ? 64 : 24, top: spec.title ? 52 : 24, bottom: series.length > 1 ? 52 : 40, containLabel: true },
    xAxis: { type: axisType(xDefinition), name: xDefinition.title, axisLabel: { color, hideOverlap: true, formatter: (value: unknown) => labelFor(xId, value) } },
    yAxis: yDefinitions.slice(0, hasRightAxis ? 2 : 1).map((definition, index) => ({
      type: axisType(definition),
      name: definition.title,
      position: index === 1 ? "right" : "left",
      axisLabel: { color, formatter: (value: unknown) => {
        const layer = spec.layers.find((item) => (item.yAxis === "right" ? 1 : 0) === index) ?? spec.layers[0]!;
        return layer.stack === "percent" ? `${(number(value) ?? 0) * 100}%` : formatValue(value, definition.format, locale);
      } },
    })),
    series,
  } as EChartsOption;
}
