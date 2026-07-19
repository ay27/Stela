import type {
  AiCompleteRequest,
  AiCompleteResponse,
  AiParseSqlQueryRequest,
  AiParseSqlQueryResponse,
  AiProviderStatus,
  AiSettings,
} from "@shared/types";

export function getAiStatus(): Promise<AiProviderStatus> {
  return window.stela.ai.getStatus();
}

export function configureAi(
  settings: Partial<Omit<AiSettings, "hasApiKey">>,
  apiKey?: string | null,
  profileId?: string | null,
): Promise<AiProviderStatus> {
  return window.stela.ai.configure(settings, apiKey, profileId);
}

export function completeAi(
  request: AiCompleteRequest,
): Promise<AiCompleteResponse> {
  return window.stela.ai.complete(request);
}

/** NL 问题 → SQL 索引 filter JSON。AI 只翻译不作答，实际命中走确定性索引。 */
export function parseSqlQueryAi(
  request: AiParseSqlQueryRequest,
): Promise<AiParseSqlQueryResponse> {
  return window.stela.ai.parseSqlQuery(request);
}
