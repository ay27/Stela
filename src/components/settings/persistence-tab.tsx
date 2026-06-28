/**
 * Persistence tab：展示 SQLite 路径与大小，提供 cleanup 策略与"立即清理"按钮。
 *
 * 数据来源：
 *   - vault path：`useWorkspace` store
 *   - SQLite 文件大小：`storage_db_size` Tauri 命令（M4 新增），打开时拉一次
 *   - cleanup 策略：`useSettings.persistence.cleanupMonths`，单选 + 持久化
 *   - 立即清理：调用 `storage_cleanup(keepDays)`，把 cleanupMonths * 30 当 keepDays
 */

import { Loader2, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import {
  CLEANUP_MONTH_OPTIONS,
} from "@/contracts/settings";
import { Select } from "@/components/ui/select";
import { storageDbSize } from "@/services/fs";
import { useT } from "@/i18n/use-t";
import { useSettings } from "@/state/settings";
import { useWorkspace } from "@/state/workspace";
import { FormHint, Row, Section, TabContainer } from "./atoms";

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

export function PersistenceTab() {
  const t = useT();
  const vaultPath = useWorkspace((s) => s.vaultPath);
  const cleanupMonths = useSettings(
    (s) => s.settings.persistence.cleanupMonths,
  );
  const patch = useSettings((s) => s.patch);

  const [size, setSize] = useState<number | null>(null);
  const [sizeError, setSizeError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const dbPath = vaultPath ? `${vaultPath}/.stela.sqlite` : null;

  const refreshSize = async () => {
    if (!vaultPath) {
      setSize(null);
      return;
    }
    try {
      setSizeError(null);
      const n = await storageDbSize(vaultPath);
      setSize(n);
    } catch (err) {
      setSizeError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void refreshSize();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultPath]);

  const onCleanup = async () => {
    if (cleanupMonths === 0) {
      setResult(t("persistence.cleanup.never"));
      return;
    }
    setRunning(true);
    setResult(null);
    try {
      const keepDays = cleanupMonths * 30;
      const n = await window.stela.storage.cleanup(keepDays);
      setResult(t("persistence.cleanup.done", { count: n }));
      await refreshSize();
    } catch (err) {
      setResult(
        t("persistence.cleanup.failed", {
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      setRunning(false);
    }
  };

  return (
    <TabContainer>
      <Section title={t("persistence.location.title")}>
        <Row label="Vault" description={vaultPath ?? t("persistence.vault.none")}>
          <span className="text-xs text-muted-foreground">
            {vaultPath ? t("persistence.ready") : "—"}
          </span>
        </Row>
        <Row
          label={t("persistence.sqlite")}
          description={dbPath ?? "—"}
        >
          <span className="text-xs text-muted-foreground">
            {sizeError
              ? t("persistence.readFailed", { message: sizeError })
              : size === null
                ? t("persistence.unknown")
                : humanSize(size)}
          </span>
        </Row>
      </Section>

      <Section title={t("persistence.cleanup.title")}>
        <Row
          label={t("persistence.cleanup.window")}
          description={t("persistence.cleanup.windowDescription")}
        >
          <Select<string>
            value={String(cleanupMonths)}
            onValueChange={(v) =>
              void patch({
                persistence: { cleanupMonths: Number(v) },
              })
            }
            options={CLEANUP_MONTH_OPTIONS.map((opt) => ({
              value: String(opt.value),
              label:
                opt.value === 0
                  ? t("persistence.cleanup.option.never")
                  : t("persistence.cleanup.option.months", {
                      count: opt.value,
                    }),
              labelText:
                opt.value === 0
                  ? t("persistence.cleanup.option.never")
                  : t("persistence.cleanup.option.months", {
                      count: opt.value,
                    }),
            }))}
          />
        </Row>

        <Row
          label={t("persistence.cleanup.run")}
          description={t("persistence.cleanup.description")}
        >
          <button
            type="button"
            onClick={() => void onCleanup()}
            disabled={running || !vaultPath}
            className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1 text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            {running ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
            {t("persistence.cleanup.run")}
          </button>
        </Row>
        {result ? <FormHint>{result}</FormHint> : null}
      </Section>
    </TabContainer>
  );
}
