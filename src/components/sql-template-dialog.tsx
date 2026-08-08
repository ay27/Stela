import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { FileCode2, Loader2, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";

import {
  createSqlTemplate,
  listSqlTemplates,
  removeSqlTemplate,
  type SqlTemplate,
} from "@/services/sql-templates";
import { useT } from "@/i18n/use-t";
import { useWorkspace } from "@/state/workspace";

interface SqlTemplateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SqlTemplateDialog({
  open,
  onOpenChange,
}: SqlTemplateDialogProps) {
  const t = useT();
  const vaultPath = useWorkspace((state) => state.vaultPath);
  const openFile = useWorkspace((state) => state.openFile);
  const [templates, setTemplates] = useState<SqlTemplate[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const refresh = async () => {
    if (!vaultPath) return;
    setTemplates(null);
    setFailed(false);
    try {
      setTemplates(await listSqlTemplates(vaultPath));
    } catch {
      setTemplates([]);
      setFailed(true);
    }
  };

  useEffect(() => {
    if (open) void refresh();
  }, [open, vaultPath]);

  const visibleTemplates = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized || templates === null) return templates;
    return templates.filter((template) =>
      `${template.name}\n${template.description}\n${template.sql}`
        .toLocaleLowerCase()
        .includes(normalized),
    );
  }, [query, templates]);

  const openTemplate = (template: SqlTemplate) => {
    openFile(template.absolutePath, { title: template.name });
    onOpenChange(false);
  };

  const createTemplate = async () => {
    if (!vaultPath || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const template = await createSqlTemplate(vaultPath);
      openTemplate(template);
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          document
            .querySelector<HTMLInputElement>('[data-template-field="name"]')
            ?.focus();
        });
      });
    } catch {
      setCreateError(t("templates.library.createFailed"));
    } finally {
      setCreating(false);
    }
  };

  const deleteTemplate = async (template: SqlTemplate) => {
    if (!vaultPath) return;
    if (!window.confirm(t("templates.library.deleteConfirm", { name: template.name }))) {
      return;
    }
    try {
      await removeSqlTemplate(vaultPath, template);
      await refresh();
    } catch {
      // 保留卡片，让用户能重试。
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[90] bg-black/45 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[91] flex h-[78vh] w-[860px] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-background text-foreground shadow-2xl">
          <div className="flex items-center gap-3 border-b border-border px-4 py-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <FileCode2 className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-sm font-semibold">
                {t("templates.library.title")}
              </Dialog.Title>
              <Dialog.Description className="text-[11px] text-muted-foreground">
                {t("templates.library.description")}
              </Dialog.Description>
            </div>
            <button
              type="button"
              onClick={() => void createTemplate()}
              disabled={creating}
              className="inline-flex h-8 items-center justify-center gap-1 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {creating ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              {t("templates.library.create")}
            </button>
            <button
              type="button"
              onClick={() => void refresh()}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              title={t("common.refresh")}
              aria-label={t("common.refresh")}
            >
              <RefreshCw className="h-4 w-4" />
            </button>
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label={t("settings.close")}
              >
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </div>

          <div className="border-b border-border px-4 py-2">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("templates.library.searchPlaceholder")}
              className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t("templates.library.search")}
            />
            {createError ? (
              <p className="mt-1 text-xs text-destructive">{createError}</p>
            ) : null}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {templates === null ? (
              <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("common.loading")}
              </div>
            ) : failed ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {t("templates.library.loadFailed")}
              </p>
            ) : visibleTemplates?.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {query ? t("templates.library.noMatches") : t("templates.library.empty")}
              </p>
            ) : (
              <div className="space-y-3">
                {visibleTemplates?.map((template) => (
                  <article
                    key={template.relativePath}
                    className="rounded-lg border border-border bg-muted/20 p-4"
                  >
                    <div className="flex items-start gap-3">
                      <button
                        type="button"
                        onClick={() => openTemplate(template)}
                        className="min-w-0 flex-1 text-left"
                      >
                        <h3 className="truncate text-sm font-semibold hover:text-primary">
                          {template.name}
                        </h3>
                        <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                          {template.description || t("templates.library.noDescription")}
                        </p>
                      </button>
                      <div className="flex shrink-0 gap-1">
                        <button
                          type="button"
                          onClick={() => openTemplate(template)}
                          className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                          title={t("common.edit")}
                          aria-label={t("common.edit")}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void deleteTemplate(template)}
                          className="rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          title={t("common.delete")}
                          aria-label={t("common.delete")}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                    <pre className="mt-3 max-h-24 overflow-hidden rounded-md border border-border/60 bg-background/70 p-2 font-mono text-[11px] leading-5 text-muted-foreground">
                      {template.sql}
                    </pre>
                  </article>
                ))}
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
