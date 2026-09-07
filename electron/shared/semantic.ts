import { z } from "zod";

export const semanticBudgetSchema = z.object({
  records: z.number().int().min(1).max(100_000),
  requests: z.number().int().min(1).max(10_000),
  tokens: z.number().int().min(1000).max(10_000_000),
}).strict();
export type SemanticBudget = z.infer<typeof semanticBudgetSchema>;
export const DEFAULT_SEMANTIC_BUDGET: SemanticBudget = { records: 1000, requests: 200, tokens: 200_000 };

export const semanticRequestSchema = z.object({
  phase: z.enum(["execute", "preflight"]).optional(),
  totalRecords: z.number().int().min(0).max(100_000).optional(),
  requiredFields: z.array(z.string().min(1).max(128)).max(100).optional(),
  operation: z.enum(["classify", "extract", "resolve"]),
  instructions: z.string().min(1).max(8000),
  labels: z.record(z.string().max(2000)).optional(),
  schema: z.record(z.unknown()).optional(),
  records: z.array(z.object({
    id: z.string().min(1).max(128),
    data: z.record(z.unknown()),
  }).strict()).max(8),
}).strict();
export type SemanticRequest = z.infer<typeof semanticRequestSchema>;
export interface ISemanticRow {
  id: string;
  status: "success" | "unresolved" | "failed" | "unprocessed";
  value: unknown;
  evidence: string[];
  error?: string;
}
export interface ISemanticResponse {
  phase?: "preflight" | "execute";
  rows: ISemanticRow[];
  usage: SemanticBudget;
  cached: number;
  control?: {
    remaining: SemanticBudget;
    canStartFull: boolean;
    cacheCoverage: "complete" | "bounded_probe";
    stopScheduling: boolean;
    reason?: string;
    requiredRecordsUpperBound?: number;
    minimumRequests?: number;
    ledgerRevision?: number;
    executionIdentity?: string;
  };
}
export type SemanticRunner = (request: string, signal?: AbortSignal, onAuthorizationWait?: (waiting: boolean) => void) => Promise<ISemanticResponse>;
