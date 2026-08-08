import type { EChartsOption } from "echarts";

import type { StelaChartSpec } from "@shared/chart-spec";
import type { StelaChartData } from "@/components/charts/chart-data";
import { buildStelaChartOption } from "@/components/charts/chart-option";

type ChartCallbackMetadata =
  | { kind: "none" }
  | { kind: "arc"; valueFieldId: string }
  | { kind: "funnel"; stageFieldId: string; valueFieldId: string }
  | { kind: "boxplot"; valueFieldId: string }
  | {
      kind: "cartesian";
      xFieldId: string;
      series: Array<{ valueFieldId: string; pointSize: boolean }>;
      yAxes: Array<{ valueFieldId: string; percent: boolean }>;
    };

export interface InteractiveChartExport {
  elementId: string;
  option: unknown;
  spec: StelaChartSpec;
  locale: string;
  callbacks: ChartCallbackMetadata;
}

function jsonSafeOption(option: EChartsOption): unknown {
  return JSON.parse(JSON.stringify(option)) as unknown;
}

function distinctGroupCount(spec: StelaChartSpec, data: StelaChartData, fieldId: string | undefined): number {
  if (!fieldId) return 1;
  const definition = spec.fields[fieldId]!;
  const index = data.columns.findIndex((column) => column.name === definition.field);
  return new Set(data.rows.map((row) => row[index] == null ? "NULL" : String(row[index]))).size;
}

function callbackMetadata(spec: StelaChartSpec, data: StelaChartData): ChartCallbackMetadata {
  const firstLayer = spec.layers[0]!;
  if (spec.layers.length === 1 && firstLayer.mark === "arc") {
    return { kind: "arc", valueFieldId: firstLayer.encoding.theta! };
  }
  if (spec.layers.length === 1 && firstLayer.mark === "funnel") {
    return { kind: "funnel", stageFieldId: firstLayer.encoding.y!, valueFieldId: firstLayer.encoding.x! };
  }
  if (spec.layers.length === 1 && firstLayer.mark === "boxplot") {
    return { kind: "boxplot", valueFieldId: firstLayer.encoding.y! };
  }
  if (spec.layers.length === 1 && (firstLayer.mark === "histogram" || firstLayer.mark === "rect")) {
    return { kind: "none" };
  }

  const sharedX = spec.layers.find((layer) => layer.encoding.x)?.encoding.x ?? firstLayer.encoding.x!;
  const series = spec.layers.flatMap((layer) => Array.from(
    { length: distinctGroupCount(spec, data, layer.encoding.color) },
    () => ({ valueFieldId: layer.encoding.y!, pointSize: layer.mark === "point" && Boolean(layer.encoding.size) }),
  ));
  const hasRightAxis = spec.layers.some((layer) => layer.yAxis === "right");
  const yAxes = ["left", "right"].slice(0, hasRightAxis ? 2 : 1).map((side) => {
    const layer = spec.layers.find((item) => item.yAxis === side) ?? firstLayer;
    return { valueFieldId: layer.encoding.y!, percent: layer.stack === "percent" };
  });
  return { kind: "cartesian", xFieldId: sharedX, series, yAxes };
}

export function buildInteractiveChartExport(
  elementId: string,
  spec: StelaChartSpec,
  data: StelaChartData,
  locale: string,
): InteractiveChartExport {
  return {
    elementId,
    option: jsonSafeOption(buildStelaChartOption(spec, data.columns, data.rows, false, locale)),
    spec,
    locale,
    callbacks: callbackMetadata(spec, data),
  };
}

function safeScriptSource(source: string): string {
  return source.replace(/<\/script/gi, "<\\/script");
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function renderInteractiveChartScripts(charts: InteractiveChartExport[], echartsSource: string): string {
  if (charts.length === 0) return "";
  return `<script>${safeScriptSource(echartsSource)}</script><script>(() => {
  "use strict";
  const charts = ${scriptJson(charts)};
  const finiteNumber = (value) => {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value !== "string" || !value.trim()) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const parseDate = (value, input) => {
    const numeric = input === "iso" ? null : finiteNumber(value);
    if (value == null || value === "" || (input !== "iso" && numeric === null)) return null;
    const date = input === "iso" ? new Date(String(value)) : new Date(numeric * (input === "epoch-seconds" ? 1000 : 1));
    return Number.isFinite(date.getTime()) ? date : null;
  };
  const formatDuration = (value, input, style, locale) => {
    const totalSeconds = Math.max(0, input === "milliseconds" ? value / 1000 : value);
    if (style === "short") {
      if (totalSeconds < 60) return totalSeconds.toLocaleString(locale, { maximumFractionDigits: totalSeconds < 10 ? 1 : 0 }) + "s";
      if (totalSeconds < 3600) return (totalSeconds / 60).toLocaleString(locale, { maximumFractionDigits: 1 }) + "m";
      return (totalSeconds / 3600).toLocaleString(locale, { maximumFractionDigits: 1 }) + "h";
    }
    const rounded = Math.round(totalSeconds);
    const hours = Math.floor(rounded / 3600);
    const minutes = Math.floor((rounded % 3600) / 60);
    const seconds = rounded % 60;
    return hours > 0
      ? hours + ":" + String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0")
      : minutes + ":" + String(seconds).padStart(2, "0");
  };
  const formatValue = (value, format, locale) => {
    if (value == null) return (format && format.nullLabel) || "NULL";
    if (!format || format.kind === "auto" || format.kind === "text") return String(value);
    if (format.kind === "boolean") {
      const normalized = typeof value === "string" ? value.trim().toLowerCase() : value;
      const truthy = normalized === true || normalized === 1 || normalized === "1" || normalized === "true";
      const falsy = normalized === false || normalized === 0 || normalized === "0" || normalized === "false";
      return truthy ? format.trueLabel : falsy ? format.falseLabel : String(value);
    }
    if (format.kind === "date" || format.kind === "datetime") {
      const date = parseDate(value, format.input);
      if (!date) return String(value);
      const options = { dateStyle: format.style, timeZone: format.timeZone === "UTC" ? "UTC" : undefined };
      if (format.kind === "datetime") options.timeStyle = format.style;
      return new Intl.DateTimeFormat(locale, options).format(date);
    }
    const numeric = finiteNumber(value);
    if (numeric === null) return String(value);
    if (format.kind === "duration") return formatDuration(numeric, format.input, format.style, locale);
    if (format.kind === "percent") return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: format.maximumFractionDigits == null ? 2 : format.maximumFractionDigits }).format(format.input === "whole" ? numeric / 100 : numeric);
    if (format.kind === "currency") return new Intl.NumberFormat(locale, { style: "currency", currency: format.currency, maximumFractionDigits: format.maximumFractionDigits }).format(numeric);
    return new Intl.NumberFormat(locale, {
      notation: format.kind === "compact" ? "compact" : "standard",
      minimumFractionDigits: format.kind === "number" ? format.minimumFractionDigits : undefined,
      maximumFractionDigits: format.maximumFractionDigits,
    }).format(numeric);
  };
  const labelFor = (spec, fieldId, value, locale) => {
    const definition = spec.fields[fieldId];
    if (definition.type === "temporal") {
      const format = definition.format && (definition.format.kind === "date" || definition.format.kind === "datetime")
        ? Object.assign({}, definition.format, { input: "epoch-ms" })
        : { kind: "date", input: "epoch-ms", style: "medium", timeZone: "local" };
      return formatValue(value, format, locale);
    }
    return formatValue(value, definition.format, locale);
  };
  const attachCallbacks = (payload) => {
    const option = payload.option;
    const meta = payload.callbacks;
    const series = Array.isArray(option.series) ? option.series : option.series ? [option.series] : [];
    if (meta.kind === "arc") {
      series[0].tooltip = Object.assign({}, series[0].tooltip, { valueFormatter: (value) => labelFor(payload.spec, meta.valueFieldId, value, payload.locale) });
    } else if (meta.kind === "funnel") {
      series[0].label = Object.assign({}, series[0].label, { formatter: (params) => (params.name || "") + ": " + labelFor(payload.spec, meta.valueFieldId, params.value, payload.locale) });
      series[0].tooltip = Object.assign({}, series[0].tooltip, { valueFormatter: (value) => labelFor(payload.spec, meta.valueFieldId, value, payload.locale) });
    } else if (meta.kind === "boxplot") {
      const yAxis = Array.isArray(option.yAxis) ? option.yAxis[0] : option.yAxis;
      yAxis.axisLabel = Object.assign({}, yAxis.axisLabel, { formatter: (value) => labelFor(payload.spec, meta.valueFieldId, value, payload.locale) });
    } else if (meta.kind === "cartesian") {
      meta.series.forEach((item, index) => {
        if (!series[index]) return;
        series[index].tooltip = Object.assign({}, series[index].tooltip, { valueFormatter: (value) => {
          const tuple = Array.isArray(value) ? value : [];
          return labelFor(payload.spec, item.valueFieldId, tuple[1] == null ? value : tuple[1], payload.locale);
        } });
        if (item.pointSize) series[index].symbolSize = (value) => Math.max(6, Math.min(42, Math.sqrt(finiteNumber(Array.isArray(value) ? value[2] : null) || 0) * 2));
      });
      const xAxis = Array.isArray(option.xAxis) ? option.xAxis[0] : option.xAxis;
      xAxis.axisLabel = Object.assign({}, xAxis.axisLabel, { formatter: (value) => labelFor(payload.spec, meta.xFieldId, value, payload.locale) });
      const yAxes = Array.isArray(option.yAxis) ? option.yAxis : [option.yAxis];
      meta.yAxes.forEach((item, index) => {
        if (!yAxes[index]) return;
        yAxes[index].axisLabel = Object.assign({}, yAxes[index].axisLabel, { formatter: (value) => item.percent
          ? ((finiteNumber(value) || 0) * 100) + "%"
          : labelFor(payload.spec, item.valueFieldId, value, payload.locale) });
      });
    }
    return option;
  };
  if (typeof echarts === "undefined") return;
  const mounted = [];
  charts.forEach((payload) => {
    const host = document.getElementById(payload.elementId);
    if (!host) return;
    try {
      const chart = echarts.init(host, null, { renderer: "svg" });
      chart.setOption(attachCallbacks(payload), { notMerge: true });
      mounted.push({ host, chart });
    } catch (error) {
      host.classList.add("chart-error");
      host.textContent = error instanceof Error ? error.message : String(error);
    }
  });
  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver((entries) => entries.forEach((entry) => {
      const mountedChart = mounted.find((item) => item.host === entry.target);
      if (mountedChart) mountedChart.chart.resize();
    }));
    mounted.forEach((item) => observer.observe(item.host));
  } else {
    window.addEventListener("resize", () => mounted.forEach((item) => item.chart.resize()));
  }
})();</script>`;
}
