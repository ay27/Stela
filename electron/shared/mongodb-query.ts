import type { MongoAggregateDataQuery } from "./types";

export const MONGO_AGGREGATION_MAX_STAGES = 32;
export const MONGO_AGGREGATION_MAX_BYTES = 64 * 1024;
export const MONGO_AGGREGATION_MAX_DEPTH = 32;
export const MONGO_AGGREGATION_MAX_TIME_MS = 120_000;

export const ALLOWED_MONGO_AGGREGATION_STAGES = new Set([
  "$match",
  "$project",
  "$set",
  "$addFields",
  "$unset",
  "$unwind",
  "$group",
  "$sort",
  "$skip",
  "$limit",
  "$count",
  "$replaceRoot",
  "$replaceWith",
]);

export const FORBIDDEN_MONGO_OPERATORS = new Set([
  "$where",
  "$function",
  "$accumulator",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nestedValidationError(value: unknown, depth: number): string | null {
  if (depth > MONGO_AGGREGATION_MAX_DEPTH) {
    return `MongoDB aggregation exceeds the maximum nesting depth of ${MONGO_AGGREGATION_MAX_DEPTH}.`;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const error = nestedValidationError(item, depth + 1);
      if (error) return error;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  if (!isPlainObject(value)) return "MongoDB aggregation values must be JSON objects.";
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_MONGO_OPERATORS.has(key.toLowerCase())) {
      return `MongoDB operator '${key}' is not allowed.`;
    }
    const error = nestedValidationError(nested, depth + 1);
    if (error) return error;
  }
  return null;
}

export function validateMongoAggregationPipeline(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) {
    return "pipeline must be a non-empty array.";
  }
  if (value.length > MONGO_AGGREGATION_MAX_STAGES) {
    return `MongoDB aggregation supports at most ${MONGO_AGGREGATION_MAX_STAGES} stages.`;
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return "MongoDB aggregation pipeline must be JSON-serializable.";
  }
  if (new TextEncoder().encode(serialized).byteLength > MONGO_AGGREGATION_MAX_BYTES) {
    return `MongoDB aggregation pipeline exceeds ${MONGO_AGGREGATION_MAX_BYTES} bytes.`;
  }
  for (const stage of value) {
    if (!isPlainObject(stage) || Object.keys(stage).length !== 1) {
      return "Each MongoDB aggregation stage must be an object with exactly one stage key.";
    }
    const [name] = Object.keys(stage);
    if (!ALLOWED_MONGO_AGGREGATION_STAGES.has(name)) {
      return `MongoDB aggregation stage '${name}' is not allowed.`;
    }
    const error = nestedValidationError(stage[name], 1);
    if (error) return error;
  }
  return null;
}

export function asMongoAggregationPipeline(
  value: unknown,
): MongoAggregateDataQuery["pipeline"] | string {
  const error = validateMongoAggregationPipeline(value);
  return error ?? value as MongoAggregateDataQuery["pipeline"];
}

export function containsForbiddenMongoOperator(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenMongoOperator);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([key, nested]) => FORBIDDEN_MONGO_OPERATORS.has(key.toLowerCase()) || containsForbiddenMongoOperator(nested),
  );
}
