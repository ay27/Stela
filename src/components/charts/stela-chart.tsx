import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Download, Loader2 } from "lucide-react";
import type { EChartsType } from "echarts/core";

import { cn } from "@/lib/utils";
import { useT } from "@/i18n/use-t";
import type { StelaChartSpec } from "@shared/chart-spec";
import { toFiniteChartNumber } from "@shared/chart-spec";

import { loadStelaChartData, type StelaChartData } from "./chart-data";
import { buildStelaChartOption } from "./chart-option";
import { mountEChart } from "./echarts-runtime";

export interface StelaChartProps {
  spec: StelaChartSpec;
  previousRunId?: string | null;
  className?: string;
  onExportSvg?: (svg: string, title: string) => void | Promise<void>;
}

function kpiText(spec: Extract<StelaChartSpec, { type: "kpi" }>, data: StelaChartData) {
  const indexes = new Map(data.columns.map((column, index) => [column.name, index]));
  const row = data.rows[0] ?? [];
  const value = row[indexes.get(spec.value)!];
  const numeric = toFiniteChartNumber(value);
  return {
    label: spec.label ? String(row[indexes.get(spec.label)!] ?? spec.label) : spec.title ?? spec.value,
    value: `${spec.prefix ?? ""}${numeric === null ? String(value ?? "NULL") : numeric.toLocaleString()}${spec.suffix ?? ""}`,
  };
}

export function StelaChart({ spec, previousRunId, className, onExportSvg }: StelaChartProps) {
  const t = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<EChartsType | null>(null);
  const [data, setData] = useState<StelaChartData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const key = JSON.stringify(spec);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setDark(document.documentElement.classList.contains("dark"));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void loadStelaChartData(spec, previousRunId)
      .then((next) => {
        if (!cancelled) setData(next);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [key, previousRunId]);

  const option = useMemo(
    () => data && spec.type !== "kpi" ? buildStelaChartOption(spec, data.columns, data.rows, dark) : null,
    [data, key, dark],
  );

  useEffect(() => {
    if (!hostRef.current || !option) return;
    let disposed = false;
    let observer: ResizeObserver | null = null;
    void mountEChart(hostRef.current, option, dark).then((chart) => {
      if (disposed) {
        chart.dispose();
        return;
      }
      chartRef.current = chart;
      observer = new ResizeObserver(() => chart.resize());
      observer.observe(hostRef.current!);
    });
    return () => {
      disposed = true;
      observer?.disconnect();
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, [option, dark]);

  const exportSvg = async () => {
    if (!onExportSvg || !chartRef.current) return;
    setExporting(true);
    try {
      const url = chartRef.current.getDataURL({ type: "svg", pixelRatio: 1, backgroundColor: "transparent" });
      const comma = url.indexOf(",");
      const body = url.slice(comma + 1);
      const svg = url.slice(0, comma).includes(";base64") ? atob(body) : decodeURIComponent(body);
      await onExportSvg(svg, spec.title ?? spec.type);
    } finally {
      setExporting(false);
    }
  };

  if (loading) {
    return <div className={cn("flex h-56 items-center justify-center text-xs text-muted-foreground", className)}><Loader2 className="mr-2 h-4 w-4 animate-spin" />{t("chart.loading")}</div>;
  }
  if (error || !data) {
    return <div className={cn("flex min-h-28 items-center justify-center rounded-md border border-destructive/30 bg-destructive/5 p-4 text-xs text-destructive", className)}><AlertCircle className="mr-2 h-4 w-4 flex-none" /><span>{error ?? t("chart.noData")}</span></div>;
  }
  if (spec.type === "kpi") {
    const kpi = kpiText(spec, data);
    return <div className={cn("flex min-h-40 flex-col items-center justify-center rounded-lg border border-border bg-card p-6", className)}><div className="text-xs text-muted-foreground">{kpi.label}</div><div className="mt-2 text-4xl font-semibold tracking-tight">{kpi.value}</div></div>;
  }

  return (
    <div className={cn("relative w-full rounded-lg border border-border bg-card p-2", className)}>
      {onExportSvg ? <button type="button" onClick={() => void exportSvg()} disabled={exporting} className="absolute right-2 top-2 z-10 rounded-md border border-border bg-background/90 p-1.5 text-muted-foreground hover:text-foreground" title={t("chart.exportSvg")}><Download className="h-3.5 w-3.5" /></button> : null}
      <div ref={hostRef} className="h-80 w-full" role="img" aria-label={spec.description ?? spec.title ?? `${spec.type} chart`} />
    </div>
  );
}
