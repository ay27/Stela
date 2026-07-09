/**
 * Connections 设置面板（同时被 Settings Dialog 的 Connections tab 和独立的
 * ConnectionsDialog 复用）。
 *
 * UI 结构：左侧已保存连接列表 + 右侧编辑表单（name / kind / JSON config / Test / Save）。
 *
 * 顶部仍显示 M3 阶段的明文存储 banner —— M5 接 keyring 后移除。
 *
 * 提取时机：M4 把这块从 ConnectionsDialog 内部抽出，让 Settings Dialog 和独立 Dialog 共用
 * 同一份代码，保证两个入口编辑同一份数据时行为完全一致。
 */

import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FolderOpen,
  Loader2,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Star,
  Trash2,
} from "lucide-react";
import type { ConnectorKindMeta, TestResult } from "@/contracts";
import { electronConnectorRegistry } from "@/services/connectors/electron-connector";
import { useConnections } from "@/state/connections";
import type { ConnectionEntry } from "@/services/connections";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { describeBackend, usePrivacyStatus } from "@/services/privacy";
import {
  ConnectorForm,
  normalizeObjectSchema,
} from "@/components/settings/connector-form";
import {
  useAutocompleteCache,
  type AutocompleteStatus,
} from "@/editor/runsql/autocomplete-cache";
import {
  ensureAutocompleteFor,
  refreshAutocompleteFor,
} from "@/editor/runsql/fetch-schema";
import {
  dumpSchemaToMarkdown,
  type DumpFailure,
  type DumpProgress,
} from "@/services/schema-dump";
import { useT } from "@/i18n/use-t";

type ConfigEditMode = "form" | "json";

interface DraftState {
  /** 编辑中条目原始 name；null 表示是新建 */
  originalName: string | null;
  name: string;
  kind: string;
  /** 单一真实数据来源：表单 / JSON 视图都最终落到这里 */
  config: Record<string, unknown>;
  /** JSON 视图的文本镜像；切到 JSON 模式时由 config stringify 而来 */
  configText: string;
  /** 当前编辑模式；schema 不识别时会被强制锁到 json */
  mode: ConfigEditMode;
  /** JSON 模式下 parse 失败的错误信息；form 模式始终为 null */
  jsonError: string | null;
}

interface TestState {
  status: "idle" | "running" | "ok" | "err";
  message?: string;
  latencyMs?: number;
}

const EMPTY_DRAFT: DraftState = {
  originalName: null,
  name: "",
  kind: "",
  config: {},
  configText: "{}",
  mode: "form",
  jsonError: null,
};

function asConfigObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

// 与 main 端 electron/services/secrets.ts 的 SECRET_KEYS 对齐：用于判断某个 config
// 字段是否是「凭据型」。secret 走 per-device shard（secrets_<slug>.json）存储，
// 换设备 / 清缓存后本机可能没有该 secret —— 用它检测并提示用户在本机补填一次。
const SECRET_FIELD_NAMES = new Set([
  "password",
  "token",
  "secret",
  "apikey",
  "api_key",
  "accesskey",
  "access_key",
  "authorization",
]);

function isSecretFieldName(name: string): boolean {
  return SECRET_FIELD_NAMES.has(name.toLowerCase());
}

/**
 * 计算「connector schema 声明了、但当前设备 config 里为空/缺失」的 secret 字段。
 * 这些就是需要在本机补填的密钥（其它设备 shard 里的值本机解不开）。
 */
function missingDeviceSecrets(
  schema: unknown,
  config: Record<string, unknown>,
): string[] {
  const obj = normalizeObjectSchema(schema);
  if (!obj?.properties) return [];
  const out: string[] = [];
  for (const [name, field] of Object.entries(obj.properties)) {
    const isSecret = isSecretFieldName(name) || field.format === "password";
    if (!isSecret) continue;
    const v = config[name];
    if (v === undefined || v === null || v === "") out.push(name);
  }
  return out;
}

/** 顶层 shallow 比较两个 config（顺序无关，值用 JSON 串比）。 */
function configsEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false;
  }
  return true;
}

/**
 * 按 main 端 upsert 的「空 secret 保留」语义，算出保存后 store 会持有的等效 config：
 *   - 非 secret 字段：取草稿值；
 *   - secret 字段：草稿非空则用草稿值，否则保留 store 现值（空值不擦除）。
 *
 * 自动保存用它和 store 现值比对，避免「保存→store 回填→再次判定有差异→再保存」死循环。
 */
function effectiveStoredConfig(
  next: Record<string, unknown>,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(next)) {
    if (!isSecretFieldName(k)) out[k] = v;
  }
  const secretKeys = new Set(
    [...Object.keys(next), ...Object.keys(stored)].filter(isSecretFieldName),
  );
  for (const k of secretKeys) {
    const nv = next[k];
    if (typeof nv === "string" && nv.length > 0) out[k] = nv;
    else if (stored[k] !== undefined) out[k] = stored[k];
  }
  return out;
}

// 模块级常量 —— 用作 zustand selector 里 `byConnection[name]` 缺失时的 fallback。
// 如果用内联字面量 `{ kind: "idle" }`，每次 selector 求值都会产生新引用，
// zustand 会认为状态变了→组件重渲染→selector 再次返回新引用，进入死循环
// ("Maximum update depth exceeded")。
const AUTOCOMPLETE_STATUS_IDLE: AutocompleteStatus = { kind: "idle" };

export function ConnectionsTab() {
  const t = useT();
  const entries = useConnections((s) => s.entries);
  const reload = useConnections((s) => s.reload);
  const upsert = useConnections((s) => s.upsert);
  const remove = useConnections((s) => s.remove);

  const [kinds, setKinds] = useState<ConnectorKindMeta[]>([]);
  const [kindsLoading, setKindsLoading] = useState(false);
  const [kindsError, setKindsError] = useState<string | null>(null);

  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
  const [testState, setTestState] = useState<TestState>({ status: "idle" });
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    void reload();
    setKindsLoading(true);
    setKindsError(null);
    electronConnectorRegistry
      .listKinds()
      .then((m) => setKinds(m))
      .catch((err) => setKindsError(errMessage(err)))
      .finally(() => setKindsLoading(false));
  }, [reload]);

  const entryNames = useMemo(() => Object.keys(entries).sort(), [entries]);

  useEffect(() => {
    if (selected && entries[selected]) {
      const e = entries[selected];
      const cfg = asConfigObject(e.config);
      setDraft({
        originalName: selected,
        name: selected,
        kind: e.kind,
        config: cfg,
        configText: stringifyConfig(cfg),
        mode: "form",
        jsonError: null,
      });
      setTestState({ status: "idle" });
      setSaveError(null);
    }
  }, [selected, entries]);

  useEffect(() => {
    if (selected !== null) return;
    if (entryNames.length > 0) {
      setSelected(entryNames[0]);
    }
  }, [selected, entryNames]);

  // 用户切到某个已存在的连接 → 若缓存处于 idle 就顺手 kick 一次 ensure。
  // 这样进设置面板就能看到徽章从 idle → loading → ready/error 的状态流转，
  // 不必非得点 Run SQL 才有反应。失败状态下不自动重拉（避免无限循环），
  // 用户仍可点 "刷新" 按钮触发 refreshAutocompleteFor。
  useEffect(() => {
    if (!selected) return;
    const st = useAutocompleteCache.getState().getStatus(selected);
    if (st.kind === "idle") {
      void ensureAutocompleteFor(selected);
    }
  }, [selected]);

  const startNew = useCallback(() => {
    const defaultKind = kinds[0]?.kind ?? "";
    const defaultConfig = asConfigObject(kinds[0]?.defaultConfig);
    setSelected(null);
    setDraft({
      originalName: null,
      name: "",
      kind: defaultKind,
      config: defaultConfig,
      configText: stringifyConfig(defaultConfig),
      mode: "form",
      jsonError: null,
    });
    setTestState({ status: "idle" });
    setSaveError(null);
  }, [kinds]);

  const onKindChange = useCallback(
    (k: string) => {
      const meta = kinds.find((x) => x.kind === k);
      setDraft((d) => {
        // 切 kind：如果现有 config 看起来还是「空模板」（用户没填），用新 kind
        // 的 defaultConfig 替换，避免把 mysql 的 {host,port,user...} 残留带进
        // http connector。判定标准：当前 config 与上一 kind 的 defaultConfig
        // 完全一致（没动），或 config 为空对象。
        const prevMeta = kinds.find((x) => x.kind === d.kind);
        const prevDefault = asConfigObject(prevMeta?.defaultConfig);
        const looksUntouched =
          Object.keys(d.config).length === 0 ||
          stringifyConfig(d.config) === stringifyConfig(prevDefault);
        const nextConfig =
          meta && looksUntouched
            ? asConfigObject(meta.defaultConfig)
            : d.config;
        return {
          ...d,
          kind: k,
          config: nextConfig,
          configText: stringifyConfig(nextConfig),
          jsonError: null,
        };
      });
      setTestState({ status: "idle" });
    },
    [kinds],
  );

  /**
   * 对外统一入口：取出 form / json 模式下当前真实 config。
   * - form 模式：直接返回 draft.config
   * - json 模式：parse draft.configText；失败返回 error
   */
  const resolveDraftConfig = ():
    | { ok: true; value: Record<string, unknown> }
    | { ok: false; error: string } => {
    if (draft.mode === "form") {
      return { ok: true, value: draft.config };
    }
    try {
      const parsed = JSON.parse(draft.configText || "{}");
      return { ok: true, value: asConfigObject(parsed) };
    } catch (err) {
      return {
        ok: false,
        error: t("connections.error.jsonParse", { message: errMessage(err) }),
      };
    }
  };

  const runTest = async (kind: string, config: unknown) => {
    setTestState({ status: "running" });
    try {
      const res: TestResult = await electronConnectorRegistry.test(kind, config);
      setTestState({
        status: res.ok ? "ok" : "err",
        message: res.message,
        latencyMs: res.latencyMs,
      });
    } catch (err) {
      setTestState({ status: "err", message: errMessage(err) });
    }
  };

  const onTest = async () => {
    if (!draft.kind) {
      setTestState({ status: "err", message: t("connections.error.chooseKind") });
      return;
    }
    const parsed = resolveDraftConfig();
    if (!parsed.ok) {
      setTestState({ status: "err", message: parsed.error });
      return;
    }
    await runTest(draft.kind, parsed.value);
  };

  const onSubmit = async (ev: FormEvent) => {
    ev.preventDefault();
    setSaveError(null);
    const trimmed = draft.name.trim();
    if (!trimmed) {
      setSaveError(t("connections.error.nameRequired"));
      return;
    }
    if (!draft.kind) {
      setSaveError(t("connections.error.kindRequired"));
      return;
    }
    const parsed = resolveDraftConfig();
    if (!parsed.ok) {
      setSaveError(parsed.error);
      return;
    }
    if (
      draft.originalName !== trimmed &&
      entries[trimmed] !== undefined
    ) {
      setSaveError(t("connections.error.duplicateName", { name: trimmed }));
      return;
    }
    try {
      // schemaDir 不在主表单里编辑，由 SchemaDumpPanel 单独管理。保存连接时必须
      // 保留已存条目的 schemaDir，否则主表单 upsert 会把它清空（显示“未设置目录”）。
      const existing = draft.originalName
        ? entries[draft.originalName]
        : undefined;
      const entry: ConnectionEntry = {
        kind: draft.kind,
        config: parsed.value,
        ...(existing?.schemaDir ? { schemaDir: existing.schemaDir } : {}),
      };
      if (draft.originalName && draft.originalName !== trimmed) {
        await remove(draft.originalName);
      }
      await upsert(trimmed, entry);
      setSelected(trimmed);
      // upsert 会 invalidate 补全缓存（config 可能变了）。保存后立刻重拉，让用户看到
      // loading → ready，而不是停在“未加载”——此时 store 已是含本机 secret 的新 entry。
      void ensureAutocompleteFor(trimmed);
    } catch (err) {
      setSaveError(errMessage(err));
    }
  };

  /**
   * 自动保存已有连接的改动（填密钥 / 改 config）。保存后顺手重拉补全 + 跑一次连接测试，
   * 这样用户「填密钥 → 从上往下点」时，补全/同步表结构等动作不再因为没手动保存而失败。
   */
  const autoSaveDraft = async (
    name: string,
    config: Record<string, unknown>,
  ) => {
    const existing = entries[name];
    const entry: ConnectionEntry = {
      kind: draft.kind,
      config,
      ...(existing?.schemaDir ? { schemaDir: existing.schemaDir } : {}),
    };
    try {
      await upsert(name, entry);
      void ensureAutocompleteFor(name);
      void runTest(draft.kind, config);
    } catch (err) {
      setSaveError(errMessage(err));
    }
  };

  // 防抖自动保存：仅对「已存在、未改名、config 合法且确有变化」的连接生效。
  // 用 effectiveStoredConfig 按 upsert 的保留语义比对，确保保存→store 回填后判定相等，
  // 不会反复触发（清空密钥也不会触发保存，因为空值会被保留为现值）。
  useEffect(() => {
    if (!draft.originalName) return;
    if (draft.name.trim() !== draft.originalName) return;
    if (draft.mode === "json" && draft.jsonError) return;
    const parsed = resolveDraftConfig();
    if (!parsed.ok) return;
    const stored = entries[draft.originalName];
    if (!stored) return;
    const storedConfig = asConfigObject(stored.config);
    if (configsEqual(effectiveStoredConfig(parsed.value, storedConfig), storedConfig)) {
      return;
    }
    const handle = setTimeout(() => {
      void autoSaveDraft(draft.originalName as string, parsed.value);
    }, 600);
    return () => clearTimeout(handle);
  }, [draft, entries]);

  /** form 模式下 ConnectorForm 触发的字段写入。 */
  const onConfigChange = (next: Record<string, unknown>) => {
    setDraft((d) => ({
      ...d,
      config: next,
      // 同步 textarea 镜像；切到 json view 立刻看到新值，不会回到旧版本
      configText: stringifyConfig(next),
      jsonError: null,
    }));
  };

  /** json 模式下 textarea 输入。每次尝试 parse；失败仅留 jsonError，不破坏 config。 */
  const onConfigTextChange = (text: string) => {
    setDraft((d) => {
      const next: DraftState = { ...d, configText: text };
      try {
        const parsed = JSON.parse(text || "{}");
        next.config = asConfigObject(parsed);
        next.jsonError = null;
      } catch (err) {
        next.jsonError = errMessage(err);
      }
      return next;
    });
  };

  /** Form ↔ JSON 切换。切到 json 时显式重 stringify 一次以反映最新对象。 */
  const switchMode = (next: ConfigEditMode) => {
    setDraft((d) => {
      if (d.mode === next) return d;
      if (next === "json") {
        return {
          ...d,
          mode: "json",
          configText: stringifyConfig(d.config),
          jsonError: null,
        };
      }
      // 切回 form：以 d.config 为准（json 输入未 parse 成功时的 textarea 文本被丢弃）
      return {
        ...d,
        mode: "form",
        configText: stringifyConfig(d.config),
        jsonError: null,
      };
    });
  };

  /**
   * 设为默认连接：同一时间至多一个连接为默认，先把其它已标记的连接清掉，
   * 再把目标连接标记上。默认连接会被 `firstConnectionName` 优先选中
   * （新文档 / Agent 面板没有显式选择连接时的兜底）。
   */
  const setDefaultConnection = useCallback(
    async (name: string) => {
      const target = entries[name];
      if (!target) return;
      for (const [n, e] of Object.entries(entries)) {
        if (n !== name && e.isDefault) {
          await upsert(n, { ...e, isDefault: false });
        }
      }
      await upsert(name, { ...target, isDefault: true });
    },
    [entries, upsert],
  );

  const onDelete = async () => {
    if (!draft.originalName) return;
    const ok = window.confirm(
      t("connections.deleteConfirm", { name: draft.originalName }),
    );
    if (!ok) return;
    try {
      await remove(draft.originalName);
      setSelected(null);
      setDraft(EMPTY_DRAFT);
    } catch (err) {
      setSaveError(errMessage(err));
    }
  };

  return (
    <div className="flex h-full flex-col">
      <CredentialBanner />

      <div className="flex flex-1 min-h-0">
        <div className="flex w-52 flex-none flex-col border-r border-border">
          <button
            type="button"
            onClick={startNew}
            className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs font-medium text-foreground hover:bg-accent"
          >
            <Plus className="h-3.5 w-3.5" />
            {t("connections.new")}
          </button>
          <div className="flex-1 overflow-auto py-1">
            {entryNames.length === 0 ? (
              <div className="px-3 py-6 text-center text-[11px] text-muted-foreground">
                {t("connections.empty")}
              </div>
            ) : (
              entryNames.map((name) => {
                const e = entries[name];
                const active = selected === name;
                return (
                  <button
                    key={name}
                    type="button"
                    onClick={() => setSelected(name)}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left",
                      active
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                    )}
                  >
                    <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                      <span className="truncate text-[12px] font-medium text-foreground">
                        {name}
                      </span>
                      <span className="truncate text-[10px]">
                        {kinds.find((k) => k.kind === e.kind)?.displayName ??
                          e.kind}
                      </span>
                    </div>
                    <span
                      role="button"
                      tabIndex={-1}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        if (!e.isDefault) void setDefaultConnection(name);
                      }}
                      title={
                        e.isDefault
                          ? t("connections.isDefault")
                          : t("connections.setDefault")
                      }
                      className={cn(
                        "flex h-4 w-4 flex-none cursor-pointer items-center justify-center rounded hover:bg-accent",
                        e.isDefault
                          ? "text-amber-500"
                          : "text-muted-foreground/30 hover:text-muted-foreground",
                      )}
                    >
                      <Star
                        className="h-3 w-3"
                        fill={e.isDefault ? "currentColor" : "none"}
                      />
                    </span>
                    <AutocompleteStatusDot connectionName={name} />
                  </button>
                );
              })
            )}
          </div>
        </div>

        <form
          onSubmit={onSubmit}
          className="flex flex-1 min-w-0 flex-col overflow-hidden"
        >
          {kindsLoading ? (
            <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              {t("connections.loadingKinds")}
            </div>
          ) : kindsError ? (
            <div className="m-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
              {t("connections.kindsFailed", { message: kindsError })}
            </div>
          ) : (
            <div className="flex-1 overflow-auto px-4 py-3">
              <Field label={t("connections.field.name")}>
                <input
                  type="text"
                  value={draft.name}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, name: e.target.value }))
                  }
                  placeholder={t("connections.namePlaceholder")}
                  className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:border-primary focus:outline-none"
                />
                <p className="mt-1 text-[10px] text-muted-foreground">
                  {t("connections.frontmatterHint")}{" "}
                  <code>connection_name: {draft.name || "<name>"}</code>
                  {t("connections.frontmatterHintSuffix")}
                </p>
              </Field>

              <Field label={t("connections.field.kind")}>
                <Select
                  value={draft.kind}
                  onValueChange={onKindChange}
                  placeholder={t("connections.kindPlaceholder")}
                  options={kinds.map((k) => {
                    // 只展示对用户友好的名字；kind（http/mysql 等实现关键词）不外露。
                    const labelText = k.subprocess
                      ? `${k.displayName} · subprocess`
                      : k.displayName;
                    return {
                      value: k.kind,
                      label: labelText,
                      labelText,
                    };
                  })}
                  className="w-full"
                />
              </Field>

              <ConfigEditor
                kind={draft.kind}
                kinds={kinds}
                config={draft.config}
                configText={draft.configText}
                mode={draft.mode}
                jsonError={draft.jsonError}
                onModeChange={switchMode}
                onConfigChange={onConfigChange}
                onConfigTextChange={onConfigTextChange}
              />
              <ConfigHint kind={draft.kind} kinds={kinds} />

              {draft.originalName ? (
                <MissingSecretNotice
                  fields={missingDeviceSecrets(
                    kinds.find((k) => k.kind === draft.kind)?.configSchema,
                    draft.config,
                  )}
                />
              ) : null}

              <TestStateView state={testState} />

              {draft.originalName ? (
                <>
                  <AutocompleteStatusPanel
                    connectionName={draft.originalName}
                    onRefresh={() => {
                      // 重点：刷新 = invalidate + 立刻重新 ensure，让用户看到
                      // 徽章从 idle/ready 变成 loading → ready/error 的完整过程；
                      // 只调 invalidate 的话 UI 停在 "未加载" 就再也不动了。
                      void refreshAutocompleteFor(draft.originalName!);
                    }}
                  />
                  <SchemaDumpPanel
                    connectionName={draft.originalName}
                    entry={entries[draft.originalName]}
                    onSchemaDirChange={async (dir) => {
                      const base = entries[draft.originalName!];
                      if (!base) return;
                      await upsert(draft.originalName!, {
                        ...base,
                        schemaDir: dir,
                      });
                    }}
                  />
                </>
              ) : null}
            </div>
          )}

          <div className="flex flex-none items-center justify-between border-t border-border bg-muted/30 px-4 py-2.5">
            <div className="flex items-center gap-2">
              {draft.originalName ? (
                <button
                  type="button"
                  onClick={() => void onDelete()}
                  className="inline-flex items-center gap-1 rounded-md border border-destructive/30 px-2.5 py-1 text-xs text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="h-3 w-3" />
                  {t("connections.delete")}
                </button>
              ) : null}
              {draft.originalName ? (
                <span className="text-xs text-muted-foreground">
                  {t("connections.autoSaveHint")}
                </span>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              {saveError ? (
                <span className="text-xs text-destructive">{saveError}</span>
              ) : null}
              <button
                type="button"
                onClick={() => void onTest()}
                disabled={testState.status === "running"}
                className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                {testState.status === "running"
                  ? t("connections.test.running")
                  : t("connections.test.button")}
              </button>
              <button
                type="submit"
                className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"
              >
                {draft.originalName
                  ? t("connections.save.update")
                  : t("connections.save.create")}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Connections 顶部的凭据存储 banner：
 *   - safeStorage 可用：绿色提示「password 已加密」
 *   - 不可用：黄色提示「password 以明文写盘」
 *   - 加载中 / 出错：保守提示，避免 UI 误导
 *
 * 状态走 usePrivacyStatus，已被 Settings → Security tab 共用，缓存一份。
 */
function CredentialBanner() {
  const t = useT();
  const { status, loading } = usePrivacyStatus();

  if (loading || !status) {
    return (
      <div className="flex items-start gap-2 border-b border-border bg-muted/30 px-4 py-2 text-[11px] text-muted-foreground">
        <Loader2 className="mt-0.5 h-3.5 w-3.5 flex-none animate-spin" />
        <span>{t("connections.credential.loading")}</span>
      </div>
    );
  }

  if (status.available) {
    return (
      <div className="flex items-start gap-2 border-b border-border bg-emerald-50 px-4 py-2 text-[11px] text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 flex-none" />
        <span>
          {t("connections.credential.encrypted", {
            backend: describeBackend(status),
          })}
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2 border-b border-border bg-amber-50 px-4 py-2 text-[11px] text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
      <ShieldAlert className="mt-0.5 h-3.5 w-3.5 flex-none" />
      <span>
        {t("connections.credential.plain", {
          backend: describeBackend(status),
        })}
      </span>
    </div>
  );
}

/**
 * 配置编辑器：表单 / JSON 双视图，schema-driven。
 *
 * 行为：
 *   - 当前 kind 的 schema 可被 normalizeObjectSchema 识别 → 表单模式可用
 *   - 不可识别 → 锁死在 JSON 模式并显示一行说明，避免假装能填表
 *   - 模式切换由父组件维护，子组件只负责渲染对应视图
 */
function ConfigEditor({
  kind,
  kinds,
  config,
  configText,
  mode,
  jsonError,
  onModeChange,
  onConfigChange,
  onConfigTextChange,
}: {
  kind: string;
  kinds: ConnectorKindMeta[];
  config: Record<string, unknown>;
  configText: string;
  mode: "form" | "json";
  jsonError: string | null;
  onModeChange: (next: "form" | "json") => void;
  onConfigChange: (next: Record<string, unknown>) => void;
  onConfigTextChange: (next: string) => void;
}) {
  const t = useT();
  const meta = kinds.find((k) => k.kind === kind);
  const objectSchema = meta ? normalizeObjectSchema(meta.configSchema) : null;
  const formAvailable = objectSchema !== null;
  // schema 不识别时强制 json
  const effectiveMode: "form" | "json" = formAvailable ? mode : "json";

  return (
    <div className="mb-3.5">
      <div className="mb-2 flex items-center justify-between gap-3">
        <label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {t("connections.config.title")}
        </label>
        <div className="inline-flex overflow-hidden rounded-md border border-border bg-background text-[10px]">
          <ModeButton
            active={effectiveMode === "form"}
            disabled={!formAvailable}
            onClick={() => onModeChange("form")}
            title={
              formAvailable
                ? t("connections.config.formTitle")
                : t("connections.config.formUnavailableTitle")
            }
          >
            {t("connections.config.form")}
          </ModeButton>
          <ModeButton
            active={effectiveMode === "json"}
            onClick={() => onModeChange("json")}
            title={t("connections.config.jsonTitle")}
          >
            JSON
          </ModeButton>
        </div>
      </div>

      {effectiveMode === "form" && objectSchema ? (
        <div className="rounded-md border border-border bg-background p-3">
          <ConnectorForm
            schema={objectSchema}
            value={config}
            onChange={onConfigChange}
          />
        </div>
      ) : (
        <>
          <textarea
            value={configText}
            onChange={(e) => onConfigTextChange(e.target.value)}
            rows={10}
            spellCheck={false}
            className={cn(
              "w-full rounded-md border bg-background px-2 py-2 font-mono text-[12px] leading-relaxed focus:outline-none",
              jsonError
                ? "border-destructive/60 focus:border-destructive"
                : "border-border focus:border-primary",
            )}
          />
          {!formAvailable ? (
            <p className="mt-1 text-[10px] text-muted-foreground">
              {t("connections.config.noSchema")}
            </p>
          ) : null}
          {jsonError ? (
            <p className="mt-1 text-[10px] text-destructive">
              {t("connections.config.jsonError", { message: jsonError })}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

function ModeButton({
  active,
  disabled,
  onClick,
  title,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "px-2 py-1 transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
        disabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
      )}
    >
      {children}
    </button>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-3.5">
      <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

function ConfigHint({
  kind,
  kinds,
}: {
  kind: string;
  kinds: ConnectorKindMeta[];
}) {
  const t = useT();
  const meta = kinds.find((k) => k.kind === kind);
  if (!meta) return null;
  return (
    <details className="mt-2 text-[11px] text-muted-foreground">
      <summary className="cursor-pointer hover:text-foreground">
        {t("connections.config.schemaSummary", { name: meta.displayName })}
      </summary>
      <pre className="mt-1.5 max-h-36 overflow-auto rounded border border-border bg-muted/40 p-2 font-mono text-[10px] leading-snug">
        {JSON.stringify({ schema: meta.configSchema, default: meta.defaultConfig }, null, 2)}
      </pre>
    </details>
  );
}

function TestStateView({ state }: { state: TestState }) {
  const t = useT();
  if (state.status === "idle") return null;
  if (state.status === "running") {
    return (
      <div className="mt-2 flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t("connections.test.status.running")}
      </div>
    );
  }
  if (state.status === "ok") {
    return (
      <div className="mt-2 flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
        <CheckCircle2 className="h-3.5 w-3.5" />
        {t("connections.test.status.ok", {
          latency:
            state.latencyMs !== undefined ? ` · ${state.latencyMs}ms` : "",
          message: state.message ? ` · ${state.message}` : "",
        })}
      </div>
    );
  }
  return (
    <div className="mt-2 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-none" />
      <span className="whitespace-pre-wrap break-all">
        {state.message ?? t("connections.test.status.failed")}
      </span>
    </div>
  );
}

/**
 * 「本设备未保存密钥」提示：secret 按设备分片存到 `.stela/secrets/secrets_<slug>.json`，
 * 换设备 / 清缓存后本机 shard 可能缺这些 secret（其它设备的密文本机解不开）。提示用户
 * 在本机填一次密钥并保存即可，之后无需再填。
 */
function MissingSecretNotice({ fields }: { fields: string[] }) {
  const t = useT();
  if (fields.length === 0) return null;
  return (
    <div className="mb-3.5 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
      <ShieldAlert className="mt-0.5 h-3.5 w-3.5 flex-none" />
      <span>
        {t("connections.missingSecrets", { fields: fields.join(", ") })}
      </span>
    </div>
  );
}

/**
 * 列表行末尾的小圆点：概览当前连接的补全缓存状态。纯视觉提示，刷新入口放在
 * 右侧编辑面板的 {@link AutocompleteStatusPanel}。
 */
function AutocompleteStatusDot({
  connectionName,
}: {
  connectionName: string;
}) {
  const t = useT();
  const status = useAutocompleteCache(
    (s) => s.byConnection[connectionName] ?? AUTOCOMPLETE_STATUS_IDLE,
  );
  const { dotClass, title } = describeStatus(status, t);
  return (
    <span
      className={cn(
        "h-1.5 w-1.5 flex-none rounded-full",
        dotClass,
      )}
      title={title}
      aria-label={title}
    />
  );
}

/**
 * 右侧编辑面板里的完整状态条 + 刷新按钮。
 * 不主动发起加载——平时靠 RunSQL block 那边的 `ensure` 顺便填充；用户想手动强刷时点"刷新"。
 */
function AutocompleteStatusPanel({
  connectionName,
  onRefresh,
}: {
  connectionName: string;
  onRefresh: () => void;
}) {
  const t = useT();
  const status = useAutocompleteCache(
    (s) => s.byConnection[connectionName] ?? AUTOCOMPLETE_STATUS_IDLE,
  );
  const { label, tone } = describeStatus(status, t);
  const disabled = status.kind === "loading";

  return (
    <div className="mt-3 flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
          {t("connections.autocomplete.title")}
        </span>
        <span className={cn("truncate", tone)}>{label}</span>
      </div>
      <button
        type="button"
        onClick={onRefresh}
        disabled={disabled}
        className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
        title={t("connections.autocomplete.refreshTitle")}
      >
        <RefreshCw className={cn("h-3 w-3", disabled && "animate-spin")} />
        {t("connections.autocomplete.refresh")}
      </button>
    </div>
  );
}

interface StatusDescription {
  label: string;
  tone: string;
  dotClass: string;
  title: string;
}

function describeStatus(
  status: AutocompleteStatus,
  t: ReturnType<typeof useT>,
): StatusDescription {
  switch (status.kind) {
    case "idle":
      return {
        label: t("connections.autocomplete.idle"),
        tone: "text-muted-foreground",
        dotClass: "bg-muted-foreground/40",
        title: t("connections.autocomplete.titleIdle"),
      };
    case "loading":
      return {
        label: t("connections.autocomplete.loading"),
        tone: "text-muted-foreground",
        dotClass: "bg-primary/70 animate-pulse",
        title: t("connections.autocomplete.titleLoading"),
      };
    case "ready":
      return {
        label: t("connections.autocomplete.ready", {
          count: status.tableNames.length,
        }),
        tone: "text-emerald-700 dark:text-emerald-300",
        dotClass: "bg-emerald-500",
        title: t("connections.autocomplete.titleReady", {
          count: status.tableNames.length,
        }),
      };
    case "error":
      return {
        label: t("connections.autocomplete.error", {
          message: truncate(status.message, 80),
        }),
        tone: "text-destructive",
        dotClass: "bg-destructive",
        title: t("connections.autocomplete.titleError", {
          message: status.message,
        }),
      };
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function stringifyConfig(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return "{}";
  }
}

function errMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(err);
}

/**
 * 「同步表结构到 Markdown」面板。
 *
 * - 未设置 schemaDir：主按钮显示「选择目录并同步」，点击先弹目录选择框，保存后立刻开始 dump。
 * - 已设置：主按钮「同步表结构」；tooltip 给出当前目录；旁边一个「更改…」小链接改路径。
 * - 运行中 disable 按钮 + 实时进度 `[i/N] db.table`；完成后展示 ok/failed 汇总与失败详情折叠列表。
 *
 * 设计选择：
 * - 所有进度 / 结果状态走组件局部 `useState`，不入 store。一次性操作，没必要全局。
 * - 失败详情默认折叠，避免一次 20 张表都失败时把整个面板撑得很长。
 */
function SchemaDumpPanel({
  connectionName,
  entry,
  onSchemaDirChange,
}: {
  connectionName: string;
  entry: ConnectionEntry | undefined;
  onSchemaDirChange: (dir: string) => Promise<void>;
}) {
  const t = useT();
  type DumpStatus =
    | { kind: "idle" }
    | { kind: "picking" }
    | { kind: "running"; progress?: DumpProgress }
    | { kind: "done"; ok: number; failed: DumpFailure[]; outDir: string; total: number }
    | { kind: "error"; message: string };

  const [status, setStatus] = useState<DumpStatus>({ kind: "idle" });
  const [showFailures, setShowFailures] = useState(false);

  const schemaDir = entry?.schemaDir;

  const pickDir = useCallback(async (): Promise<string | null> => {
    setStatus({ kind: "picking" });
    try {
      const picked = await window.stela.dialog.pickDirectory({
        title: t("connections.schema.dialogTitle"),
        defaultPath: schemaDir,
      });
      setStatus({ kind: "idle" });
      return picked;
    } catch (err) {
      setStatus({ kind: "error", message: errMessage(err) });
      return null;
    }
  }, [schemaDir, t]);

  const runDump = useCallback(
    async (dir: string) => {
      if (!entry) return;
      setShowFailures(false);
      setStatus({ kind: "running" });
      try {
        const report = await dumpSchemaToMarkdown({
          connectionName,
          entry: { ...entry, schemaDir: dir },
          schemaDir: dir,
          onProgress: (p) => {
            setStatus({ kind: "running", progress: p });
          },
        });
        setStatus({
          kind: "done",
          ok: report.ok,
          failed: report.failed,
          outDir: report.outDir,
          total: report.total,
        });
      } catch (err) {
        setStatus({ kind: "error", message: errMessage(err) });
      }
    },
    [entry, connectionName],
  );

  const onSync = useCallback(async () => {
    if (!entry) return;
    let dir = schemaDir;
    if (!dir) {
      const picked = await pickDir();
      if (!picked) return;
      dir = picked;
      await onSchemaDirChange(picked);
    }
    await runDump(dir);
  }, [entry, schemaDir, pickDir, onSchemaDirChange, runDump]);

  const onChangeDir = useCallback(async () => {
    const picked = await pickDir();
    if (picked) {
      await onSchemaDirChange(picked);
    }
  }, [pickDir, onSchemaDirChange]);

  const busy = status.kind === "running" || status.kind === "picking";

  return (
    <div className="mt-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
            {t("connections.schema.title")}
          </span>
          <span
            className="truncate text-muted-foreground"
            title={schemaDir ?? t("connections.schema.unsetTitle")}
          >
            {schemaDir ? (
              <span className="font-mono text-[11px]">{schemaDir}</span>
            ) : (
              <span>{t("connections.schema.unset")}</span>
            )}
          </span>
        </div>
        <div className="flex flex-none items-center gap-1.5">
          {schemaDir ? (
            <button
              type="button"
              onClick={() => void onChangeDir()}
              disabled={busy}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              title={t("connections.schema.changeTitle")}
            >
              <FolderOpen className="h-3 w-3" />
              {t("connections.schema.change")}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void onSync()}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            title={
              schemaDir
                ? t("connections.schema.syncTitle", { dir: schemaDir })
                : t("connections.schema.pickFirstTitle")
            }
          >
            <RefreshCw
              className={cn(
                "h-3 w-3",
                status.kind === "running" && "animate-spin",
              )}
            />
            {schemaDir
              ? t("connections.schema.sync")
              : t("connections.schema.pickAndSync")}
          </button>
        </div>
      </div>

      <SchemaDumpStatusView status={status} />

      {status.kind === "done" && status.failed.length > 0 ? (
        <div className="mt-2 border-t border-border pt-2">
          <button
            type="button"
            onClick={() => setShowFailures((v) => !v)}
            className="text-[11px] text-destructive hover:underline"
          >
            {t("connections.schema.showFailures", {
              action: showFailures
                ? t("connections.schema.collapse")
                : t("connections.schema.expand"),
              count: status.failed.length,
            })}
          </button>
          {showFailures ? (
            <ul className="mt-1 max-h-40 overflow-auto rounded border border-border bg-background/40 p-2 text-[11px]">
              {status.failed.map((f) => (
                <li key={`${f.db}.${f.table}`} className="font-mono">
                  <span className="text-muted-foreground">
                    {f.db}.{f.table}
                  </span>
                  <span className="ml-2 text-destructive">{f.error}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SchemaDumpStatusView({
  status,
}: {
  status:
    | { kind: "idle" }
    | { kind: "picking" }
    | { kind: "running"; progress?: DumpProgress }
    | { kind: "done"; ok: number; failed: DumpFailure[]; outDir: string; total: number }
    | { kind: "error"; message: string };
}) {
  const t = useT();
  if (status.kind === "idle") return null;
  if (status.kind === "picking") {
    return (
      <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        {t("connections.schema.waitingDir")}
      </div>
    );
  }
  if (status.kind === "running") {
    const p = status.progress;
    return (
      <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        {p
          ? t("connections.schema.running", {
              index: p.index,
              total: p.total,
              db: p.db,
              table: p.table,
            })
          : t("connections.schema.preparing")}
      </div>
    );
  }
  if (status.kind === "done") {
    const ok = status.ok;
    const fail = status.failed.length;
    const tone =
      fail === 0
        ? "text-emerald-700 dark:text-emerald-300"
        : "text-amber-600 dark:text-amber-400";
    return (
      <div className={cn("mt-1.5 flex items-center gap-1.5 text-[11px]", tone)}>
        <CheckCircle2 className="h-3 w-3" />
        {t("connections.schema.done", {
          ok,
          failed:
            fail > 0
              ? t("connections.schema.failedSuffix", { count: fail })
              : "",
        })}
        <span
          className="ml-0.5 truncate font-mono text-muted-foreground"
          title={status.outDir}
        >
          {status.outDir}
        </span>
      </div>
    );
  }
  return (
    <div className="mt-1.5 flex items-start gap-1.5 text-[11px] text-destructive">
      <AlertTriangle className="mt-0.5 h-3 w-3 flex-none" />
      <span className="break-all">{status.message}</span>
    </div>
  );
}
