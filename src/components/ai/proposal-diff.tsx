import { useMemo, useState } from "react";

import { useT } from "@/i18n/use-t";
import { buildDiffSegments, diffLines, splitLines } from "@/lib/line-diff";
import { cn } from "@/lib/utils";

export function ProposalLineDiff({
  oldContent,
  newContent,
}: {
  oldContent: string;
  newContent: string;
}) {
  const t = useT();
  const segments = useMemo(
    () => buildDiffSegments(diffLines(splitLines(oldContent), splitLines(newContent))),
    [oldContent, newContent],
  );
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());

  const toggle = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="mb-2 max-h-64 overflow-auto rounded border border-border/60 bg-muted/40 font-mono text-[11px] leading-relaxed">
      {segments.map((segment, index) => {
        if (segment.type === "line") {
          return <DiffLine key={`seg-${index}`} op={segment.op} />;
        }
        const open = expanded.has(segment.id);
        if (open) {
          return (
            <div key={`seg-${index}`}>
              <button
                type="button"
                onClick={() => toggle(segment.id)}
                className="block w-full bg-muted/80 px-2 py-0.5 text-left text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {t("agent.panel.proposal.hideUnchanged", { count: segment.ops.length })}
              </button>
              {segment.ops.map((op, idx) => (
                <DiffLine key={`seg-${index}-${idx}`} op={op} />
              ))}
            </div>
          );
        }
        return (
          <button
            key={`seg-${index}`}
            type="button"
            onClick={() => toggle(segment.id)}
            className="block w-full bg-muted/80 px-2 py-0.5 text-left text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {t("agent.panel.proposal.showUnchanged", { count: segment.ops.length })}
          </button>
        );
      })}
    </div>
  );
}

function DiffLine({ op }: { op: { kind: "equal" | "added" | "removed"; line: string } }) {
  const prefix = op.kind === "added" ? "+" : op.kind === "removed" ? "-" : " ";
  return (
    <div
      className={cn(
        "whitespace-pre-wrap break-all px-2",
        op.kind === "added" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
        op.kind === "removed" && "bg-destructive/10 text-destructive",
        op.kind === "equal" && "text-muted-foreground",
      )}
    >
      <span className="select-none opacity-70">{prefix}</span>
      {op.line.length === 0 ? " " : op.line}
    </div>
  );
}
