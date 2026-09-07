import type { AiSettings, AiProviderProfile } from "../../shared/types";
import type { ISemanticRow, ISemanticResponse } from "../../shared/semantic";
import { SemanticExecution } from "./semantic-execution";
import { hasSemanticGrant, saveSemanticGrant, semanticGrantEpoch, semanticGrantSignal } from "./semantic-grants";
import { createTransportForProfile, getActiveProfile, loadApiKey } from "./provider";
import { assistantText } from "./agent-prompt";
import { redactForPrompt } from "./redaction";

const caches = new Map<string, Map<string, ISemanticRow>>();
export function clearSemanticWorkspace(vault: string, session: string): void {
  caches.get(`${vault}\0${session}`)?.clear();
  // Keep the map registered: an active run still holds this exact cache object.
}
export function createSemanticAgent(input: {
  vault: string; session: string; slug: string; settings: AiSettings; profile: AiProviderProfile;
  signal: AbortSignal; chinese: boolean;
  approve: (description: string, allow: string, signal: AbortSignal) => Promise<boolean | string>;
  onProgress: (response: ISemanticResponse, model: string) => void;
  onUsage: (usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }) => void;
}): SemanticExecution {
  const profile = getActiveProfile(input.settings, input.settings.semanticProfileId ?? input.profile.id);
  const identity = JSON.stringify([profile.vendorId, profile.baseUrl, profile.model]);
  let recipient = profile.vendorId;
  try { const url = new URL(profile.baseUrl); recipient = url.origin + url.pathname; } catch { /* builtin provider */ }
  const cacheKey = `${input.vault}\0${input.session}`;
  if (!caches.has(cacheKey)) caches.set(cacheKey, new Map());
  // Populated caches are cleared by the owning workspace's disposal callback.
  // Do not detach an active run's cache from the reset registry.
  const epoch = semanticGrantEpoch(input.vault);
  let approval: Promise<boolean> | null = null;
  return new SemanticExecution({
    identity: identity + profile.reasoningEffort, signal: AbortSignal.any([input.signal, semanticGrantSignal(input.vault)]),
    budget: input.settings.semanticBudget, cache: caches.get(cacheKey),
    authorize: async (batch, budget, signal) => {
      if (semanticGrantEpoch(input.vault) !== epoch) throw new Error("Semantic authorization revoked; start a new run to authorize again");
      if (await hasSemanticGrant(input.vault, identity, budget)) return true;
      approval ??= (async () => {
        const allow = input.chinese ? "允许批量发送" : "Allow batch transmission";
        const fields = Object.keys(batch.records[0]?.data ?? {}).join(", ");
        const description = input.chinese
          ? `将选定数据列批量发送给 ${profile.name} / ${profile.model}。接收端：${recipient}。本批 ${batch.records.length} 条，列：${fields}。每次任务最多 ${budget.records} 条记录或候选对、${budget.requests} 次请求、${budget.tokens} token。授权适用于当前 Vault 和该模型，可在设置中撤销。`
          : `Send selected columns to ${profile.name} / ${profile.model} (${recipient}). Batch: ${batch.records.length} records; fields: ${fields}. Per-run limits: ${budget.records} records/pairs, ${budget.requests} requests, ${budget.tokens} tokens. Grant applies to this Vault and recipient model; revoke in Settings.`;
        const answer = await input.approve(redactForPrompt(description), allow, signal);
        if (answer !== allow || signal.aborted) return false;
        await saveSemanticGrant(input.vault, identity, budget, epoch);
        return true;
      })();
      return approval;
    },
    complete: async (system, user, maxTokens, signal) => {
      if (semanticGrantEpoch(input.vault) !== epoch) throw new Error("Semantic authorization revoked");
      const apiKey = await loadApiKey(input.vault, input.slug, profile.id);
      const transport = createTransportForProfile(input.settings, apiKey, profile.id);
      if (Buffer.byteLength(system + user, "utf8") + maxTokens > transport.model.contextWindow) throw new Error("Semantic batch exceeds model context; split the input");
      const answer = await transport.models.completeSimple(transport.model, {
        systemPrompt: system, messages: [{ role: "user", content: user, timestamp: Date.now() }],
      }, { signal, maxTokens, maxRetries: 0, reasoning: transport.reasoning.effective });
      input.onUsage(answer.usage);
      if (answer.stopReason === "error" || answer.stopReason === "aborted") throw new Error(answer.errorMessage ?? "Semantic model failed");
      return { text: assistantText(answer), tokens: answer.usage.totalTokens };
    },
    onProgress: (response) => input.onProgress(response, profile.model),
  });
}
