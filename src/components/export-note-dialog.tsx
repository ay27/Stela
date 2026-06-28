/**
 * 导出笔记为 Markdown 对话框。
 *
 * 让用户选择「每个 RunSQL 结果块导出前 N 行」，确认后调用
 * `exportNoteToMarkdown`，弹原生 Save 对话框写出目标文件。
 *
 * 状态通过 `useDialogs.exportNoteFilePath` 驱动（null → 关闭）。
 */

import * as Dialog from "@radix-ui/react-dialog";
import { Download, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  EXPORT_ROW_CAP_OPTIONS,
  exportNoteToMarkdown,
  parseRunsqlBlocks,
  type ExportMarkdownLabels,
  type ExportRowCap,
  type ExportRunScope,
} from "@/services/export-note";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n/use-t";

function selectValueToRowCap(v: string): ExportRowCap {
  if (v === "all") return null;
  return Number(v) as ExportRowCap;
}

// ─── 结果范围选项 ─────────────────────────────────────────────────────────────

function selectValueToRunScope(v: string): ExportRunScope {
  if (v === "latest") return { kind: "latest" };
  if (v === "all") return { kind: "all" };
  const count = Number(v.replace("recent-", ""));
  return { kind: "recent", count };
}

// ─── 组件 ─────────────────────────────────────────────────────────────────────

interface ExportNoteDialogProps {
  filePath: string | null;
  onClose: () => void;
}

type ExportState = "idle" | "counting" | "exporting" | "done" | "error";

function basename(p: string): string {
  return p.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? p;
}

export function ExportNoteDialog({ filePath, onClose }: ExportNoteDialogProps) {
  const t = useT();
  const open = filePath !== null;

  const [rowCapStr, setRowCapStr] = useState<string>("10");
  const [runScopeStr, setRunScopeStr] = useState<string>("latest");
  const [includeDiffSummary, setIncludeDiffSummary] = useState<boolean>(false);
  const [blockCount, setBlockCount] = useState<number | null>(null);
  const [exportState, setExportState] = useState<ExportState>("idle");
  const [statusMsg, setStatusMsg] = useState<string>("");
  const abortRef = useRef(false);

  // 打开时扫描 RunSQL 块数
  useEffect(() => {
    if (!open || !filePath) {
      setBlockCount(null);
      setExportState("idle");
      setStatusMsg("");
      return;
    }
    abortRef.current = false;
    setExportState("counting");

    window.stela.vault.readFile(filePath)
      .then((md) => {
        if (abortRef.current) return;
        const blocks = parseRunsqlBlocks(md);
        setBlockCount(blocks.length);
        setExportState("idle");
      })
      .catch(() => {
        if (abortRef.current) return;
        setBlockCount(null);
        setExportState("idle");
      });

    return () => { abortRef.current = true; };
  }, [open, filePath]);

  const rowCap = useMemo(() => selectValueToRowCap(rowCapStr), [rowCapStr]);
  const runScope = useMemo(() => selectValueToRunScope(runScopeStr), [runScopeStr]);
  const isMultiHistory = runScope.kind !== "latest";
  const exportMarkdownLabels = useMemo<ExportMarkdownLabels>(
    () => ({
      noResult: t("exportNote.markdown.noResult"),
      resultTitle: t("exportNote.markdown.resultTitle"),
      rowSummary: (visible, total) =>
        visible !== null && total > visible
          ? t("exportNote.markdown.rowSummary.truncated", { visible, total })
          : t("exportNote.markdown.rowSummary.total", { total }),
      latestPrefix: t("exportNote.markdown.latestPrefix"),
      historySummary: (count) =>
        t("exportNote.markdown.historySummary", { count }),
      executionFailed: (reason) =>
        t("exportNote.markdown.executionFailed", { reason }),
      missingData: (runId) => t("exportNote.markdown.missingData", { runId }),
      diffTitle: (previousTime, latestTime) =>
        t("exportNote.markdown.diffTitle", { previousTime, latestTime }),
      diffStats: (added, removed, changed) =>
        t("exportNote.markdown.diffStats", { added, removed, changed }),
      schemaMismatch: t("exportNote.markdown.schemaMismatch"),
      diffColumnHeader: t("exportNote.markdown.diffColumnHeader"),
      diffBaselineHeader: t("exportNote.markdown.diffBaselineHeader"),
      diffCurrentHeader: t("exportNote.markdown.diffCurrentHeader"),
      diffStatusHeader: t("exportNote.markdown.diffStatusHeader"),
    }),
    [t],
  );
  const rowCapOptions = useMemo(
    () =>
      EXPORT_ROW_CAP_OPTIONS.map((cap) => {
        const label = cap === null ? t("exportNote.rowCap.all") : String(cap);
        return {
          value: cap === null ? "all" : String(cap),
          label,
          labelText: label,
        };
      }),
    [t],
  );
  const runScopeOptions = useMemo(
    () => [
      {
        value: "latest",
        label: t("exportNote.runScope.latest"),
        labelText: t("exportNote.runScope.latest"),
      },
      {
        value: "recent-3",
        label: t("exportNote.runScope.recent", { count: 3 }),
        labelText: t("exportNote.runScope.recent", { count: 3 }),
      },
      {
        value: "recent-5",
        label: t("exportNote.runScope.recent", { count: 5 }),
        labelText: t("exportNote.runScope.recent", { count: 5 }),
      },
      {
        value: "recent-10",
        label: t("exportNote.runScope.recent", { count: 10 }),
        labelText: t("exportNote.runScope.recent", { count: 10 }),
      },
      {
        value: "all",
        label: t("exportNote.runScope.all"),
        labelText: t("exportNote.runScope.all"),
      },
    ],
    [t],
  );

  const handleExport = useCallback(async () => {
    if (!filePath || exportState === "exporting") return;
    setExportState("exporting");
    setStatusMsg(t("exportNote.status.exporting"));
    try {
      const result = await exportNoteToMarkdown({
        filePath,
        rowCap,
        runScope,
        includeDiffSummary: isMultiHistory && includeDiffSummary,
        saveDialogTitle: t("exportNote.saveDialogTitle"),
        labels: exportMarkdownLabels,
      });
      if (result.canceled) {
        setExportState("idle");
        setStatusMsg("");
        return;
      }
      const fileName = result.savedPath
        ? basename(result.savedPath)
        : t("exportNote.status.fileFallback");
      const warn = result.failedBlocks > 0
        ? t("exportNote.status.failedBlocks", {
            count: result.failedBlocks,
          })
        : "";
      setExportState("done");
      setStatusMsg(t("exportNote.status.saved", { fileName, warn }));
    } catch (err) {
      setExportState("error");
      setStatusMsg(
        err instanceof Error ? err.message : t("exportNote.status.failed"),
      );
    }
  }, [
    filePath,
    rowCap,
    runScope,
    includeDiffSummary,
    isMultiHistory,
    exportState,
    t,
    exportMarkdownLabels,
  ]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      abortRef.current = true;
      onClose();
    }
  };

  const fileName = filePath ? basename(filePath) : "";

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-[420px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 flex flex-col",
            "overflow-hidden rounded-lg border border-border bg-background text-foreground shadow-2xl",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          )}
          aria-describedby="export-note-desc"
        >
          {/* 标题栏 */}
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div>
              <Dialog.Title className="text-sm font-semibold">
                {t("exportNote.title")}
              </Dialog.Title>
              <Dialog.Description
                id="export-note-desc"
                className="mt-0.5 text-xs text-muted-foreground"
              >
                {fileName}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded-md p-1.5 text-muted-foreground hover:bg-accent"
                aria-label={t("exportNote.close")}
              >
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </div>

          {/* 内容区 */}
          <div className="flex flex-col gap-4 px-4 py-4">
            {/* RunSQL 块统计 */}
            <div className="rounded-md bg-muted/50 px-3 py-2.5 text-xs text-muted-foreground">
              {exportState === "counting" ? (
                t("exportNote.counting")
              ) : blockCount === null ? (
                t("exportNote.readFailed")
              ) : blockCount === 0 ? (
                t("exportNote.noRunsql")
              ) : (
                t("exportNote.blockCount", { count: blockCount })
              )}
            </div>

            {/* 行数选择 */}
            {blockCount !== null && blockCount > 0 ? (
              <div className="flex items-center gap-3">
                <span className="flex-none text-xs text-muted-foreground">
                  {t("exportNote.rowCap.label")}
                </span>
                <Select<string>
                  value={rowCapStr}
                  onValueChange={setRowCapStr}
                  options={rowCapOptions}
                  size="sm"
                  disabled={exportState === "exporting"}
                  className="w-20"
                  contentClassName="z-[100]"
                />
                <span className="text-xs text-muted-foreground">
                  {t("exportNote.rowCap.suffix")}
                </span>
              </div>
            ) : null}

            {/* 结果范围选择 */}
            {blockCount !== null && blockCount > 0 ? (
              <div className="flex items-center gap-3">
                <span className="flex-none text-xs text-muted-foreground">
                  {t("exportNote.runScope.label")}
                </span>
                <Select<string>
                  value={runScopeStr}
                  onValueChange={setRunScopeStr}
                  options={runScopeOptions}
                  size="sm"
                  disabled={exportState === "exporting"}
                  className="w-28"
                  contentClassName="z-[100]"
                />
              </div>
            ) : null}

            {/* 多历史时的 diff 摘要开关 */}
            {blockCount !== null && blockCount > 0 && isMultiHistory ? (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={includeDiffSummary}
                  disabled={exportState === "exporting"}
                  onChange={(e) => setIncludeDiffSummary(e.target.checked)}
                  className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
                />
                {t("exportNote.includeDiffSummary")}
              </label>
            ) : null}

            {/* 导出说明 */}
            {blockCount !== null && blockCount > 0 ? (
              <p className="text-xs text-muted-foreground leading-relaxed">
                {t("exportNote.description")}
              </p>
            ) : null}

            {/* 状态消息 */}
            {statusMsg ? (
              <p
                className={cn(
                  "text-xs",
                  exportState === "error"
                    ? "text-destructive"
                    : "text-muted-foreground",
                )}
              >
                {statusMsg}
              </p>
            ) : null}
          </div>

          {/* 底部按钮 */}
          <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
            <Dialog.Close asChild>
              <button
                type="button"
                className={cn(
                  "inline-flex h-8 items-center rounded-md border border-border bg-background px-3",
                  "text-xs text-foreground transition-colors",
                  "hover:bg-accent hover:text-accent-foreground",
                )}
              >
                {exportState === "done"
                  ? t("exportNote.close")
                  : t("exportNote.cancel")}
              </button>
            </Dialog.Close>
            {exportState !== "done" ? (
              <button
                type="button"
                disabled={
                  exportState === "counting" ||
                  exportState === "exporting" ||
                  blockCount === null
                }
                onClick={() => void handleExport()}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3",
                  "text-xs font-medium text-primary-foreground transition-colors",
                  "hover:bg-primary/90",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                )}
              >
                <Download className="h-3.5 w-3.5" />
                {exportState === "exporting"
                  ? t("exportNote.exporting")
                  : t("exportNote.export")}
              </button>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
