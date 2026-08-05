import type { EChartsType } from "echarts/core";
import type { EChartsOption } from "echarts";

let runtimePromise: Promise<typeof import("echarts/core")> | null = null;

async function loadECharts() {
  if (!runtimePromise) {
    runtimePromise = Promise.all([
      import("echarts/core"),
      import("echarts/charts"),
      import("echarts/components"),
      import("echarts/renderers"),
    ]).then(([core, charts, components, renderers]) => {
      core.use([
        charts.BarChart,
        charts.LineChart,
        charts.PieChart,
        charts.FunnelChart,
        components.TitleComponent,
        components.TooltipComponent,
        components.LegendComponent,
        components.GridComponent,
        components.DatasetComponent,
        renderers.SVGRenderer,
      ]);
      return core;
    });
  }
  return runtimePromise;
}

export async function mountEChart(
  host: HTMLElement,
  option: EChartsOption,
  dark?: boolean,
): Promise<EChartsType> {
  const echarts = await loadECharts();
  const useDark = dark ?? document.documentElement.classList.contains("dark");
  const theme = useDark ? "dark" : undefined;
  const chart = echarts.init(host, theme, { renderer: "svg" });
  chart.setOption(option, { notMerge: true });
  return chart;
}
