import type { Session } from "@earendil-works/pi-agent-core";
import { z } from "zod";
import type {
  AgentPlanSnapshot,
  AgentPlanStep,
  AgentPlanStepStatus,
} from "@shared/types";

const MAX_INITIAL_STEPS = 8;
const MAX_TEXT_LENGTH = 240;
const MAX_EVIDENCE_LENGTH = 480;

export interface CreatePlanStep {
  id: string;
  title: string;
  intent: string;
  acceptance: string;
}

export interface UpdatePlanStep {
  stepId: string;
  status: Extract<AgentPlanStepStatus, "completed" | "blocked" | "skipped">;
  evidence?: string;
  runId?: string;
}

/** Bookkeeping outcome: a plan update never blocks the run, so it reports instead of throwing. */
export interface UpdatePlanResult {
  snapshot: AgentPlanSnapshot;
  note?: string;
}

export interface IPlanPersistenceBuffer {
  enqueue(snapshot: AgentPlanSnapshot): Promise<void>;
  flush(): Promise<void>;
}

export function createPlanPersistenceBuffer(
  persist: (snapshot: AgentPlanSnapshot) => Promise<void>,
): IPlanPersistenceBuffer {
  const pending: AgentPlanSnapshot[] = [];
  let writing = Promise.resolve();
  return {
    async enqueue(snapshot) {
      pending.push(structuredClone(snapshot));
    },
    flush() {
      writing = writing.catch(() => undefined).then(async () => {
        while (pending.length) {
          await persist(pending[0]!);
          pending.shift();
        }
      });
      return writing;
    },
  };
}

export function formatExecutionPlan(snapshot: AgentPlanSnapshot | null): string {
  if (!snapshot) return "No execution plan exists yet. Create a concise linear plan before using analysis tools.";
  const steps = snapshot.steps
    .map((step, index) => {
      const evidence = step.evidence ? ` Evidence: ${step.evidence}` : "";
      return `${index + 1}. [${step.status}] ${step.title}. Acceptance: ${step.acceptance}.${evidence}`;
    })
    .join("\n");
  return `Plan version ${snapshot.version}.\n${steps}\n${formatPlanDeliveries(snapshot)}`;
}

/** Session projector accepts a live plan during a run or its JSONL-restored snapshot. */
export function formatExecutionPlanEntry(data: { plan?: ExecutionPlanStore | AgentPlanSnapshot }): string {
  const plan = data.plan instanceof ExecutionPlanStore
    ? data.plan.get()
    : data.plan && Array.isArray(data.plan.steps)
      ? data.plan
      : null;
  return formatExecutionPlan(plan);
}

function text(value: string, field: string, maxLength = MAX_TEXT_LENGTH): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} must be a non-empty string.`);
  if (trimmed.length > maxLength) throw new Error(`${field} must be at most ${maxLength} characters.`);
  return trimmed;
}

/** First step that still has work, so the UI always has one place to point at. */
function withRunningStep(steps: AgentPlanStep[]): AgentPlanStep[] {
  if (steps.some((step) => step.status === "running")) return steps;
  const next = steps.findIndex((step) => step.status === "pending");
  if (next < 0) return steps;
  return steps.map((step, index) => (index === next ? { ...step, status: "running" } : step));
}

/**
 * Progress bookkeeping for the agent panel's plan card, and nothing else.
 *
 * A plan carries no authority over the answer: measured against the same 61
 * benchmark questions, dropping the plan changed 41 valid answers to 39
 * (McNemar exact p = 0.73). Its only real payoff is showing the user where a
 * long run currently is, so every mutation here either records progress or
 * reports a note — it never fails the run. See ADR-0078.
 */
export class ExecutionPlanStore {
  private snapshot: AgentPlanSnapshot | null = null;

  constructor(
    private readonly runId: string,
    private readonly onUpdate?: (snapshot: AgentPlanSnapshot) => void,
  ) {}

  restore(snapshot: AgentPlanSnapshot | null): AgentPlanSnapshot | null {
    const parsed = z.object({
      runId: z.string(), version: z.number().int().nonnegative(), originRunId: z.string().optional(),
      steps: z.array(z.object({ id: z.string(), title: z.string(), intent: z.string(), acceptance: z.string(),
        status: z.enum(["pending", "running", "completed", "blocked", "skipped"]), evidence: z.string().optional(), runId: z.string().optional() })).min(1).max(8),
      deliveries: z.array(z.object({ kind: z.enum(["note", "canvas"]), path: z.string().optional(),
        receipt: z.object({ path: z.string(), runId: z.string() }).optional() })).max(8).optional(),
    }).safeParse(snapshot);
    if (!parsed.success) return null;
    snapshot = parsed.data;
    if ((snapshot.steps.every(step => step.status === "completed" || step.status === "skipped") &&
      !snapshot.deliveries?.some(item => !item.receipt))) return null;
    return this.replace({ ...structuredClone(snapshot), runId: this.runId,
      originRunId: snapshot.originRunId ?? snapshot.runId, version: snapshot.version + 1 });
  }

  recordDelivery(kind: "note" | "canvas", path: string): AgentPlanSnapshot | null {
    if (!this.snapshot?.deliveries || this.snapshot.deliveries.some(item => item.kind === kind && item.receipt?.path === path)) return null;
    const target = this.snapshot.deliveries.findIndex(item => !item.receipt && item.kind === kind && (!item.path || item.path === path));
    if (target < 0) return null;
    const deliveries = this.snapshot.deliveries.map((item, index) => index === target
      ? { ...item, receipt: { path, runId: this.runId } } : item);
    return this.replace({ ...this.snapshot, version: this.snapshot.version + 1, deliveries });
  }

  create(steps: CreatePlanStep[], options: { replace?: boolean; deliveries?: AgentPlanSnapshot["deliveries"] } = {}): AgentPlanSnapshot {
    if (this.snapshot && !options.replace) throw new Error("A plan already exists for this run.");
    if (steps.length === 0 || steps.length > MAX_INITIAL_STEPS) {
      throw new Error(`A plan must contain between 1 and ${MAX_INITIAL_STEPS} steps.`);
    }

    const ids = new Set<string>();
    const normalized = steps.map((step, index): AgentPlanStep => {
      const id = text(step.id, "step id", 80);
      if (ids.has(id)) throw new Error(`Duplicate step id: ${id}.`);
      ids.add(id);
      return {
        id,
        title: text(step.title, "title"),
        intent: text(step.intent, "intent"),
        acceptance: text(step.acceptance, "acceptance"),
        status: index === 0 ? "running" : "pending",
      };
    });

    return this.replace({ runId: this.runId, version: (this.snapshot?.version ?? 0) + 1, steps: normalized,
      ...(options.deliveries ? { deliveries: options.deliveries.map(({ kind, path }) => ({ kind, ...(path ? { path } : {}) })) } : {}) });
  }

  update(input: UpdatePlanStep): UpdatePlanResult {
    if (!this.snapshot) throw new Error("Create a plan before updating it.");
    const target = this.snapshot.steps.find((item) => item.id === input.stepId);
    if (!target) {
      return {
        snapshot: this.snapshot,
        note: `Unknown plan step '${input.stepId}'; nothing was recorded. Valid step ids: ${this.snapshot.steps.map((step) => step.id).join(", ")}.`,
      };
    }

    const evidence = input.evidence?.trim().slice(0, MAX_EVIDENCE_LENGTH) ?? "";
    const steps = withRunningStep(this.snapshot.steps.map((item) =>
      item.id === target.id
        ? {
            ...item,
            status: input.status,
            ...(evidence ? { evidence } : {}),
            ...(input.runId ? { runId: input.runId.trim().slice(0, 160) } : {}),
          }
        : item,
    ));

    return {
      snapshot: this.replace({ ...this.snapshot, version: this.snapshot.version + 1, steps }),
      ...(target.status === "completed" || target.status === "skipped"
        ? { note: `Step '${target.id}' was already ${target.status}; its record was overwritten.` }
        : {}),
    };
  }

  get(): AgentPlanSnapshot | null {
    return this.snapshot;
  }

  formatForContext(): string {
    return formatExecutionPlan(this.snapshot);
  }

  private replace(snapshot: AgentPlanSnapshot): AgentPlanSnapshot {
    this.snapshot = snapshot;
    this.onUpdate?.(snapshot);
    return snapshot;
  }
}

export function formatPlanDeliveries(snapshot: AgentPlanSnapshot | null, chinese = false): string {
  if (!snapshot?.deliveries?.length) return chinese ? "未声明交付物，完成情况未知。" : "Deliverables: undeclared (completion unknown).";
  const completed = snapshot.deliveries.filter(item => item.receipt).length;
  if (chinese) return `交付情况：已写入 ${completed}/${snapshot.deliveries.length} 项。` + snapshot.deliveries.map(item => {
    const kind = item.kind === "note" ? "笔记" : "Canvas";
    return item.receipt ? `${kind}：已写入 ${item.receipt.path}` : `${kind}：尚未写入${item.path ? ` ${item.path}` : ""}`;
  }).join("；") + "。写入成功不代表分析内容已验证。";
  return `Deliverables: ${completed}/${snapshot.deliveries.length} saved. ` + snapshot.deliveries.map(item =>
    item.receipt ? `${item.kind}: saved ${item.receipt.path}` : `${item.kind}: not saved${item.path ? ` ${item.path}` : ""}`).join("; ") +
    " Saving verifies persistence only, not analytical correctness.";
}

export async function restoreSessionPlan(store: ExecutionPlanStore, session: Pick<Session, "getBranch">): Promise<AgentPlanSnapshot | null> {
  const latest = (await session.getBranch()).reverse().find(entry => entry.type === "custom" && entry.customType === "execution_plan");
  if (latest?.type !== "custom") return null;
  const data = latest.data as { plan?: AgentPlanSnapshot } | undefined;
  return store.restore(data?.plan ?? null);
}
