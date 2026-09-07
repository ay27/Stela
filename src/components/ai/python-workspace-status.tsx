import { useEffect, useRef, useState } from "react";
import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";

export function PythonWorkspaceStatus({ sessionId, busy }: { sessionId: string; busy: boolean }) {
  const t = useT();
  const [status, setStatus] = useState("empty");
  const [error, setError] = useState("");
  const [resetting, setResetting] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const [semantic, setSemantic] = useState<{ records: number; tokens: number; failed: number; unresolved: number } | null>(null);
  useEffect(() => window.stela.agent.onEvent((event) => {
    if (event.type === "semantic_progress" && event.sessionId === sessionId) setSemantic(event);
  }), [sessionId]);
  useEffect(() => {
    let live = true;
    const refresh = () => { void window.stela.pythonRuntime.status(sessionId).then((text) => {
      if (!live) return;
      const data = JSON.parse(text) as { status?: string };
      setStatus(data.status ?? "empty");
    }).catch((e) => { if (live) setError(String(e)); }); };
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => { live = false; clearInterval(timer); };
  }, [sessionId, busy]);
  const statusText = t(
    status === "ready" ? "agent.workspace.ready"
      : status === "lost" ? "agent.workspace.lost"
        : status === "partial_mutation_possible" ? "agent.workspace.partial"
          : "agent.workspace.empty",
  );
  const label = `${t("agent.workspace.title")}: ${statusText}`;
  const semanticText = semantic ? t("agent.workspace.semantic", semantic) : "";
  const tooltip = [label, error ? t("agent.workspace.error") : "", semanticText]
    .filter(Boolean).join("\n");
  const tone = error || status === "lost" ? "text-destructive"
    : status === "partial_mutation_possible" ? "text-amber-500"
      : status === "ready" ? "text-primary" : "text-muted-foreground";

  return (
    <div
      ref={menuRef}
      className="stela-python-workspace relative flex-none"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setOpen(false);
          menuRef.current?.querySelector("button")?.focus();
          event.stopPropagation();
        }
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex h-5 w-5 cursor-pointer list-none items-center justify-center rounded hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [&::-webkit-details-marker]:hidden",
          tone,
        )}
        title={tooltip}
        aria-label={tooltip}
      >
        <span
          className="flex h-4 w-4 items-center justify-center rounded-full border border-current text-[7px] font-semibold leading-none"
          aria-hidden="true"
        >
          Py
        </span>
      </button>
      {open && <div tabIndex={-1} className="absolute right-0 top-7 z-20 w-56 space-y-2 rounded-md border border-border bg-popover p-3 text-[11px] text-popover-foreground shadow-md">
        <div className="font-medium">{t("agent.workspace.title")}</div>
        <div className={tone}>{statusText}</div>
        {error && <div className="break-words text-destructive" title={error}>{t("agent.workspace.error")}</div>}
        {semanticText && <div className="text-muted-foreground">{semanticText}</div>}
        <button
          type="button"
          disabled={busy || resetting || status === "empty"}
          className="rounded border border-border px-2 py-1 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
          onClick={() => {
            setResetting(true);
            void window.stela.pythonRuntime.reset(sessionId)
              .then(() => {
                setStatus("empty");
                setError("");
              })
              .catch((e: unknown) => setError(String(e)))
              .finally(() => setResetting(false));
          }}
        >
          {t("agent.workspace.reset")}
        </button>
      </div>}
    </div>
  );
}
