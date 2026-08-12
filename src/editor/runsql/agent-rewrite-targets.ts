export interface RunsqlRewriteTarget {
  getSql(): string;
  preview(originalSql: string, proposedSql: string, onApprove: () => void, onReject: () => void): void;
  accept(): void;
  discard(): void;
}

interface PendingRewrite {
  key: string;
  originalSql: string;
}

const targets = new Map<string, RunsqlRewriteTarget>();
const pending = new Map<string, PendingRewrite>();
const targetIdsByStableKey = new Map<string, string>();

function proposalKey(runId: string, callId: string): string {
  return `${runId}:${callId}`;
}

export function registerRunsqlRewriteTarget(target: RunsqlRewriteTarget, stableKey?: string): string {
  const existingId = stableKey ? targetIdsByStableKey.get(stableKey) : undefined;
  const id = existingId ?? `runsql_${
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}_${Math.random().toString(36).slice(2)}`
  }`;
  if (stableKey && !existingId) targetIdsByStableKey.set(stableKey, id);
  targets.set(id, target);
  return id;
}

export function unregisterRunsqlRewriteTarget(targetId: string, target?: RunsqlRewriteTarget): void {
  if (target && targets.get(targetId) !== target) return;
  targets.delete(targetId);
  pending.delete(targetId);
}

export function presentRunsqlRewriteProposal(input: {
  targetId: string;
  runId: string;
  callId: string;
  originalSql: string;
  proposedSql: string;
  onApprove: () => void;
  onReject: () => void;
}): boolean {
  const target = targets.get(input.targetId);
  if (!target || target.getSql().trim() !== input.originalSql.trim()) return false;
  pending.set(input.targetId, {
    key: proposalKey(input.runId, input.callId),
    originalSql: input.originalSql,
  });
  target.preview(input.originalSql, input.proposedSql, input.onApprove, input.onReject);
  return true;
}

export function resolveRunsqlRewriteProposal(input: {
  targetId: string;
  runId: string;
  callId: string;
  approve: boolean;
}): boolean {
  const target = targets.get(input.targetId);
  const proposal = pending.get(input.targetId);
  if (!target || proposal?.key !== proposalKey(input.runId, input.callId)) return false;
  pending.delete(input.targetId);
  if (input.approve) target.accept();
  else target.discard();
  return true;
}

export function hasRunsqlRewriteProposal(targetId: string, runId: string, callId: string): boolean {
  return targets.has(targetId) && pending.get(targetId)?.key === proposalKey(runId, callId);
}
