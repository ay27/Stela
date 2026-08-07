import { useEffect, useState } from "react";
import { Check, Clipboard, Database, Download, Loader2, RefreshCw } from "lucide-react";

import { parseAnalysisCanvas, type AnalysisCanvas, type AnalysisCanvasCard, type AnalysisCanvasSource } from "@shared/analysis-canvas";
import type { StelaChartSpec } from "@shared/chart-spec";
import { StelaChart } from "@/components/charts/stela-chart";
import { renderMarkdown } from "@/components/ai/ai-modal";
import { electronStorage } from "@/services/storage/electron-storage";
import { renderAnalysisCanvasHtml } from "@/services/export-analysis-canvas";
import { scheduleAutoGit } from "@/services/auto-git";
import { useWorkspace } from "@/state/workspace";
import { useT } from "@/i18n/use-t";

function safeHtmlFileName(title: string): string {
  const stem = title.trim().replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return `${stem || "analysis"}.html`;
}

export function AnalysisCanvasView({ tabId, path }: { tabId: string; path: string }) {
  const t = useT();
  const reloadToken = useWorkspace((s) => s.tabs.find((tab) => tab.id === tabId)?.reloadToken ?? 0);
  const [canvas, setCanvas] = useState<AnalysisCanvas | null>(null);
  const [etag, setEtag] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);

  const load = async () => {
    try { const file = await window.stela.canvas.read(path); setCanvas(parseAnalysisCanvas(file.content)); setEtag(file.etag); setError(null); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };
  useEffect(() => { void load(); }, [path, reloadToken]);

  const refresh = async (sourceId: string) => {
    setBusy(sourceId);
    try { const result = await window.stela.canvas.refreshSource(path, etag, sourceId); setCanvas(parseAnalysisCanvas(result.content)); setEtag(result.etag); setError(null); scheduleAutoGit("canvas-refresh"); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(null); }
  };
  const refreshAll = async () => {
    if (!canvas) return;
    let currentEtag = etag;
    setBusy("all");
    try {
      for (const source of canvas.sources) { const result = await window.stela.canvas.refreshSource(path, currentEtag, source.id); currentEtag = result.etag; setCanvas(parseAnalysisCanvas(result.content)); setEtag(result.etag); }
      setError(null);
      scheduleAutoGit("canvas-refresh-all");
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(null); }
  };
  const exportHtml = async () => {
    if (!canvas) return;
    const html = await renderAnalysisCanvasHtml(canvas);
    await window.stela.export.saveFile(safeHtmlFileName(canvas.title), html, { title: t("analysisCanvas.exportTitle"), filters: [{ name: "HTML", extensions: ["html"] }] });
  };

  if (error && !canvas) return <div className="p-8 text-sm text-destructive">{error}</div>;
  if (!canvas) return <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  return <div className="h-full overflow-auto bg-muted/20">
    <div className="mx-auto max-w-[1280px] px-8 py-7">
      {error ? <div className="mb-4 flex items-center justify-between rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive"><span>{error}</span><button className="rounded border border-destructive/30 px-2 py-1" onClick={() => void load()}>{t("common.retry")}</button></div> : null}
      <header className="mb-8 flex items-start justify-between gap-6"><div><div className="text-xs uppercase tracking-wider text-muted-foreground">{t("analysisCanvas.label")} · {t(`analysisCanvas.status.${canvas.status}`)}</div><h1 className="mt-1 text-2xl font-semibold">{canvas.title}</h1><div className="mt-1 text-xs text-muted-foreground">{t("analysisCanvas.updated", { time: new Date(canvas.updatedAt).toLocaleString() })}{canvas.sources.some((source) => source.lastError) ? ` · ${t("analysisCanvas.sourceErrors", { count: canvas.sources.filter((source) => source.lastError).length })}` : ""}</div></div><div className="flex gap-2"><button className="rounded-md border px-3 py-1.5 text-xs" onClick={() => setSourcesOpen(!sourcesOpen)}><Database className="mr-1 inline h-3.5 w-3.5" />{t("analysisCanvas.sources")}</button><button className="rounded-md border px-3 py-1.5 text-xs" disabled={busy !== null} onClick={() => void refreshAll()}>{busy === "all" ? <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 inline h-3.5 w-3.5" />}{t("analysisCanvas.refreshAll")}</button><button className="rounded-md border px-3 py-1.5 text-xs" onClick={() => void exportHtml()}><Download className="mr-1 inline h-3.5 w-3.5" />{t("analysisCanvas.exportHtml")}</button></div></header>
      {sourcesOpen ? <div className="mb-6 space-y-3 rounded-xl border bg-background p-4"><h2 className="font-medium">{t("analysisCanvas.dataSources")}</h2>{canvas.sources.map((source) => <SourceRow key={source.id} source={source} busy={busy === source.id} onRefresh={() => void refresh(source.id)} />)}</div> : null}
      <div className="space-y-10">{canvas.sections.map((section) => <section key={section.id}><h2 className="mb-1 text-xl font-semibold">{section.title}</h2>{section.description ? <p className="mb-4 text-sm text-muted-foreground">{section.description}</p> : null}<div className="grid grid-cols-6 gap-4">{section.cards.map((card) => <CanvasCard key={card.id} card={card} sources={canvas.sources} />)}</div></section>)}</div>
    </div>
  </div>;
}

function SourceRow({ source, busy, onRefresh }: { source: AnalysisCanvasSource; busy: boolean; onRefresh: () => void }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return <details className="rounded-lg border px-3 py-2"><summary className="cursor-pointer text-sm font-medium">{source.title} <span className="font-normal text-muted-foreground">· {source.connectionName}</span></summary><pre className="mt-2 overflow-auto rounded bg-muted p-3 text-xs">{source.sql}</pre><div className="mt-2 flex items-center justify-between text-xs text-muted-foreground"><span>{source.lastRunAt ? new Date(source.lastRunAt).toLocaleString() : t("analysisCanvas.neverRun")}{source.lastError ? ` · ${source.lastError.message}` : ""}</span><div className="flex gap-2"><button title={t("analysisCanvas.copySql")} onClick={() => { window.stela.shell.writeClipboardText(source.sql); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>{copied ? <Check className="h-3.5 w-3.5" /> : <Clipboard className="h-3.5 w-3.5" />}</button><button title={t("analysisCanvas.refreshSource")} disabled={busy} onClick={onRefresh}>{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}</button></div></div></details>;
}

function CanvasCard({ card, sources }: { card: AnalysisCanvasCard; sources: AnalysisCanvasSource[] }) {
  const t = useT();
  const source = card.type === "markdown" ? null : sources.find((item) => item.id === card.sourceId) ?? null;
  const width = card.width === "third" ? "col-span-2" : card.width === "half" ? "col-span-3" : "col-span-6";
  return <article className={`${width} min-w-0 rounded-xl border bg-background p-4 shadow-sm`}><div className="mb-2 flex items-center justify-between"><h3 className="text-sm font-medium">{card.title}</h3>{source ? <span className="text-[10px] text-muted-foreground">{source.title}</span> : null}</div>{card.type === "markdown" ? <div className="text-sm">{renderMarkdown(card.markdown, { charts: false, mermaid: true })}</div> : !source?.lastRunId ? <div className="text-xs text-muted-foreground">{t("analysisCanvas.noSavedResult")}</div> : card.type === "table" ? <CanvasTable runId={source.lastRunId} columns={card.columns} maxRows={card.maxRows} /> : card.type === "kpi" ? <StelaChart spec={{ version: 1, type: "kpi", source: { kind: "run", runId: source.lastRunId }, value: card.value, label: card.label, prefix: card.prefix, suffix: card.suffix } as StelaChartSpec} /> : <StelaChart spec={{ ...card.chart, version: 1, source: { kind: "run", runId: source.lastRunId } } as StelaChartSpec} />}</article>;
}

function CanvasTable({ runId, columns, maxRows }: { runId: string; columns?: string[]; maxRows: number }) {
  const t = useT();
  const [data, setData] = useState<{ names: string[]; rows: unknown[][] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { let alive = true; setData(null); setError(null); void Promise.all([electronStorage.getSchema(runId), electronStorage.queryPage(runId, 0, maxRows)]).then(([schema, page]) => { if (!alive) return; const indexes = columns?.map((name) => schema.findIndex((column) => column.name === name)) ?? schema.map((_, index) => index); if (indexes.some((index) => index < 0)) throw new Error(t("analysisCanvas.missingTableColumn")); setData({ names: indexes.map((index) => schema[index]!.name), rows: page.rows.map((row) => indexes.map((index) => row[index])) }); }).catch((err) => { if (alive) setError(err instanceof Error ? err.message : String(err)); }); return () => { alive = false; }; }, [runId, maxRows, columns?.join("\0"), t]);
  if (error) return <div className="rounded bg-destructive/10 p-2 text-xs text-destructive">{error}</div>;
  if (!data) return <Loader2 className="h-4 w-4 animate-spin" />;
  return <div className="overflow-auto"><table className="w-full text-xs"><thead><tr>{data.names.map((name) => <th key={name} className="border-b p-2 text-left">{name}</th>)}</tr></thead><tbody>{data.rows.map((row, index) => <tr key={index}>{row.map((value, cell) => <td key={cell} className="border-b p-2">{String(value ?? "NULL")}</td>)}</tr>)}</tbody></table></div>;
}
