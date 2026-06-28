/**
 * Knowledge tab：知识库索引的状态总览与运维操作。
 *
 * 展示项：
 *   - 嵌入模型 id / 维度 / 可用性（不可用时给出明确降级说明）
 *   - 索引覆盖率（sources / chunks）+ 当前是否在跑增量
 *   - 数据库文件路径
 *   - 最近一次错误（带 dismiss 行为：rebuild / purge 后会清掉）
 *
 * 运维按钮：
 *   - Rebuild：强制重新跑一次全量索引（异步，不阻塞 UI）
 *   - Purge：清空 .stela-knowledge.sqlite 内容（保留 schema）
 *
 * 与 [SemanticSearchPanel](../../layout/SemanticSearchPanel.tsx) 共用同一 store
 * （`useKnowledge`），二者状态实时同步。
 */

import { Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { useKnowledge } from "@/state/knowledge";
import { useT } from "@/i18n/use-t";
import { useSettings } from "@/state/settings";
import { useWorkspace } from "@/state/workspace";

import { FormHint, Row, Section, TabContainer, Toggle } from "./atoms";

export function KnowledgeTab() {
  const t = useT();
  const vaultPath = useWorkspace((s) => s.vaultPath);
  const settings = useSettings((s) => s.settings);
  const patchSettings = useSettings((s) => s.patch);
  const status = useKnowledge((s) => s.status);
  const refreshStatus = useKnowledge((s) => s.refreshStatus);
  const rebuild = useKnowledge((s) => s.rebuild);
  const purge = useKnowledge((s) => s.purge);

  // 兜底 settings.knowledge undefined：dev 阶段 main 老 / renderer 新边界场景
  const knowledgeEnabled = settings.knowledge?.enabled ?? false;

  const [running, setRunning] = useState<
    "none" | "rebuild" | "purge" | "toggle"
  >("none");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void refreshStatus();
    // 关闭时拉一次就够了，没必要 4s poll（status 是冷数据，indexing 永远 false）
    if (!knowledgeEnabled) return;
    const id = window.setInterval(() => {
      void refreshStatus();
    }, 4_000);
    return () => window.clearInterval(id);
  }, [refreshStatus, vaultPath, knowledgeEnabled]);

  const onToggleEnabled = async (next: boolean) => {
    setRunning("toggle");
    setMessage(null);
    try {
      await patchSettings({ knowledge: { enabled: next } });
      // patch 完成后 main 端已 reconfigure knowledge runtime；拉一次 status
      // 把 enabled=true 后的 ready / indexing 状态同步过来
      await refreshStatus();
      setMessage(
        next
          ? t("knowledge.notice.enabled")
          : t("knowledge.notice.disabled"),
      );
    } catch (err) {
      setMessage(
        t("knowledge.error.toggle", {
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      setRunning("none");
    }
  };

  const onRebuild = async () => {
    setRunning("rebuild");
    setMessage(null);
    try {
      await rebuild();
      setMessage(t("knowledge.notice.rebuild"));
    } catch (err) {
      setMessage(
        t("knowledge.error.rebuild", {
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      setRunning("none");
    }
  };

  const onPurge = async () => {
    if (
      !window.confirm(
        t("knowledge.confirmPurge"),
      )
    ) {
      return;
    }
    setRunning("purge");
    setMessage(null);
    try {
      await purge();
      setMessage(t("knowledge.notice.purged"));
    } catch (err) {
      setMessage(
        t("knowledge.error.purge", {
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      setRunning("none");
    }
  };

  // Rebuild/Purge 的可用条件：vault 已打开 + RAG 已开启 + ready
  // （关闭时仍允许 Purge 清理磁盘空间，所以 purgeDisabled 单独算）
  const opDisabled = !vaultPath || !knowledgeEnabled || !status.ready;
  const purgeDisabled = !vaultPath || !status.dbPath;

  return (
    <TabContainer>
      <Section
        title={t("knowledge.title")}
        description={t("knowledge.description")}
      >
        <Row
          label={t("knowledge.enabled")}
          description={
            knowledgeEnabled
              ? t("knowledge.enabled.descriptionOn")
              : t("knowledge.enabled.descriptionOff")
          }
        >
          <Toggle
            checked={knowledgeEnabled}
            disabled={!vaultPath || running === "toggle"}
            onChange={(v) => void onToggleEnabled(v)}
          />
        </Row>
        {running === "toggle" ? (
          <FormHint>
            <span className="inline-flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t("knowledge.reconfiguring")}
            </span>
          </FormHint>
        ) : null}
      </Section>

      <Section
        title={t("knowledge.model.title")}
        description={t("knowledge.model.description")}
      >
        <Row
          label={t("knowledge.model.label")}
          description={status.modelId ?? t("knowledge.model.unloaded")}
        >
          <span className="text-xs text-muted-foreground">
            {status.embeddingDim > 0 ? `${status.embeddingDim} dim` : "—"}
          </span>
        </Row>
        <Row
          label={t("knowledge.availability")}
          description={
            status.embeddingsAvailable
              ? t("knowledge.availability.ready")
              : t("knowledge.availability.degraded")
          }
        >
          <span
            className={
              status.embeddingsAvailable
                ? "text-xs text-emerald-600 dark:text-emerald-400"
                : "text-xs text-amber-600 dark:text-amber-400"
            }
          >
            {status.embeddingsAvailable ? "Ready" : "Degraded"}
          </span>
        </Row>
      </Section>

      <Section
        title={t("knowledge.coverage.title")}
        description={t("knowledge.coverage.description")}
      >
        <Row
          label={t("knowledge.sources")}
          description={t("knowledge.sources.description")}
        >
          <span className="text-xs text-muted-foreground">
            {status.totalSources.toLocaleString()}
          </span>
        </Row>
        <Row label="Chunks" description={t("knowledge.chunks.description")}>
          <span className="text-xs text-muted-foreground">
            {status.totalChunks.toLocaleString()}
          </span>
        </Row>
        <Row
          label={t("knowledge.status")}
          description={
            status.indexing
              ? t("knowledge.status.indexing", {
                  count: status.pendingSources,
                })
              : status.ready
                ? "Idle"
                : t("knowledge.status.notLoaded")
          }
        >
          {status.indexing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          ) : (
            <span className="text-xs text-muted-foreground">
              {status.ready ? "—" : "—"}
            </span>
          )}
        </Row>
        {status.lastError ? (
          <FormHint>
            {t("knowledge.lastError", { message: status.lastError })}
          </FormHint>
        ) : null}
      </Section>

      <Section
        title={t("knowledge.database.title")}
        description={t("knowledge.database.description")}
      >
        <Row label={t("knowledge.path")} description={status.dbPath ?? "—"}>
          <span className="text-xs text-muted-foreground">
            {status.dbPath ? t("knowledge.local") : "—"}
          </span>
        </Row>
      </Section>

      <Section
        title={t("knowledge.ops.title")}
        description={t("knowledge.ops.description")}
      >
        <Row
          label="Rebuild"
          description={t("knowledge.rebuild.description")}
        >
          <button
            type="button"
            disabled={opDisabled || running !== "none"}
            onClick={() => void onRebuild()}
            className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1 text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            {running === "rebuild" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Rebuild
          </button>
        </Row>
        <Row
          label="Purge"
          description={t("knowledge.purge.description")}
        >
          <button
            type="button"
            disabled={purgeDisabled || running !== "none"}
            onClick={() => void onPurge()}
            className="inline-flex items-center gap-1 rounded-md border border-destructive/40 px-3 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {running === "purge" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
            Purge
          </button>
        </Row>
        {message ? <FormHint>{message}</FormHint> : null}
      </Section>
    </TabContainer>
  );
}
