import type { StelaChartSpec } from "@shared/chart-spec";
import { toFiniteChartNumber } from "@shared/chart-spec";

import type { StelaChartData } from "./chart-data";
import { buildStelaChartOption } from "./chart-option";
import { mountEChart } from "./echarts-runtime";

function escapeXml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  })[char]!);
}

function decodeSvgUrl(url: string): string {
  const comma = url.indexOf(",");
  if (comma < 0) throw new Error("ECharts returned an invalid SVG URL.");
  const body = url.slice(comma + 1);
  return url.slice(0, comma).includes(";base64") ? atob(body) : decodeURIComponent(body);
}

export async function renderStelaChartSvg(
  spec: StelaChartSpec,
  data: StelaChartData,
): Promise<string> {
  if (spec.type === "kpi") {
    const indexes = new Map(data.columns.map((column, index) => [column.name, index]));
    const row = data.rows[0] ?? [];
    const raw = row[indexes.get(spec.value)!];
    const numeric = toFiniteChartNumber(raw);
    const label = spec.label ? row[indexes.get(spec.label)!] : spec.title ?? spec.value;
    const value = `${spec.prefix ?? ""}${numeric === null ? String(raw ?? "NULL") : numeric.toLocaleString()}${spec.suffix ?? ""}`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675" role="img" aria-label="${escapeXml(label)}"><rect width="1200" height="675" rx="20" fill="#ffffff" stroke="#e4e4e7"/><text x="600" y="285" text-anchor="middle" fill="#71717a" font-family="Inter,system-ui,sans-serif" font-size="26">${escapeXml(label)}</text><text x="600" y="380" text-anchor="middle" fill="#18181b" font-family="Inter,system-ui,sans-serif" font-size="68" font-weight="600">${escapeXml(value)}</text></svg>`;
  }

  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-10000px;top:0;width:1200px;height:675px;background:white";
  document.body.appendChild(host);
  const chart = await mountEChart(host, buildStelaChartOption(spec, data.columns, data.rows, false), false);
  try {
    return decodeSvgUrl(chart.getDataURL({ type: "svg", pixelRatio: 1, backgroundColor: "#ffffff" }));
  } finally {
    chart.dispose();
    host.remove();
  }
}
