import type { AgentPlanSnapshot, AgentPlanStep, AgentPlanStepStatus } from "@shared/types";

const MAX_STEPS = 8;
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

export function formatExecutionPlan(snapshot: AgentPlanSnapshot | null): string {
  if (!snapshot) return "No execution plan exists yet. Create a concise linear plan before using analysis tools.";
  return snapshot.steps
    .map((step, index) => {
      const evidence = step.evidence ? ` Evidence: ${step.evidence}` : "";
      return `${index + 1}. [${step.status}] ${step.title}. Acceptance: ${step.acceptance}.${evidence}`;
    })
    .join("\n");
}

/** Session projector reads the mutable plan without appending a message mid-tool-call. */
export function formatExecutionPlanEntry(data: { plan?: ExecutionPlanStore }): string {
  return formatExecutionPlan(data.plan?.get() ?? null);
}

function text(value: string, field: string, maxLength = MAX_TEXT_LENGTH): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} must be a non-empty string.`);
  if (trimmed.length > maxLength) throw new Error(`${field} must be at most ${maxLength} characters.`);
  return trimmed;
}

export class ExecutionPlanStore {
  private snapshot: AgentPlanSnapshot | null = null;

  constructor(
    private readonly runId: string,
    private readonly onUpdate?: (snapshot: AgentPlanSnapshot) => void,
  ) {}

  create(steps: CreatePlanStep[]): AgentPlanSnapshot {
    if (this.snapshot) throw new Error("A plan already exists for this run.");
    if (steps.length === 0 || steps.length > MAX_STEPS) {
      throw new Error(`A plan must contain between 1 and ${MAX_STEPS} steps.`);
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

  update(input: UpdatePlanStep): AgentPlanSnapshot {
    if (!this.snapshot) throw new Error("Create a plan before updating it.");
    const step = this.snapshot.steps.find((item) => item.id === input.stepId);
    if (!step) throw new Error(`Unknown plan step: ${input.stepId}.`);
    if (step.status !== "running") throw new Error("Only the current step can be updated.");

    const evidence = input.evidence?.trim() ?? "";
    if (input.status === "completed" && !evidence) {
      throw new Error("Completed steps require evidence.");
    }
    if (evidence.length > MAX_EVIDENCE_LENGTH) {
      throw new Error(`evidence must be at most ${MAX_EVIDENCE_LENGTH} characters.`);
    }

    const steps = this.snapshot.steps.map((item) =>
      item.id === step.id
        ? {
            ...item,
            status: input.status,
            ...(evidence ? { evidence } : {}),
            ...(input.runId ? { runId: text(input.runId, "runId", 160) } : {}),
          }
        : item,
    );
    const nextIndex = steps.findIndex((item) => item.id === step.id) + 1;
    if (input.status === "completed" && steps[nextIndex]?.status === "pending") {
      steps[nextIndex] = { ...steps[nextIndex], status: "running" };
    }

    return this.replace({ ...this.snapshot, version: this.snapshot.version + 1, steps });
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
