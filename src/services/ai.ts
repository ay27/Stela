import type {
  AiCompleteRequest,
  AiCompleteResponse,
  AiProviderStatus,
  AiSettings,
} from "@shared/types";

export function getAiStatus(): Promise<AiProviderStatus> {
  return window.stela.ai.getStatus();
}

export function configureAi(
  settings: Partial<Omit<AiSettings, "hasApiKey">>,
  apiKey?: string | null,
): Promise<AiProviderStatus> {
  return window.stela.ai.configure(settings, apiKey);
}

export function completeAi(
  request: AiCompleteRequest,
): Promise<AiCompleteResponse> {
  return window.stela.ai.complete(request);
}

