import type { AnalysisCanvas, AnalysisCanvasCard, FormattedField } from "@shared/analysis-canvas";
import type { StelaChartSpec } from "@shared/chart-spec";
import { formatValue } from "@shared/value-format";
import { electronStorage } from "@/services/storage/electron-storage";
import { loadStelaChartData } from "@/components/charts/chart-data";
import { buildFlowScene, layoutFlowCard, type FlowCard } from "@/components/flow/flow-layout";
import { i18n } from "@/i18n";
import {
  buildInteractiveChartExport,
  renderInteractiveChartScripts,
  type InteractiveChartExport,
} from "@/services/export-analysis-canvas-charts";

function esc(value: unknown): string {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderMarkdownCard(markdown: string): string {
  return esc(markdown).replace(/```[^\n]*\n([\s\S]*?)```/g, "<pre><code>$1</code></pre>").replace(/\r?\n/g, "<br>");
}

function flowTone(tone: FlowCard["nodes"][number]["tone"], kind: FlowCard["nodes"][number]["kind"]): string {
  const resolved = tone ?? (kind === "source" ? "info" : kind === "result" ? "success" : "neutral");
  return `flow-${resolved}`;
}

async function renderFlowCard(card: FlowCard): Promise<string> {
  const nodes = await layoutFlowCard(card, true);
  if (nodes.length === 0) return '<div class="flow-empty">Empty flow</div>';
  const markerId = `flow-arrow-${card.id}`;
  const scene = buildFlowScene(card, nodes);
  const edges = scene.edges.map(({ edge, path, labelPosition }) => {
    const tone = edge.tone ? ` flow-edge-${edge.tone}` : "";
    const label = edge.label ? `<text x="${labelPosition.x}" y="${labelPosition.y}" text-anchor="middle">${esc(edge.label)}</text>` : "";
    return `<path class="flow-edge${tone}" d="${path}" marker-end="url(#${markerId})"/>${label}`;
  }).join("");
  const nodeHtml = scene.nodes.map((node) => `<div class="flow-node ${flowTone(node.tone, node.kind)} ${node.kind === "decision" ? "flow-decision" : node.kind === "note" ? "flow-note" : ""}" style="left:${node.position.x}px;top:${node.position.y}px;width:${node.size.width}px;height:${node.size.height}px"><strong>${esc(node.label)}</strong>${node.description ? `<small>${esc(node.description)}</small>` : ""}</div>`).join("");
  return `<div class="flow-scroll"><div class="flow" style="width:${scene.width}px;height:${scene.height}px"><svg width="${scene.width}" height="${scene.height}" viewBox="0 0 ${scene.width} ${scene.height}"><defs><marker id="${markerId}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"/></marker></defs>${edges}</svg>${nodeHtml}</div></div>`;
}

async function loadFields(runId: string, fields: FormattedField[], maxRows: number) {
  const [schema, page] = await Promise.all([electronStorage.getSchema(runId), electronStorage.queryPage(runId, 0, maxRows)]);
  const indexes = fields.map((field) => schema.findIndex((column) => column.name === field.field));
  if (indexes.some((index) => index < 0)) throw new Error("A configured field is missing from the latest result.");
  return { fields, rows: page.rows.map((row) => indexes.map((index) => row[index])) };
}

async function cardHtml(
  card: AnalysisCanvasCard,
  canvas: AnalysisCanvas,
  charts: InteractiveChartExport[],
): Promise<string> {
  const span = card.width === "third" ? 4 : card.width === "half" ? 6 : 12;
  const open = `<article class="card" style="grid-column:span ${span}">`;
  if (card.type === "markdown") return `${open}<h2>${esc(card.title ?? "")}</h2><div>${renderMarkdownCard(card.markdown)}</div></article>`;
  if (card.type === "flow") return `${open}<h2>${esc(card.title ?? "")}</h2>${await renderFlowCard(card)}</article>`;
  const source = canvas.sources.find((item) => item.id === card.sourceId);
  if (!source?.lastRunId) return `${open}<div class="error">No saved result for ${esc(source?.title ?? card.sourceId)}</div></article>`;
  try {
    if (card.type === "chart") {
      const spec = { ...card.chart, version: 2, source: { kind: "run", runId: source.lastRunId } } as StelaChartSpec;
      const data = await loadStelaChartData(spec);
      const elementId = `stela-chart-${card.id}`;
      charts.push(buildInteractiveChartExport(elementId, spec, data, i18n.language));
      return `${open}<h2>${esc(card.title ?? card.chart.title ?? source.title)}</h2><div id="${esc(elementId)}" class="chart-host" role="img" aria-label="${esc(card.chart.description ?? card.chart.title ?? card.title ?? source.title)}"></div></article>`;
    }
    const schema = await electronStorage.getSchema(source.lastRunId);
    if (card.type === "table") {
      const fields = card.columns ?? schema.map((column) => ({ field: column.name }));
      const loaded = await loadFields(source.lastRunId, fields, card.maxRows);
      const heads = loaded.fields.map((field) => `<th>${esc(field.title ?? field.field)}</th>`).join("");
      const rows = loaded.rows.map((row) => `<tr>${row.map((value, index) => `<td>${esc(formatValue(value, loaded.fields[index]?.format, i18n.language))}</td>`).join("")}</tr>`).join("");
      return `${open}<h2>${esc(card.title ?? source.title)}</h2><table><thead><tr>${heads}</tr></thead><tbody>${rows}</tbody></table></article>`;
    }
    const loaded = await loadFields(source.lastRunId, [card.value], 2);
    if (loaded.rows.length !== 1) throw new Error("The KPI result does not contain exactly one row.");
    const value = `${card.prefix ?? ""}${formatValue(loaded.rows[0]?.[0], card.value.format, i18n.language)}${card.suffix ?? ""}`;
    return `<article class="card kpi" style="grid-column:span ${span}"><div>${esc(card.label ?? card.title ?? card.value.title ?? card.value.field)}</div><strong>${esc(value)}</strong></article>`;
  } catch (error) {
    return `${open}<div class="error">${esc(error instanceof Error ? error.message : String(error))}</div></article>`;
  }
}

export async function renderAnalysisCanvasHtml(canvas: AnalysisCanvas): Promise<string> {
  const charts: InteractiveChartExport[] = [];
  const sections = await Promise.all(canvas.sections.map(async (section) => `<section><h1>${esc(section.title)}</h1>${section.description ? `<p>${esc(section.description)}</p>` : ""}<div class="grid">${(await Promise.all(section.cards.map((card) => cardHtml(card, canvas, charts)))).join("")}</div></section>`));
  const sources = canvas.sources.map((source) => `<details><summary>${esc(source.title)} · ${esc(source.connectionName)}</summary><pre><code>${esc(source.sql)}</code></pre><small>${source.lastRunAt ? new Date(source.lastRunAt).toISOString() : "Never run"}</small></details>`).join("");
  const echartsSource = charts.length > 0 ? (await import("echarts/dist/echarts.min.js?raw")).default : "";
  const chartScripts = renderInteractiveChartScripts(charts, echartsSource);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(canvas.title)}</title><style>body{font:14px system-ui;margin:0 auto;max-width:1200px;padding:28px;color:#18202b}header{margin-bottom:24px}.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:10px}.card{grid-column:span 12;min-width:0;border:1px solid #d9dee7;border-radius:6px;padding:12px;overflow:auto}.card h2{font-size:14px;margin:0 0 8px}.kpi strong{display:block;font-size:34px;margin-top:6px}.error,.chart-error{color:#a22626;background:#fff5f5}.chart-host{width:100%;height:320px;min-width:0}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #ddd;padding:6px;text-align:left}svg{max-width:100%;height:auto}details{margin:8px 0}pre{overflow:auto;background:#f5f6f8;padding:10px;border-radius:4px}.flow-scroll{overflow:auto}.flow{position:relative;background:#fff;border:1px solid #e4e4e7;border-radius:4px}.flow>svg{position:absolute;inset:0}.flow-edge{fill:none;stroke:#71717a;stroke-width:1.5}.flow-edge-danger{stroke:#dc2626}.flow-edge-success{stroke:#059669}.flow-edge-warning{stroke:#d97706}.flow text{font-size:11px;fill:#52525b}.flow-node{box-sizing:border-box;position:absolute;display:flex;flex-direction:column;align-items:center;justify-content:center;border:1px solid #d4d4d8;border-radius:6px;background:white;padding:10px;text-align:center}.flow-node small{display:block;margin-top:5px;color:#71717a}.flow-info{border-color:#60a5fa;background:#eff6ff}.flow-success{border-color:#34d399;background:#ecfdf5}.flow-warning{border-color:#fbbf24;background:#fffbeb}.flow-danger{border-color:#f87171;background:#fef2f2}.flow-decision{border-radius:16px}.flow-note{border-style:dashed}@media(max-width:800px){body{padding:16px}.card{grid-column:span 12!important}}</style></head><body><header><h1>${esc(canvas.title)}</h1><p>Snapshot exported ${new Date().toISOString()}</p></header>${sections.join("")}<section><h1>Sources</h1>${sources}</section>${chartScripts}</body></html>`;
}
