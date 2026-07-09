import { Fragment, useMemo, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Bot, Clipboard, Loader2, RefreshCw, X } from "lucide-react";

import type { AiActionKind } from "@shared/types";
import { useAiModal } from "@/state/ai-modal";
import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";

const SCHEMA_ACTIONS: { action: AiActionKind; labelKey: string }[] = [
  { action: "explain-table", labelKey: "ai.action.explain-table" },
  { action: "suggest-joins", labelKey: "ai.action.suggest-joins" },
  { action: "generate-data-dictionary", labelKey: "ai.action.generate-data-dictionary" },
  { action: "find-related-queries", labelKey: "ai.action.find-related-queries" },
];

function actionsFor(source: string | undefined) {
  if (source === "schema") return SCHEMA_ACTIONS;
  return [];
}

export function AiModal() {
  const t = useT();
  const {
    open,
    title,
    phase,
    request,
    response,
    error,
    actions,
    close,
    rerunWithAction,
  } = useAiModal();
  const text = response?.text ?? "";
  const relatedActions = actionsFor(request?.context.source);
  const activeAction = request?.action;

  const markdown = useMemo(() => renderMarkdown(text), [text]);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[90] bg-black/45 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[91] flex h-[78vh] w-[860px] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-background text-foreground shadow-2xl">
          <div className="flex items-center gap-3 border-b border-border px-4 py-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Bot className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <Dialog.Title className="truncate text-sm font-semibold">
                {title || t("ai.ask")}
              </Dialog.Title>
              <Dialog.Description className="text-[11px] text-muted-foreground">
                {t("ai.modal.description")}
              </Dialog.Description>
            </div>
            <button
              type="button"
              onClick={close}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label={t("ai.panel.close")}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {relatedActions.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 border-b border-border bg-muted/20 px-4 py-2">
              {relatedActions.map((item) => (
                <button
                  key={item.action}
                  type="button"
                  onClick={() => void rerunWithAction(item.action, t(item.labelKey))}
                  disabled={phase === "loading"}
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-[12px]",
                    activeAction === item.action
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background hover:bg-accent",
                    phase === "loading" && "opacity-50",
                  )}
                >
                  {t(item.labelKey)}
                </button>
              ))}
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
            {phase === "loading" ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
                <div>{t("ai.panel.loading")}</div>
              </div>
            ) : phase === "error" ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
                {error}
              </div>
            ) : text ? (
              <div className="stela-ai-markdown mx-auto max-w-none text-sm leading-6">
                {markdown}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">{t("ai.modal.empty")}</div>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-border bg-muted/20 px-4 py-3">
            <div className="truncate text-[11px] text-muted-foreground">
              {response?.contextSummary?.join(" · ") ?? t("ai.modal.contextPending")}
            </div>
            <div className="flex flex-none items-center gap-2">
              {response ? (
                <button
                  type="button"
                  onClick={() => window.stela.shell.writeClipboardText(text)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-[12px] hover:bg-accent"
                >
                  <Clipboard className="h-3.5 w-3.5" />
                  {t("common.copy")}
                </button>
              ) : null}
              {phase === "error" && request ? (
                <button
                  type="button"
                  onClick={() => void rerunWithAction(request.action, title)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-[12px] hover:bg-accent"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  {t("common.retry")}
                </button>
              ) : null}
              {response
                ? actions.map((action) => (
                    <button
                      key={action.label}
                      type="button"
                      onClick={() => void action.run(response)}
                      disabled={action.disabled?.(response)}
                      className="rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
                    >
                      {action.label}
                    </button>
                  ))
                : null}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function renderMarkdown(markdown: string): ReactNode {
  const lines = markdown.split(/\r?\n/);
  const out: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] ?? "";
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? "")) {
        buf.push(lines[i] ?? "");
        i += 1;
      }
      i += 1;
      out.push(
        <pre key={out.length} className="my-3 overflow-auto rounded-lg bg-muted p-3 font-mono text-[12px] leading-5">
          {lang ? <div className="mb-2 text-[10px] uppercase text-muted-foreground">{lang}</div> : null}
          <code>{buf.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const cls =
        level === 1
          ? "mb-2 mt-4 text-lg font-semibold"
          : level === 2
            ? "mb-2 mt-4 text-base font-semibold"
            : "mb-1 mt-3 text-sm font-semibold";
      out.push(<div key={out.length} className={cls}>{heading[2]}</div>);
      i += 1;
      continue;
    }
    if (/^\|.+\|$/.test(line) && /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(lines[i + 1] ?? "")) {
      const header = splitTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\|.+\|$/.test(lines[i] ?? "")) {
        rows.push(splitTableRow(lines[i] ?? ""));
        i += 1;
      }
      out.push(
        <div key={out.length} className="my-3 overflow-auto">
          <table className="w-full border-collapse text-left text-[12px]">
            <thead>
              <tr>{header.map((cell, idx) => <th key={idx} className="border border-border bg-muted px-2 py-1 font-medium">{cell}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((row, idx) => (
                <tr key={idx}>{row.map((cell, cidx) => <td key={cidx} className="border border-border px-2 py-1">{cell}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^[-*]\s+/, ""));
        i += 1;
      }
      out.push(<ul key={out.length} className="my-2 list-disc space-y-1 pl-5">{items.map((item, idx) => <li key={idx}>{renderInline(item)}</li>)}</ul>);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quotes: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i] ?? "")) {
        quotes.push((lines[i] ?? "").replace(/^>\s?/, ""));
        i += 1;
      }
      out.push(<blockquote key={out.length} className="my-2 border-l-2 border-border pl-3 text-muted-foreground">{quotes.map((q, idx) => <Fragment key={idx}>{renderInline(q)}{idx < quotes.length - 1 ? <br /> : null}</Fragment>)}</blockquote>);
      continue;
    }
    const para: string[] = [line];
    i += 1;
    while (i < lines.length && (lines[i] ?? "").trim() && !/^```/.test(lines[i] ?? "") && !/^(#{1,3})\s+/.test(lines[i] ?? "") && !/^[-*]\s+/.test(lines[i] ?? "") && !/^>\s?/.test(lines[i] ?? "")) {
      para.push(lines[i] ?? "");
      i += 1;
    }
    out.push(<p key={out.length} className="my-2">{renderInline(para.join(" "))}</p>);
  }
  return out;
}

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function renderInline(text: string): ReactNode {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((part, idx) => {
    if (/^`[^`]+`$/.test(part)) {
      return <code key={idx} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">{part.slice(1, -1)}</code>;
    }
    if (/^\*\*[^*]+\*\*$/.test(part)) {
      return <strong key={idx}>{part.slice(2, -2)}</strong>;
    }
    return <Fragment key={idx}>{part}</Fragment>;
  });
}

