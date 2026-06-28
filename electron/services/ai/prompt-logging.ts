import type { AiContextBundle } from "./context-builder";

export interface AiPromptParts {
  system: string;
  user: string;
}

export function formatPromptDebugLog(
  bundle: AiContextBundle,
  prompt: AiPromptParts,
): string {
  const connector = bundle.request.context.connector;
  return [
    "=== Stela AI Prompt ===",
    `action=${bundle.request.action}`,
    `locale=${bundle.request.locale ?? "en"}`,
    `source=${bundle.request.context.source}`,
    bundle.request.context.connectionName
      ? `connection=${bundle.request.context.connectionName}`
      : "",
    connector?.kind ? `connector=${connector.kind}` : "",
    connector?.dialect ? `dialect=${connector.dialect}` : "",
    bundle.summary.length > 0 ? `summary=${bundle.summary.join(" | ")}` : "",
    "--- system ---",
    prompt.system,
    "--- user ---",
    prompt.user,
    "=== End Stela AI Prompt ===",
  ]
    .filter(Boolean)
    .join("\n");
}

