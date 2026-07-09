import { useEffect, useState } from "react";
import { Bot, CheckCircle2, Loader2, ShieldAlert, Trash2 } from "lucide-react";

import type { AiProviderMode, AiProviderStatus } from "@shared/types";
import { useT } from "@/i18n/use-t";
import { useSettings } from "@/state/settings";
import { cn } from "@/lib/utils";

import { FormHint, Row, Section, TabContainer, Toggle } from "./atoms";

const PROVIDER_OPTIONS: { value: AiProviderMode; labelKey: string }[] = [
  { value: "disabled", labelKey: "ai.provider.disabled" },
  { value: "openai-compatible", labelKey: "ai.provider.openaiCompatible" },
  { value: "cloud", labelKey: "ai.provider.cloud" },
];

export function AiTab() {
  const t = useT();
  const settings = useSettings((s) => s.settings.ai);
  const patch = useSettings((s) => s.patch);
  const [status, setStatus] = useState<AiProviderStatus | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"save" | "clear" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setStatus(await window.stela.ai.getStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const save = async () => {
    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      const next = await window.stela.ai.configure(
        {
          providerMode: settings.providerMode,
          baseUrl: settings.baseUrl,
          model: settings.model,
          sendResultSamples: settings.sendResultSamples,
          maxSampleRows: settings.maxSampleRows,
        },
        apiKey.trim() || null,
      );
      await patch({ ai: { hasApiKey: next.hasApiKey } });
      setStatus(next);
      setApiKey("");
      setNotice(t("ai.notice.saved"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const clearKey = async () => {
    setBusy("clear");
    setError(null);
    setNotice(null);
    try {
      const next = await window.stela.ai.clearApiKey();
      await patch({ ai: { hasApiKey: false } });
      setStatus(next);
      setNotice(t("ai.notice.keyCleared"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <TabContainer>
      <Section title={t("ai.title")} description={t("ai.description")}>
        <Row label={t("ai.provider.label")} description={t("ai.provider.description")}>
          <select
            value={settings.providerMode}
            onChange={(e) =>
              void patch({
                ai: { providerMode: e.target.value as AiProviderMode },
              })
            }
            className="w-56 rounded-md border border-border bg-background px-2 py-1.5 text-[12px]"
          >
            {PROVIDER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.labelKey)}
              </option>
            ))}
          </select>
        </Row>

        <Row label={t("ai.model.label")} description={t("ai.model.description")}>
          <input
            value={settings.model}
            onChange={(e) => void patch({ ai: { model: e.target.value } })}
            className="w-56 rounded-md border border-border bg-background px-2 py-1.5 text-[12px]"
            placeholder="gpt-4o-mini"
          />
        </Row>

        <Row label={t("ai.baseUrl.label")} description={t("ai.baseUrl.description")}>
          <input
            value={settings.baseUrl}
            onChange={(e) => void patch({ ai: { baseUrl: e.target.value } })}
            className="w-72 rounded-md border border-border bg-background px-2 py-1.5 text-[12px]"
            placeholder="https://api.openai.com/v1"
          />
        </Row>

        <Row label={t("ai.apiKey.label")} description={t("ai.apiKey.description")}>
          <div className="flex items-center gap-2">
            <input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              type="password"
              className="w-56 rounded-md border border-border bg-background px-2 py-1.5 text-[12px]"
              placeholder={settings.hasApiKey ? t("ai.apiKey.saved") : "sk-..."}
            />
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground disabled:opacity-50"
            >
              {busy === "save" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {t("common.save")}
            </button>
            <button
              type="button"
              onClick={() => void clearKey()}
              disabled={busy !== null || !settings.hasApiKey}
              className="rounded-md border border-border p-1.5 text-muted-foreground hover:text-foreground disabled:opacity-40"
              title={t("ai.apiKey.clear")}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </Row>
      </Section>

      <Section title={t("ai.privacy.title")} description={t("ai.privacy.description")}>
        <Row
          label={t("ai.samples.label")}
          description={t("ai.samples.description")}
        >
          <Toggle
            checked={settings.sendResultSamples}
            onChange={(v) => void patch({ ai: { sendResultSamples: v } })}
          />
        </Row>
        <Row label={t("ai.maxRows.label")} description={t("ai.maxRows.description")}>
          <input
            type="number"
            min={0}
            max={100}
            value={settings.maxSampleRows}
            onChange={(e) =>
              void patch({ ai: { maxSampleRows: Number(e.target.value) } })
            }
            className="w-20 rounded-md border border-border bg-background px-2 py-1.5 text-[12px]"
          />
        </Row>
      </Section>

      <Section title={t("ai.agent.title")} description={t("ai.agent.description")}>
        <Row
          label={t("ai.agent.maxIterations.label")}
          description={t("ai.agent.maxIterations.description")}
        >
          <input
            type="number"
            min={1}
            max={10000}
            value={settings.agentMaxIterations}
            onChange={(e) =>
              void patch({
                ai: {
                  agentMaxIterations: Math.min(
                    10_000,
                    Math.max(1, Number(e.target.value) || 1),
                  ),
                },
              })
            }
            className="w-20 rounded-md border border-border bg-background px-2 py-1.5 text-[12px]"
          />
        </Row>
        <Row
          label={t("ai.agent.wallClockMs.label")}
          description={t("ai.agent.wallClockMs.description")}
        >
          <input
            type="number"
            min={5000}
            step={1000}
            value={settings.agentWallClockMs}
            onChange={(e) =>
              void patch({
                ai: {
                  agentWallClockMs: Math.max(
                    5000,
                    Number(e.target.value) || 5000,
                  ),
                },
              })
            }
            className="w-28 rounded-md border border-border bg-background px-2 py-1.5 text-[12px]"
          />
        </Row>
        <Row
          label={t("ai.agent.allowMutations.label")}
          description={t("ai.agent.allowMutations.description")}
        >
          <Toggle
            checked={settings.agentAllowMutations}
            onChange={(v) => void patch({ ai: { agentAllowMutations: v } })}
          />
        </Row>
      </Section>

      <div
        className={cn(
          "flex items-start gap-2 rounded-md border px-3 py-2 text-[12px]",
          error
            ? "border-destructive/40 bg-destructive/10 text-destructive"
            : "border-border/60 bg-card/40 text-muted-foreground",
        )}
      >
        {error ? <ShieldAlert className="h-4 w-4" /> : settings.hasApiKey ? <CheckCircle2 className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
        <div>
          {error ??
            notice ??
            (status?.hasApiKey || settings.hasApiKey
              ? t("ai.status.ready", { backend: status?.credentialBackend ?? "safeStorage" })
              : t("ai.status.needsKey"))}
          <FormHint>{t("ai.status.noRag")}</FormHint>
        </div>
      </div>
    </TabContainer>
  );
}
