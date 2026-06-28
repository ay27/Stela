import type { AiCompleteResponse } from "@shared/types";
import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";

export function AiInlinePanel({
  title,
  loading,
  error,
  response,
  onClose,
  onCopy,
  onInsert,
}: {
  title: string;
  loading: boolean;
  error: string | null;
  response: AiCompleteResponse | null;
  onClose: () => void;
  onCopy?: (text: string) => void;
  onInsert?: (text: string) => void;
}) {
  const t = useT();
  const text = response?.text ?? "";
  return (
    <div className="rounded-md border border-border bg-card/95 p-3 text-[12px] shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="font-medium text-foreground">{title}</div>
        <button
          type="button"
          onClick={onClose}
          className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent"
        >
          {t("ai.panel.close")}
        </button>
      </div>
      {loading ? (
        <div className="text-muted-foreground">{t("ai.panel.loading")}</div>
      ) : error ? (
        <div className="text-destructive">{error}</div>
      ) : (
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 font-sans leading-relaxed">
          {text}
        </pre>
      )}
      {!loading && !error && response ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onCopy?.(text)}
            className="rounded-md border border-border px-2 py-1 hover:bg-accent"
          >
            {t("common.copy")}
          </button>
          {onInsert ? (
            <button
              type="button"
              onClick={() => onInsert(text)}
              className={cn(
                "rounded-md bg-primary px-2 py-1 font-medium text-primary-foreground",
                "hover:opacity-90",
              )}
            >
              {t("ai.panel.insert")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

