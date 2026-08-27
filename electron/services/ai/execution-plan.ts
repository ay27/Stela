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
  return {
    async enqueue(snapshot) {
      pending.push(structuredClone(snapshot));
    },
    async flush() {
      const batch = pending.splice(0);
      for (const snapshot of batch) await persist(snapshot);
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
  return `Plan version ${snapshot.version}.\n${steps}`;
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

  create(steps: CreatePlanStep[]): AgentPlanSnapshot {
    if (this.snapshot) throw new Error("A plan already exists for this run.");
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

    return this.replace({ runId: this.runId, version: 1, steps: normalized });
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
