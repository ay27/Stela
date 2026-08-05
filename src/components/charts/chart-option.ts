import type { EChartsOption, SeriesOption } from "echarts";

import type { ColumnDef } from "@/contracts";
import {
  toFiniteChartNumber,
  type StelaChartSpec,
} from "@shared/chart-spec";

function indexColumns(columns: ColumnDef[]): Map<string, number> {
  return new Map(columns.map((column, index) => [column.name, index]));
}

function text(value: unknown): string {
  return value == null ? "NULL" : String(value);
}

function number(value: unknown): number {
  return toFiniteChartNumber(value) ?? 0;
}

function paletteTextColor(dark?: boolean): string {
  const isDark = dark ?? document.documentElement.classList.contains("dark");
  return isDark ? "#d4d4d8" : "#3f3f46";
}

export function buildStelaChartOption(
  spec: Exclude<StelaChartSpec, { type: "kpi" }>,
  columns: ColumnDef[],
  rows: unknown[][],
  dark?: boolean,
): EChartsOption {
  const indexes = indexColumns(columns);
  const color = paletteTextColor(dark);
  const common: EChartsOption = {
    animationDuration: 350,
    textStyle: { color, fontFamily: "Inter, system-ui, sans-serif" },
    title: spec.title ? { text: spec.title, left: 12, top: 8, textStyle: { fontSize: 14, color } } : undefined,
    tooltip: { trigger: spec.type === "pie" || spec.type === "funnel" ? "item" : "axis" },
  };

  if (spec.type === "pie") {
    const categoryIndex = indexes.get(spec.category)!;
    const valueIndex = indexes.get(spec.value)!;
    return {
      ...common,
      legend: { type: "scroll", bottom: 0, textStyle: { color } },
      series: [{
        type: "pie",
        radius: spec.donut ? ["42%", "68%"] : "68%",
        center: ["50%", "46%"],
        label: { formatter: "{b}: {d}%", color },
        data: rows.map((row) => ({ name: text(row[categoryIndex]), value: number(row[valueIndex]) })),
      }],
    };
  }

  if (spec.type === "funnel") {
    const stageIndex = indexes.get(spec.stage)!;
    const valueIndex = indexes.get(spec.value)!;
    return {
      ...common,
      series: [{
        type: "funnel",
        top: spec.title ? 52 : 24,
        bottom: 16,
        left: "12%",
        width: "76%",
        sort: "none",
        label: { formatter: "{b}: {c}", color },
        data: rows.map((row) => ({ name: text(row[stageIndex]), value: number(row[valueIndex]) })),
      }],
    };
  }

  if (spec.type === "histogram") {
    const valueIndex = indexes.get(spec.value)!;
    const values = rows.map((row) => number(row[valueIndex]));
    const min = Math.min(...values);
    const max = Math.max(...values);
    const width = max === min ? 1 : (max - min) / spec.bins;
    const counts = Array.from({ length: spec.bins }, () => 0);
    for (const value of values) {
      const bin = max === min ? 0 : Math.min(spec.bins - 1, Math.floor((value - min) / width));
      counts[bin] = (counts[bin] ?? 0) + 1;
    }
    const labels = counts.map((_, index) => {
      const from = min + index * width;
      const to = from + width;
      return `${from.toLocaleString(undefined, { maximumFractionDigits: 2 })}–${to.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
    });
    return {
      ...common,
      grid: { left: 52, right: 20, top: spec.title ? 52 : 24, bottom: 72 },
      xAxis: { type: "category", data: labels, axisLabel: { rotate: 35, color } },
      yAxis: { type: "value", name: "Count", axisLabel: { color } },
      series: [{ type: "bar", data: counts, barMaxWidth: 48 }],
    };
  }

  const categoryField = spec.type === "bar" ? spec.category : spec.x;
  const categoryIndex = indexes.get(categoryField)!;
  const valueIndex = indexes.get(spec.value)!;
  const seriesIndex = spec.series ? indexes.get(spec.series)! : null;
  const categories = Array.from(new Set(rows.map((row) => text(row[categoryIndex]))));
  const seriesNames = seriesIndex === null
    ? [spec.value]
    : Array.from(new Set(rows.map((row) => text(row[seriesIndex]))));
  const values = new Map<string, number>();
  for (const row of rows) {
    const category = text(row[categoryIndex]);
    const seriesName = seriesIndex === null ? spec.value : text(row[seriesIndex]);
    values.set(`${category}\u0000${seriesName}`, number(row[valueIndex]));
  }

  if (spec.type === "bar" && spec.sort !== "none" && seriesNames.length === 1) {
    const direction = spec.sort === "asc" ? 1 : -1;
    categories.sort((a, b) => direction * ((values.get(`${a}\u0000${seriesNames[0]}`) ?? 0) - (values.get(`${b}\u0000${seriesNames[0]}`) ?? 0)));
  }

  const series: SeriesOption[] = seriesNames.map((seriesName) => ({
    name: seriesName,
    type: spec.type === "bar" ? "bar" : "line",
    stack: spec.type === "bar" && spec.stacked ? "total" : undefined,
    areaStyle: spec.type === "line" && spec.area ? {} : undefined,
    smooth: spec.type === "line",
    data: categories.map((category) => values.get(`${category}\u0000${seriesName}`) ?? null),
  }));

  const horizontal = spec.type === "bar" && spec.orientation === "horizontal";
  return {
    ...common,
    legend: seriesNames.length > 1 ? { type: "scroll", bottom: 0, textStyle: { color } } : undefined,
    grid: { left: horizontal ? 100 : 52, right: 24, top: spec.title ? 52 : 24, bottom: seriesNames.length > 1 ? 48 : 36, containLabel: true },
    xAxis: horizontal
      ? { type: "value", axisLabel: { color } }
      : { type: "category", data: categories, axisLabel: { color, hideOverlap: true } },
    yAxis: horizontal
      ? { type: "category", data: categories, inverse: true, axisLabel: { color } }
      : { type: "value", axisLabel: { color } },
    series,
  };
}
