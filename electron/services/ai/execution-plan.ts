import type {
  AgentAnalysisOutputShape,
  AgentPlanAnalysis,
  AgentPlanAnalysisJoin,
  AgentPlanAnalysisSource,
  AgentPlanSnapshot,
  AgentPlanStep,
  AgentPlanStepStatus,
  AgentPlanVerificationCheck,
} from "@shared/types";

const MAX_STEPS = 8;
const MAX_TEXT_LENGTH = 240;
const MAX_EVIDENCE_LENGTH = 480;
const MAX_ANALYSIS_ITEMS = 20;
const MAX_SOURCES = 12;

const OUTPUT_SHAPES = new Set<AgentAnalysisOutputShape>([
  "scalar",
  "percentage",
  "ranked_list",
  "table",
  "narrative",
]);

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
  /** Full replacement of the current analysis semantics, never a merge. */
  analysis?: AgentPlanAnalysis;
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
  if (!snapshot.analysis) return steps;
  const analysis = snapshot.analysis;
  const lines = [
    "Analysis semantics (current full snapshot):",
    `- Question: ${analysis.question ?? "unresolved"}`,
    `- Grain: ${analysis.grain ?? "unresolved"}`,
    `- Measure: ${analysis.measure ?? "unresolved"}`,
    `- Output: ${analysis.outputShape ?? "unresolved"}`,
    `- Sources: ${analysis.sources?.map((source) => `${source.connectionName ? `${source.connectionName}:` : ""}${source.table}[${source.columns.join(", ")}]`).join("; ") ?? "unresolved"}`,
    `- Unresolved: ${analysis.unresolved === undefined ? "not inspected" : analysis.unresolved.length > 0 ? analysis.unresolved.join("; ") : "none"}`,
    `- Verification checks: ${analysis.verificationChecks?.map((check) => `${check.id}: ${check.description}`).join("; ") ?? "not inspected"}`,
  ];
  return `${steps}\n\n${lines.join("\n")}`;
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

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  return text(value, field);
}

function textList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  if (value.length > MAX_ANALYSIS_ITEMS) {
    throw new Error(`${field} supports at most ${MAX_ANALYSIS_ITEMS} items.`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string") throw new Error(`${field}[${index}] must be a string.`);
    return text(item, `${field}[${index}]`);
  });
}

function normalizeSources(value: unknown): AgentPlanAnalysisSource[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("analysis.sources must be an array.");
  if (value.length > MAX_SOURCES) throw new Error(`analysis.sources supports at most ${MAX_SOURCES} items.`);
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`analysis.sources[${index}] must be an object.`);
    }
    const source = item as Record<string, unknown>;
    const columns = textList(source.columns, `analysis.sources[${index}].columns`);
    if (!columns || columns.length === 0) {
      throw new Error(`analysis.sources[${index}].columns must contain at least one column.`);
    }
    return {
      ...(optionalText(source.connectionName, `analysis.sources[${index}].connectionName`)
        ? { connectionName: optionalText(source.connectionName, `analysis.sources[${index}].connectionName`) }
        : {}),
      table: typeof source.table === "string"
        ? text(source.table, `analysis.sources[${index}].table`)
        : (() => { throw new Error(`analysis.sources[${index}].table must be a string.`); })(),
      columns,
      reason: typeof source.reason === "string"
        ? text(source.reason, `analysis.sources[${index}].reason`)
        : (() => { throw new Error(`analysis.sources[${index}].reason must be a string.`); })(),
    };
  });
}

function normalizeJoins(value: unknown): AgentPlanAnalysisJoin[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("analysis.joins must be an array.");
  if (value.length > MAX_ANALYSIS_ITEMS) throw new Error(`analysis.joins supports at most ${MAX_ANALYSIS_ITEMS} items.`);
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`analysis.joins[${index}] must be an object.`);
    }
    const join = item as Record<string, unknown>;
    if (typeof join.left !== "string" || typeof join.right !== "string") {
      throw new Error(`analysis.joins[${index}] requires string left and right expressions.`);
    }
    return {
      left: text(join.left, `analysis.joins[${index}].left`),
      right: text(join.right, `analysis.joins[${index}].right`),
      ...(optionalText(join.normalization, `analysis.joins[${index}].normalization`)
        ? { normalization: optionalText(join.normalization, `analysis.joins[${index}].normalization`) }
        : {}),
      ...(optionalText(join.cardinality, `analysis.joins[${index}].cardinality`)
        ? { cardinality: optionalText(join.cardinality, `analysis.joins[${index}].cardinality`) }
        : {}),
    };
  });
}

function normalizeChecks(value: unknown): AgentPlanVerificationCheck[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("analysis.verificationChecks must be an array.");
  if (value.length > MAX_ANALYSIS_ITEMS) {
    throw new Error(`analysis.verificationChecks supports at most ${MAX_ANALYSIS_ITEMS} items.`);
  }
  const ids = new Set<string>();
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`analysis.verificationChecks[${index}] must be an object.`);
    }
    const check = item as Record<string, unknown>;
    if (typeof check.id !== "string" || typeof check.description !== "string") {
      throw new Error(`analysis.verificationChecks[${index}] requires string id and description.`);
    }
    const id = text(check.id, `analysis.verificationChecks[${index}].id`, 80);
    if (ids.has(id)) throw new Error(`Duplicate verification check id: ${id}.`);
    ids.add(id);
    return { id, description: text(check.description, `analysis.verificationChecks[${index}].description`) };
  });
}

function normalizeAnalysis(value: AgentPlanAnalysis | undefined): AgentPlanAnalysis | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("analysis must be an object.");
  }
  const outputShape = value.outputShape;
  if (outputShape !== undefined && !OUTPUT_SHAPES.has(outputShape)) {
    throw new Error(`analysis.outputShape must be one of: ${[...OUTPUT_SHAPES].join(", ")}.`);
  }
  return {
    ...(optionalText(value.question, "analysis.question") ? { question: optionalText(value.question, "analysis.question") } : {}),
    ...(optionalText(value.grain, "analysis.grain") ? { grain: optionalText(value.grain, "analysis.grain") } : {}),
    ...(optionalText(value.measure, "analysis.measure") ? { measure: optionalText(value.measure, "analysis.measure") } : {}),
    ...(textList(value.dimensions, "analysis.dimensions") !== undefined ? { dimensions: textList(value.dimensions, "analysis.dimensions") } : {}),
    ...(textList(value.filters, "analysis.filters") !== undefined ? { filters: textList(value.filters, "analysis.filters") } : {}),
    ...(normalizeSources(value.sources) !== undefined ? { sources: normalizeSources(value.sources) } : {}),
    ...(normalizeJoins(value.joins) !== undefined ? { joins: normalizeJoins(value.joins) } : {}),
    ...(outputShape ? { outputShape } : {}),
    ...(textList(value.assumptions, "analysis.assumptions") !== undefined ? { assumptions: textList(value.assumptions, "analysis.assumptions") } : {}),
    ...(textList(value.unresolved, "analysis.unresolved") !== undefined ? { unresolved: textList(value.unresolved, "analysis.unresolved") } : {}),
    ...(normalizeChecks(value.verificationChecks) !== undefined ? { verificationChecks: normalizeChecks(value.verificationChecks) } : {}),
  };
}

export function analysisReadinessIssues(snapshot: AgentPlanSnapshot): string[] {
  const analysis = snapshot.analysis;
  if (!analysis) return ["analysis semantics are missing"];
  const issues: string[] = [];
  if (!analysis.question) issues.push("question is missing");
  if (!analysis.grain) issues.push("grain is missing");
  if (!analysis.measure) issues.push("measure is missing");
  if (!analysis.outputShape) issues.push("outputShape is missing");
  if (!analysis.sources || analysis.sources.length === 0) issues.push("sources are missing");
  for (const field of ["dimensions", "filters", "joins", "assumptions", "unresolved", "verificationChecks"] as const) {
    if (analysis[field] === undefined) issues.push(`${field} was not inspected`);
  }
  if (analysis.unresolved && analysis.unresolved.length > 0) {
    issues.push(`unresolved questions remain: ${analysis.unresolved.join("; ")}`);
  }
  return issues;
}

export class ExecutionPlanStore {
  private snapshot: AgentPlanSnapshot | null = null;

  constructor(
    private readonly runId: string,
    private readonly onUpdate?: (snapshot: AgentPlanSnapshot) => void,
  ) {}

  create(steps: CreatePlanStep[], analysis?: AgentPlanAnalysis): AgentPlanSnapshot {
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

    return this.replace({
      runId: this.runId,
      version: 1,
      steps: normalized,
      ...(analysis === undefined ? {} : { analysis: normalizeAnalysis(analysis) }),
    });
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

    return this.replace({
      ...this.snapshot,
      version: this.snapshot.version + 1,
      steps,
      ...(input.analysis === undefined ? {} : { analysis: normalizeAnalysis(input.analysis) }),
    });
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
