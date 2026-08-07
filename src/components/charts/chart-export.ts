import type { StelaChartSpec } from "@shared/chart-spec";

import type { StelaChartData } from "./chart-data";
import { buildStelaChartOption } from "./chart-option";
import { mountEChart } from "./echarts-runtime";
import { i18n } from "@/i18n";

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
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-10000px;top:0;width:1200px;height:675px;background:white";
  document.body.appendChild(host);
  const chart = await mountEChart(host, buildStelaChartOption(spec, data.columns, data.rows, false, i18n.language), false);
  try {
    return decodeSvgUrl(chart.getDataURL({ type: "svg", pixelRatio: 1, backgroundColor: "#ffffff" }));
  } finally {
    chart.dispose();
    host.remove();
  }
}
