import type { AnalysisCanvas, AnalysisCanvasCard } from "@shared/analysis-canvas";
import type { StelaChartSpec } from "@shared/chart-spec";
import { electronStorage } from "@/services/storage/electron-storage";
import { renderStelaChartSvg } from "@/components/charts/chart-export";
import { loadStelaChartData } from "@/components/charts/chart-data";
import { renderMermaid } from "@/editor/mermaid/render";

function esc(value: unknown): string {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function renderMarkdownCard(markdown: string, idPrefix: string): Promise<string> {
  const fence = /```mermaid[ \t]*\r?\n([\s\S]*?)```/gi;
  let cursor = 0;
  let index = 0;
  let html = "";
  for (let match = fence.exec(markdown); match; match = fence.exec(markdown)) {
    html += esc(markdown.slice(cursor, match.index)).replace(/\r?\n/g, "<br>");
    const source = (match[1] ?? "").trim();
    try {
      if (!source) throw new Error("The Mermaid flowchart is empty.");
      html += await renderMermaid(`${idPrefix}-${index++}-${crypto.randomUUID()}`, source);
    } catch (error) {
      html += `<div class="error">${esc(error instanceof Error ? error.message : String(error))}</div>`;
    }
    cursor = match.index + match[0].length;
  }
  return html + esc(markdown.slice(cursor)).replace(/\r?\n/g, "<br>");
}

async function cardHtml(card: AnalysisCanvasCard, canvas: AnalysisCanvas): Promise<string> {
  const span = card.width === "third" ? 4 : card.width === "half" ? 6 : 12;
  const open = `<article class="card" style="grid-column:span ${span}">`;
  if (card.type === "markdown") return `${open}<h2>${esc(card.title ?? "")}</h2><div>${await renderMarkdownCard(card.markdown, `stela-canvas-export-${canvas.id}-${card.id}`)}</div></article>`;
  const source = canvas.sources.find((item) => item.id === card.sourceId);
  if (!source?.lastRunId) return `${open}<div class="error">No saved result for ${esc(source?.title ?? card.sourceId)}</div></article>`;
  try {
    if (card.type === "chart") {
      const spec = { ...card.chart, version: 1, source: { kind: "run", runId: source.lastRunId } } as StelaChartSpec;
      const data = await loadStelaChartData(spec);
      return `${open}<h2>${esc(card.title ?? card.chart.title ?? source.title)}</h2>${await renderStelaChartSvg(spec, data)}</article>`;
    }
    const [schema, page] = await Promise.all([
      electronStorage.getSchema(source.lastRunId),
      electronStorage.queryPage(source.lastRunId, 0, card.type === "table" ? card.maxRows : 1),
    ]);
    const loaded = { schema, rows: page.rows };
    if (card.type === "table") {
      const indexes = card.columns?.map((name) => loaded.schema.findIndex((column) => column.name === name)) ?? loaded.schema.map((_, index) => index);
      if (indexes.some((index) => index < 0)) throw new Error("A configured table column is missing from the latest result.");
      const heads = indexes.map((index) => `<th>${esc(loaded.schema[index]?.name ?? "")}</th>`).join("");
      const rows = loaded.rows.map((row) => `<tr>${indexes.map((index) => `<td>${esc(row[index])}</td>`).join("")}</tr>`).join("");
      return `${open}<h2>${esc(card.title ?? source.title)}</h2><table><thead><tr>${heads}</tr></thead><tbody>${rows}</tbody></table></article>`;
    }
    if (card.type === "kpi") {
      const index = loaded.schema.findIndex((column) => column.name === card.value);
      if (index < 0 || loaded.rows.length !== 1) throw new Error("The KPI field is missing or the result does not contain exactly one row.");
      return `<article class="card kpi" style="grid-column:span ${span}"><div>${esc(card.label ?? card.title ?? card.value)}</div><strong>${esc(card.prefix ?? "")}${esc(loaded.rows[0]?.[index])}${esc(card.suffix ?? "")}</strong></article>`;
    }
    throw new Error(`Unsupported Canvas card type: ${(card as { type: string }).type}`);
  } catch (error) {
    return `${open}<div class="error">${esc(error instanceof Error ? error.message : String(error))}</div></article>`;
  }
}

export async function renderAnalysisCanvasHtml(canvas: AnalysisCanvas): Promise<string> {
  const sections = await Promise.all(canvas.sections.map(async (section) => `<section><h1>${esc(section.title)}</h1>${section.description ? `<p>${esc(section.description)}</p>` : ""}<div class="grid">${(await Promise.all(section.cards.map((card) => cardHtml(card, canvas)))).join("")}</div></section>`));
  const sources = canvas.sources.map((source) => `<details><summary>${esc(source.title)} · ${esc(source.connectionName)}</summary><pre><code>${esc(source.sql)}</code></pre><small>${source.lastRunAt ? new Date(source.lastRunAt).toISOString() : "Never run"}</small></details>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(canvas.title)}</title><style>body{font:14px system-ui;margin:0 auto;max-width:1200px;padding:40px;color:#18202b}header{margin-bottom:40px}.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:16px}.card{grid-column:span 12;border:1px solid #d9dee7;border-radius:12px;padding:18px;overflow:auto}.kpi strong{display:block;font-size:34px;margin-top:8px}.error{color:#a22626;background:#fff5f5}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #ddd;padding:7px;text-align:left}svg{max-width:100%;height:auto}details{margin:10px 0}pre{overflow:auto;background:#f5f6f8;padding:12px;border-radius:8px}@media(max-width:800px){body{padding:20px}.card{grid-column:span 12!important}}</style></head><body><header><h1>${esc(canvas.title)}</h1><p>Snapshot exported ${new Date().toISOString()}</p></header>${sections.join("")}<section><h1>Sources</h1>${sources}</section></body></html>`;
}
