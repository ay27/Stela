import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Check, CheckCircle2, Clipboard, Database, Download, Loader2, RefreshCw } from "lucide-react";

import {
  parseAnalysisCanvas,
  type AnalysisCanvas,
  type AnalysisCanvasCard,
  type AnalysisCanvasFlowLayoutPatch,
  type AnalysisCanvasSource,
  type FormattedField,
} from "@shared/analysis-canvas";
import type { StelaChartSpec } from "@shared/chart-spec";
import { formatValue } from "@shared/value-format";
import { StelaChart } from "@/components/charts/stela-chart";
import { openCanvasRefreshTask } from "@/components/ai/agent-quick-actions";
import { renderMarkdown } from "@/components/ai/markdown-renderer";
import { i18n } from "@/i18n";
import { electronStorage } from "@/services/storage/electron-storage";
import { renderAnalysisCanvasHtml } from "@/services/export-analysis-canvas";
import { scheduleAutoGit } from "@/services/auto-git";
import { useWorkspace } from "@/state/workspace";
import { useT } from "@/i18n/use-t";

const FlowDiagramCard = lazy(() => import("@/components/flow/flow-diagram-card").then((module) => ({ default: module.FlowDiagramCard })));

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
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [exportedFile, setExportedFile] = useState<{ path: string; revealToken: string } | null>(null);
  const loadGeneration = useRef(0);

  useEffect(() => {
    if (!exportedFile) return;
    const timer = window.setTimeout(() => setExportedFile(null), 10_000);
    return () => window.clearTimeout(timer);
  }, [exportedFile]);

  const load = async () => {
    const generation = ++loadGeneration.current;
    try {
      const file = await window.stela.canvas.read(path);
      const nextCanvas = parseAnalysisCanvas(file.content);
      if (generation !== loadGeneration.current) return;
      setCanvas(nextCanvas);
      setEtag(file.etag);
      setError(null);
    } catch (reason) {
      if (generation !== loadGeneration.current) return;
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    }
  };
  useEffect(() => {
    void load().catch(() => {});
    return () => { loadGeneration.current += 1; };
  }, [path, reloadToken]);

  const saveFlowLayout = async (cardId: string, patch: AnalysisCanvasFlowLayoutPatch) => {
    try {
      const result = await window.stela.canvas.updateFlowLayout(path, etag, cardId, patch);
      setCanvas(parseAnalysisCanvas(result.content));
      setEtag(result.etag);
      setError(null);
      scheduleAutoGit("canvas-flow-layout");
    } catch (reason) {
      await load().catch(() => {});
      throw new Error(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const exportHtml = async () => {
    if (!canvas) return;
    try {
      const html = await renderAnalysisCanvasHtml(canvas);
      const saved = await window.stela.export.saveFile(safeHtmlFileName(canvas.title), html, { title: t("analysisCanvas.exportTitle"), filters: [{ name: "HTML", extensions: ["html"] }] });
      if (!saved.canceled && saved.path && saved.revealToken) {
        setExportedFile({ path: saved.path, revealToken: saved.revealToken });
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  if (error && !canvas) return <div className="p-8 text-sm text-destructive">{error}</div>;
  if (!canvas) return <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  return <div className="h-full overflow-auto bg-muted/20">
    <div className="mx-auto max-w-[1320px] px-5 py-4">
      {error ? <div className="mb-4 flex items-center justify-between rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive"><span>{error}</span><button className="rounded border border-destructive/30 px-2 py-1" onClick={() => void load()}>{t("common.retry")}</button></div> : null}
      <header className="mb-5 flex items-start justify-between gap-4">
        <div><div className="text-[10px] uppercase tracking-wider text-muted-foreground">{t("analysisCanvas.label")} · {t(`analysisCanvas.status.${canvas.status}`)}</div><h1 className="mt-0.5 text-xl font-semibold">{canvas.title}</h1><div className="mt-0.5 text-[11px] text-muted-foreground">{t("analysisCanvas.updated", { time: new Date(canvas.updatedAt).toLocaleString() })}{canvas.sources.some((source) => source.lastError) ? ` · ${t("analysisCanvas.sourceErrors", { count: canvas.sources.filter((source) => source.lastError).length })}` : ""}</div></div>
        <div className="flex gap-2"><button className="rounded-md border px-3 py-1.5 text-xs" onClick={() => setSourcesOpen(!sourcesOpen)}><Database className="mr-1 inline h-3.5 w-3.5" />{t("analysisCanvas.sources")}</button><button className="rounded-md border px-3 py-1.5 text-xs" onClick={() => openCanvasRefreshTask({ canvasPath: path, canvasTitle: canvas.title })}><RefreshCw className="mr-1 inline h-3.5 w-3.5" />{t("analysisCanvas.refreshWithAgent")}</button><button className="rounded-md border px-3 py-1.5 text-xs" onClick={() => void exportHtml()}><Download className="mr-1 inline h-3.5 w-3.5" />{t("analysisCanvas.exportHtml")}</button></div>
      </header>
      {sourcesOpen ? <div className="mb-4 space-y-2 rounded-md border bg-background p-3"><h2 className="text-sm font-medium">{t("analysisCanvas.dataSources")}</h2>{canvas.sources.map((source) => <SourceRow key={source.id} source={source} onRefresh={() => openCanvasRefreshTask({ canvasPath: path, canvasTitle: canvas.title, source })} />)}</div> : null}
      <div className="space-y-6">{canvas.sections.map((section) => <section key={section.id}><h2 className="mb-0.5 text-base font-semibold">{section.title}</h2>{section.description ? <p className="mb-2 text-xs text-muted-foreground">{section.description}</p> : null}<div className="grid grid-cols-6 gap-2.5">{section.cards.map((card) => <CanvasCard key={card.id} card={card} sources={canvas.sources} onSaveFlowLayout={(patch) => saveFlowLayout(card.id, patch)} />)}</div></section>)}</div>
    </div>
    {exportedFile ? (
      <div className="fixed bottom-5 right-5 z-[150] max-w-[min(40rem,calc(100vw-2.5rem))] rounded-lg border border-border bg-popover px-3 py-2 shadow-lg">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 flex-none text-emerald-500" aria-hidden="true" />
          <span className="flex-none text-sm font-medium">{t("common.saved")}</span>
          <button
            type="button"
            onClick={() => void window.stela.export.revealSavedFile(exportedFile.revealToken)}
            className="min-w-0 truncate text-left text-sm text-foreground underline decoration-primary underline-offset-2 transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={exportedFile.path}
          >
            {exportedFile.path}
          </button>
          <button
            type="button"
            onClick={() => setExportedFile(null)}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label={t("settings.close")}
          >
            ×
          </button>
        </div>
      </div>
    ) : null}
  </div>;
}

function SourceRow({ source, onRefresh }: { source: AnalysisCanvasSource; onRefresh: () => void }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return <details className="rounded-sm border px-2.5 py-1.5"><summary className="cursor-pointer text-xs font-medium">{source.title} <span className="font-normal text-muted-foreground">· {source.connectionName}</span></summary><div className="mt-1.5 flex items-center justify-end gap-2"><button title={t("analysisCanvas.copySql")} onClick={() => { window.stela.shell.writeClipboardText(source.sql); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>{copied ? <Check className="h-3.5 w-3.5" /> : <Clipboard className="h-3.5 w-3.5" />}</button><button className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground" title={t("analysisCanvas.refreshSourceWithAgent")} onClick={onRefresh}><RefreshCw className="h-3 w-3" />{t("analysisCanvas.refreshSourceWithAgent")}</button></div><pre className="mt-1.5 overflow-auto rounded-sm bg-muted p-2 text-xs">{source.sql}</pre><div className="mt-1.5 text-[11px] text-muted-foreground">{source.lastRunAt ? new Date(source.lastRunAt).toLocaleString() : t("analysisCanvas.neverRun")}{source.lastError ? ` · ${source.lastError.message}` : ""}</div></details>;
}

function CanvasCard({ card, sources, onSaveFlowLayout }: { card: AnalysisCanvasCard; sources: AnalysisCanvasSource[]; onSaveFlowLayout: (patch: AnalysisCanvasFlowLayoutPatch) => Promise<void> }) {
  const t = useT();
  const source = card.type === "kpi" || card.type === "chart" || card.type === "table" ? sources.find((item) => item.id === card.sourceId) ?? null : null;
  const width = card.width === "third" ? "col-span-2" : card.width === "half" ? "col-span-3" : "col-span-6";
  let body: React.ReactNode;
  if (card.type === "markdown") body = <div className="text-sm">{renderMarkdown(card.markdown, { charts: false })}</div>;
  else if (card.type === "flow") body = <Suspense fallback={<div className="flex h-[440px] items-center justify-center"><Loader2 className="h-4 w-4 animate-spin" /></div>}><FlowDiagramCard card={card} onSave={onSaveFlowLayout} /></Suspense>;
  else if (!source?.lastRunId) body = <div className="text-xs text-muted-foreground">{t("analysisCanvas.noSavedResult")}</div>;
  else if (card.type === "table") body = <CanvasTable runId={source.lastRunId} columns={card.columns} maxRows={card.maxRows} />;
  else if (card.type === "kpi") body = <CanvasKpi runId={source.lastRunId} value={card.value} label={card.label ?? card.title} prefix={card.prefix} suffix={card.suffix} />;
  else body = <StelaChart className="rounded-sm border-0 p-0" spec={{ ...card.chart, version: 2, source: { kind: "run", runId: source.lastRunId } } as StelaChartSpec} />;
  return <article className={`${width} min-w-0 rounded-md border bg-background p-3`}><div className="mb-1.5 flex items-center justify-between"><h3 className="text-xs font-medium">{card.title}</h3>{source ? <span className="text-[10px] text-muted-foreground">{source.title}</span> : null}</div>{body}</article>;
}

function CanvasKpi({ runId, value, label, prefix, suffix }: { runId: string; value: FormattedField; label?: string; prefix?: string; suffix?: string }) {
  const [data, setData] = useState<{ value: unknown } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    void Promise.all([electronStorage.getSchema(runId), electronStorage.queryPage(runId, 0, 2)]).then(([schema, page]) => {
      if (!alive) return;
      const index = schema.findIndex((column) => column.name === value.field);
      if (index < 0 || page.rows.length !== 1) throw new Error("The KPI field is missing or the result does not contain exactly one row.");
      setData({ value: page.rows[0]?.[index] });
    }).catch((reason) => { if (alive) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { alive = false; };
  }, [runId, value.field]);
  if (error) return <div className="rounded bg-destructive/10 p-2 text-xs text-destructive">{error}</div>;
  if (!data) return <Loader2 className="h-4 w-4 animate-spin" />;
  return <div className="flex min-h-32 flex-col items-center justify-center rounded-sm border bg-card p-4"><div className="text-[11px] text-muted-foreground">{label ?? value.title ?? value.field}</div><div className="mt-1.5 text-3xl font-semibold tracking-tight">{prefix}{formatValue(data.value, value.format, i18n.language)}{suffix}</div></div>;
}

function CanvasTable({ runId, columns, maxRows }: { runId: string; columns?: FormattedField[]; maxRows: number }) {
  const t = useT();
  const [data, setData] = useState<{ fields: FormattedField[]; rows: unknown[][] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    void Promise.all([electronStorage.getSchema(runId), electronStorage.queryPage(runId, 0, maxRows)]).then(([schema, page]) => {
      if (!alive) return;
      const fields = columns ?? schema.map((column) => ({ field: column.name }));
      const indexes = fields.map((field) => schema.findIndex((column) => column.name === field.field));
      if (indexes.some((index) => index < 0)) throw new Error(t("analysisCanvas.missingTableColumn"));
      setData({ fields, rows: page.rows.map((row) => indexes.map((index) => row[index])) });
    }).catch((reason) => { if (alive) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { alive = false; };
  }, [runId, maxRows, JSON.stringify(columns), t]);
  if (error) return <div className="rounded bg-destructive/10 p-2 text-xs text-destructive">{error}</div>;
  if (!data) return <Loader2 className="h-4 w-4 animate-spin" />;
  return <div className="overflow-auto"><table className="w-full text-xs"><thead><tr>{data.fields.map((field) => <th key={field.field} className="border-b p-2 text-left">{field.title ?? field.field}</th>)}</tr></thead><tbody>{data.rows.map((row, index) => <tr key={index}>{row.map((value, cell) => <td key={cell} className="border-b p-2">{formatValue(value, data.fields[cell]?.format, i18n.language)}</td>)}</tr>)}</tbody></table></div>;
}
