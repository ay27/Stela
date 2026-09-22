/** Run-local accounting; changing arguments never resets a validation allowance. */
export class ToolRepairBudget {
  private counts = new Map<string, number>();
  private issues = new Map<string, number>();
  private hints = new Map<string, string>();
  readonly dispatched = new Set<string>();

  observeHarnessResult(tool: string, callId: string, isError: boolean): string | null {
    const dispatched = this.dispatched.delete(callId);
    return isError && !dispatched ? "schema_validation: " + this.validation(tool, "schema_validation") : null;
  }

  contextHint(): string {
    return [...this.hints].slice(-24).map(([tool, hint]) => `${tool}: ${hint}`).join("\n");
  }

  blocked(tool: string): string | null {
    return (this.counts.get(tool) ?? 0) >= 6
      ? `${tool}: validation repair budget exhausted (6). Stop retrying this tool and report the missing deliverable.` : null;
  }

  validation(tool: string, code: string): string {
    const count = (this.counts.get(tool) ?? 0) + 1;
    this.counts.set(tool, count);
    const key = `${tool}:${code}`;
    const repeats = (this.issues.get(key) ?? 0) + 1;
    this.issues.set(key, repeats);
    const hint = `Validation repair: ${Math.max(0, 6 - count)} attempts remaining.` +
      (repeats >= 2 ? " This issue repeated: change the source/query/card shape; do not resubmit the same approach." : "") +
      (count >= 6 ? " Stop retrying and report the missing deliverable." : "");
    this.hints.set(tool, hint);
    return hint;
  }
}
