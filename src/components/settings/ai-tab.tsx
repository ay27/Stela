import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  CheckCircle2,
  Loader2,
  Plus,
  ShieldAlert,
  Trash2,
} from "lucide-react";

import type {
  AiContextWindow,
  AiProviderProfile,
  AiProviderStatus,
} from "@shared/types";
import { useT } from "@/i18n/use-t";
import { useSettings } from "@/state/settings";
import { cn } from "@/lib/utils";

import { FormHint, Row, Section, TabContainer, Toggle } from "./atoms";

const CONTEXT_WINDOWS: AiContextWindow[] = [
  64_000, 128_000, 200_000, 256_000, 1_000_000,
];

const fieldClass =
  "w-full rounded-md border border-border bg-background px-2 py-1.5 text-[12px]";

function newProfileId(): string {
  return crypto.randomUUID();
}

function emptyProfile(vendorId: string, vendorName: string): AiProviderProfile {
  return {
    id: newProfileId(),
    name: vendorName,
    vendorId,
    model: "",
    baseUrl: vendorId === "custom" ? "https://api.openai.com/v1" : "",
    contextWindow: 128_000,
    hasApiKey: false,
  };
}

function vendorLabel(
  vendors: AiProviderStatus["vendors"],
  vendorId: string,
): string {
  return vendors.find((v) => v.id === vendorId)?.name ?? vendorId;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-[12px] font-medium text-foreground">{label}</span>
      {hint ? <p className="text-[10px] text-muted-foreground">{hint}</p> : null}
      {children}
    </label>
  );
}

export function AiTab() {
  const t = useT();
  const settings = useSettings((s) => s.settings.ai);
  const patch = useSettings((s) => s.patch);
  const [status, setStatus] = useState<AiProviderStatus | null>(null);
  const [draft, setDraft] = useState<AiProviderProfile | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<
    "save" | "clear" | "delete" | "activate" | "inline" | null
  >(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const vendors = status?.vendors ?? [];
  const profiles = status?.profiles ?? settings.profiles ?? [];
  const activeProfileId = status?.activeProfileId ?? settings.activeProfileId;
  const aiEnabled = settings.providerMode !== "disabled";
  const completionProfile = profiles.find(
    (profile) => profile.id === settings.completionProfileId,
  );
  const isDraftUnsaved = Boolean(draft && !profiles.some((p) => p.id === draft.id));
  const isCustom = draft?.vendorId === "custom";

  const vendorModels = useMemo(() => {
    if (!draft) return [];
    return vendors.find((v) => v.id === draft.vendorId)?.models ?? [];
  }, [draft, vendors]);

  const listItems = useMemo(() => {
    const items = [...profiles];
    if (draft && !profiles.some((p) => p.id === draft.id)) {
      items.unshift(draft);
    }
    return items;
  }, [profiles, draft]);

  const refresh = async (keepId?: string | null) => {
    const next = await window.stela.ai.getStatus();
    setStatus(next);
    const preferred =
      (keepId && next.profiles.find((p) => p.id === keepId)) ||
      next.profiles.find((p) => p.id === next.activeProfileId) ||
      next.profiles[0] ||
      null;
    setDraft(preferred);
    return next;
  };

  useEffect(() => {
    void refresh().catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }, []);

  const updateDraft = (patchProfile: Partial<AiProviderProfile>) => {
    setDraft((prev) => (prev ? { ...prev, ...patchProfile } : prev));
  };

  const selectProfile = (id: string) => {
    if (draft?.id === id) return;
    const found = profiles.find((p) => p.id === id);
    if (!found) return;
    setDraft(found);
    setApiKey("");
    setError(null);
    setNotice(null);
  };

  const onVendorChange = (vendorId: string) => {
    const vendor = vendors.find((v) => v.id === vendorId);
    const firstModel = vendor?.models[0];
    const keepName =
      draft?.name?.trim() &&
      draft.name !== vendorLabel(vendors, draft.vendorId);
    updateDraft({
      vendorId,
      name: keepName ? draft!.name : (vendor?.name ?? vendorId),
      model: firstModel?.id ?? (vendorId === "custom" ? draft?.model ?? "" : ""),
      baseUrl:
        vendorId === "custom" ? draft?.baseUrl || "https://api.openai.com/v1" : "",
      contextWindow: (firstModel?.contextWindow &&
      CONTEXT_WINDOWS.includes(firstModel.contextWindow as AiContextWindow)
        ? firstModel.contextWindow
        : draft?.contextWindow ?? 128_000) as AiContextWindow,
    });
  };

  const syncSettings = async (
    next: AiProviderStatus,
    completion?: {
      inlineCompletionEnabled: boolean;
      completionProfileId: string | null;
    },
  ) => {
    await patch({
      ai: {
        providerMode: next.providerMode,
        hasApiKey: next.hasApiKey,
        activeProfileId: next.activeProfileId,
        profiles: next.profiles,
        model: next.model,
        baseUrl: next.baseUrl,
        contextWindow: next.profiles.find((p) => p.id === next.activeProfileId)
          ?.contextWindow,
        ...completion,
      },
    });
  };

  const setInlineCompletion = async (
    completion: {
      inlineCompletionEnabled: boolean;
      completionProfileId: string | null;
    },
  ) => {
    setBusy("inline");
    setError(null);
    try {
      const next = await window.stela.ai.configure(completion);
      await syncSettings(next, completion);
      setStatus(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!draft || !draft.model.trim()) {
      setError(t("ai.profile.modelRequired"));
      return;
    }
    if (isCustom && !draft.baseUrl.trim()) {
      setError(t("ai.profile.baseUrlRequired"));
      return;
    }
    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      const nextProfiles = profiles.some((p) => p.id === draft.id)
        ? profiles.map((p) => (p.id === draft.id ? { ...draft } : p))
        : [...profiles, { ...draft }];
      const next = await window.stela.ai.configure(
        {
          providerMode: settings.providerMode,
          sendResultSamples: settings.sendResultSamples,
          maxSampleRows: settings.maxSampleRows,
          agentAllowMutations: settings.agentAllowMutations,
          activeProfileId: draft.id,
          profiles: nextProfiles,
        },
        apiKey.trim() || null,
        draft.id,
      );
      await syncSettings(next);
      setStatus(next);
      setDraft(next.profiles.find((p) => p.id === draft.id) ?? next.profiles[0] ?? null);
      setApiKey("");
      setNotice(t("ai.notice.saved"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const setActive = async () => {
    if (!draft || isDraftUnsaved) return;
    setBusy("activate");
    setError(null);
    setNotice(null);
    try {
      const next = await window.stela.ai.configure({
        activeProfileId: draft.id,
      });
      await syncSettings(next);
      setStatus(next);
      setNotice(t("ai.profile.setActiveDone"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const clearKey = async () => {
    if (!draft || isDraftUnsaved) return;
    setBusy("clear");
    setError(null);
    setNotice(null);
    try {
      const next = await window.stela.ai.clearApiKey(draft.id);
      await syncSettings(next);
      setStatus(next);
      setDraft(next.profiles.find((p) => p.id === draft.id) ?? null);
      setNotice(t("ai.notice.keyCleared"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const addProfile = () => {
    const preferred =
      vendors.find((v) => v.id === "deepseek") ??
      vendors.find((v) => v.id === "openai") ??
      vendors.find((v) => v.id === "custom") ??
      vendors[0];
    const created = emptyProfile(
      preferred?.id ?? "custom",
      preferred?.name ?? "Custom",
    );
    if (preferred?.models[0]) {
      created.model = preferred.models[0].id;
      const cw = preferred.models[0].contextWindow;
      if (CONTEXT_WINDOWS.includes(cw as AiContextWindow)) {
        created.contextWindow = cw as AiContextWindow;
      }
    } else {
      created.model = "gpt-4o-mini";
    }
    setDraft(created);
    setApiKey("");
    setError(null);
    setNotice(t("ai.profile.draftNew"));
  };

  const deleteProfile = async () => {
    if (!draft || isDraftUnsaved) {
      if (isDraftUnsaved) {
        setDraft(
          profiles.find((p) => p.id === activeProfileId) ?? profiles[0] ?? null,
        );
        setNotice(null);
      }
      return;
    }
    if (profiles.length <= 1) return;
    setBusy("delete");
    setError(null);
    setNotice(null);
    try {
      const nextProfiles = profiles.filter((p) => p.id !== draft.id);
      const nextActive =
        activeProfileId === draft.id ? nextProfiles[0]?.id : activeProfileId;
      const next = await window.stela.ai.configure({
        profiles: nextProfiles,
        activeProfileId: nextActive,
      });
      const deletedCompletionProfile =
        settings.completionProfileId === draft.id;
      await syncSettings(
        next,
        deletedCompletionProfile
          ? {
              completionProfileId: null,
              inlineCompletionEnabled: false,
            }
          : undefined,
      );
      setStatus(next);
      setDraft(
        next.profiles.find((p) => p.id === next.activeProfileId) ??
          next.profiles[0] ??
          null,
      );
      setNotice(t("ai.profile.deleted"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const setEnabled = (enabled: boolean) => {
    void patch({
      ai: { providerMode: enabled ? "openai-compatible" : "disabled" },
    });
    void window.stela.ai
      .configure({
        providerMode: enabled ? "openai-compatible" : "disabled",
      })
      .then((next) => {
        setStatus(next);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  return (
    <TabContainer>
      <Section title={t("ai.title")} description={t("ai.description")}>
        <Row label={t("ai.enabled.label")} description={t("ai.enabled.description")}>
          <Toggle checked={aiEnabled} onChange={setEnabled} />
        </Row>
      </Section>

      <Section
        title={t("ai.inlineCompletion.title")}
        description={t("ai.inlineCompletion.description")}
      >
        <Row
          label={t("ai.inlineCompletion.enabled.label")}
          description={t("ai.inlineCompletion.enabled.description")}
        >
          <Toggle
            checked={settings.inlineCompletionEnabled}
            disabled={
              busy !== null ||
              (!settings.inlineCompletionEnabled &&
                (profiles.length === 0 || !completionProfile))
            }
            onChange={(enabled) => {
              if (enabled && !completionProfile) return;
              void setInlineCompletion({
                inlineCompletionEnabled: enabled,
                completionProfileId: completionProfile?.id ?? null,
              });
            }}
          />
        </Row>
        <Row
          label={t("ai.inlineCompletion.profile.label")}
          description={
            completionProfile?.hasApiKey
              ? t("ai.inlineCompletion.profile.ready")
              : t("ai.inlineCompletion.profile.noKey")
          }
        >
          <select
            value={completionProfile?.id ?? ""}
            disabled={busy !== null || profiles.length === 0}
            onChange={(event) => {
              const completionProfileId = event.target.value || null;
              void setInlineCompletion({
                completionProfileId,
                inlineCompletionEnabled:
                  completionProfileId !== null &&
                  settings.inlineCompletionEnabled,
              });
            }}
            className="w-52 rounded-md border border-border bg-background px-2 py-1.5 text-[12px]"
          >
            <option value="" disabled>
              {t("ai.inlineCompletion.profile.placeholder")}
            </option>
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
                {profile.hasApiKey ? "" : ` · ${t("ai.profile.noKey")}`}
              </option>
            ))}
          </select>
        </Row>
      </Section>

      <div className="mb-6 flex min-h-[360px] overflow-hidden rounded-md border border-border">
        <div className="flex w-52 flex-none flex-col border-r border-border bg-muted/20">
          <button
            type="button"
            onClick={addProfile}
            disabled={busy !== null}
            className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs font-medium text-foreground hover:bg-accent disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" />
            {t("ai.profile.add")}
          </button>
          <div className="flex-1 overflow-auto py-1">
            {listItems.length === 0 ? (
              <div className="px-3 py-6 text-center text-[11px] text-muted-foreground">
                {t("ai.profile.empty")}
              </div>
            ) : (
              listItems.map((profile) => {
                const selected = draft?.id === profile.id;
                const unsaved =
                  draft?.id === profile.id &&
                  !profiles.some((p) => p.id === profile.id);
                const isActive =
                  !unsaved && profile.id === activeProfileId;
                return (
                  <button
                    key={profile.id}
                    type="button"
                    onClick={() =>
                      unsaved ? undefined : selectProfile(profile.id)
                    }
                    className={cn(
                      "flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left",
                      selected
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                    )}
                  >
                    <div className="flex w-full items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
                        {profile.name || t("ai.profile.unnamed")}
                      </span>
                      {isActive ? (
                        <span className="flex-none rounded bg-primary/15 px-1 py-0.5 text-[9px] font-medium text-primary">
                          {t("ai.profile.inUse")}
                        </span>
                      ) : null}
                      {unsaved ? (
                        <span className="flex-none rounded bg-amber-500/15 px-1 py-0.5 text-[9px] font-medium text-amber-700 dark:text-amber-400">
                          {t("ai.profile.unsaved")}
                        </span>
                      ) : null}
                    </div>
                    <span className="w-full truncate text-[10px]">
                      {vendorLabel(vendors, profile.vendorId)}
                      {profile.model ? ` · ${profile.model}` : ""}
                      {!profile.hasApiKey && !unsaved
                        ? ` · ${t("ai.profile.noKey")}`
                        : ""}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          {draft ? (
            <>
              <div className="flex-1 space-y-3 overflow-auto p-4">
                <Field
                  label={t("ai.profile.name")}
                  hint={t("ai.profile.nameDescription")}
                >
                  <input
                    value={draft.name}
                    onChange={(e) => updateDraft({ name: e.target.value })}
                    className={fieldClass}
                  />
                </Field>

                <Field
                  label={t("ai.vendor.label")}
                  hint={t("ai.vendor.description")}
                >
                  <select
                    value={draft.vendorId}
                    onChange={(e) => onVendorChange(e.target.value)}
                    className={fieldClass}
                  >
                    {vendors.map((vendor) => (
                      <option key={vendor.id} value={vendor.id}>
                        {vendor.name}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field
                  label={t("ai.model.label")}
                  hint={t("ai.model.description")}
                >
                  {vendorModels.length > 0 ? (
                    <select
                      value={draft.model}
                      onChange={(e) => {
                        const model = vendorModels.find(
                          (m) => m.id === e.target.value,
                        );
                        const cw = model?.contextWindow;
                        updateDraft({
                          model: e.target.value,
                          ...(cw &&
                          CONTEXT_WINDOWS.includes(cw as AiContextWindow)
                            ? { contextWindow: cw as AiContextWindow }
                            : {}),
                        });
                      }}
                      className={fieldClass}
                    >
                      {vendorModels.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={draft.model}
                      onChange={(e) => updateDraft({ model: e.target.value })}
                      className={fieldClass}
                      placeholder="gpt-4o-mini"
                    />
                  )}
                </Field>

                <Field
                  label={t("ai.apiKey.label")}
                  hint={t("ai.apiKey.description")}
                >
                  <div className="flex items-center gap-2">
                    <input
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      type="password"
                      className={cn(fieldClass, "flex-1")}
                      placeholder={
                        draft.hasApiKey ? t("ai.apiKey.saved") : "sk-..."
                      }
                    />
                    <button
                      type="button"
                      onClick={() => void clearKey()}
                      disabled={
                        busy !== null || !draft.hasApiKey || isDraftUnsaved
                      }
                      className="rounded-md border border-border p-1.5 text-muted-foreground hover:text-foreground disabled:opacity-40"
                      title={t("ai.apiKey.clear")}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </Field>

                {isCustom ? (
                  <details open className="rounded-md border border-border/60 p-3">
                    <summary className="cursor-pointer text-[12px] font-medium text-foreground">
                      {t("ai.profile.advanced")}
                    </summary>
                    <div className="mt-3 space-y-3">
                      <Field
                        label={t("ai.baseUrl.label")}
                        hint={t("ai.baseUrl.description")}
                      >
                        <input
                          value={draft.baseUrl}
                          onChange={(e) =>
                            updateDraft({ baseUrl: e.target.value })
                          }
                          className={fieldClass}
                          placeholder="https://api.openai.com/v1"
                        />
                      </Field>
                      <Field
                        label={t("ai.contextWindow.label")}
                        hint={t("ai.contextWindow.description")}
                      >
                        <select
                          value={String(draft.contextWindow)}
                          onChange={(e) =>
                            updateDraft({
                              contextWindow: Number(
                                e.target.value,
                              ) as AiContextWindow,
                            })
                          }
                          className={fieldClass}
                        >
                          <option value="64000">64K</option>
                          <option value="128000">128K</option>
                          <option value="200000">200K</option>
                          <option value="256000">256K</option>
                          <option value="1000000">1M</option>
                        </select>
                      </Field>
                    </div>
                  </details>
                ) : null}
              </div>

              <div className="flex flex-none flex-wrap items-center gap-2 border-t border-border px-4 py-2.5">
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={busy !== null}
                  className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground disabled:opacity-50"
                >
                  {busy === "save" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : null}
                  {t("ai.profile.save")}
                </button>
                {!isDraftUnsaved && draft.id !== activeProfileId ? (
                  <button
                    type="button"
                    onClick={() => void setActive()}
                    disabled={busy !== null}
                    className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-[12px] hover:bg-accent disabled:opacity-50"
                  >
                    {busy === "activate" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : null}
                    {t("ai.profile.setActive")}
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => void deleteProfile()}
                  disabled={
                    busy !== null ||
                    (!isDraftUnsaved && profiles.length <= 1)
                  }
                  className="ml-auto inline-flex items-center gap-1 rounded-md border border-border px-2 py-1.5 text-[12px] text-muted-foreground hover:text-destructive disabled:opacity-40"
                  title={t("ai.profile.delete")}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {isDraftUnsaved
                    ? t("ai.profile.discard")
                    : t("ai.profile.delete")}
                </button>
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center p-6 text-[12px] text-muted-foreground">
              {t("ai.profile.emptyHint")}
            </div>
          )}
        </div>
      </div>

      <div
        className={cn(
          "mb-6 flex items-start gap-2 rounded-md border px-3 py-2 text-[12px]",
          error
            ? "border-destructive/40 bg-destructive/10 text-destructive"
            : "border-border/60 bg-card/40 text-muted-foreground",
        )}
      >
        {error ? (
          <ShieldAlert className="mt-0.5 h-4 w-4 flex-none" />
        ) : draft?.hasApiKey || settings.hasApiKey ? (
          <CheckCircle2 className="mt-0.5 h-4 w-4 flex-none" />
        ) : (
          <Bot className="mt-0.5 h-4 w-4 flex-none" />
        )}
        <div>
          {error ??
            notice ??
            (draft?.hasApiKey || settings.hasApiKey
              ? t("ai.status.ready", {
                  backend: status?.credentialBackend ?? "safeStorage",
                })
              : t("ai.status.needsKey"))}
          <FormHint>{t("ai.status.noRag")}</FormHint>
        </div>
      </div>

      <Section
        title={t("ai.policy.title")}
        description={t("ai.policy.description")}
      >
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
    </TabContainer>
  );
}
