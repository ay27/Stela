import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Archive, BookOpen, FolderOpen, Loader2, RefreshCw, Trash2, X } from "lucide-react";

import type { AgentSkillListItem } from "@shared/types";
import { useT } from "@/i18n/use-t";

interface ExperienceKnowledgeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ExperienceKnowledgeDialog({
  open,
  onOpenChange,
}: ExperienceKnowledgeDialogProps) {
  const t = useT();
  const [skills, setSkills] = useState<AgentSkillListItem[] | null>(null);
  const [failed, setFailed] = useState(false);

  const refresh = async () => {
    setSkills(null);
    setFailed(false);
    try {
      setSkills(await window.stela.agent.listSkills());
    } catch {
      setSkills([]);
      setFailed(true);
    }
  };

  useEffect(() => {
    if (open) void refresh();
  }, [open]);

  const title = t("skills.library.title");
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[90] bg-black/45 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[91] flex h-[78vh] w-[860px] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-background text-foreground shadow-2xl">
          <div className="flex items-center gap-3 border-b border-border px-4 py-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <BookOpen className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-sm font-semibold">{title}</Dialog.Title>
              <Dialog.Description className="text-[11px] text-muted-foreground">
                {t("skills.library.description")}
              </Dialog.Description>
            </div>
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

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {skills === null ? (
              <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("common.loading")}
              </div>
            ) : failed ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {t("skills.library.loadFailed")}
              </p>
            ) : skills.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {t("skills.library.empty")}
              </p>
            ) : (
              <div className="space-y-3">
                {skills.map((skill) => (
                  <SkillCard key={skill.relativePath} skill={skill} onDeleted={refresh} />
                ))}
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SkillCard({
  skill,
  onDeleted,
}: {
  skill: AgentSkillListItem;
  onDeleted: () => Promise<void>;
}) {
  const t = useT();
  const archived = skill.status === "archived";
  const [deleting, setDeleting] = useState(false);
  const deleteSkill = async () => {
    if (!window.confirm(t("skills.library.deleteConfirm", { name: skill.name }))) return;
    setDeleting(true);
    try {
      await window.stela.agent.removeSkill(skill.relativePath);
      await onDeleted();
    } catch {
      // 保留卡片，用户可重试。
    } finally {
      setDeleting(false);
    }
  };
  return (
    <article className="rounded-lg border border-border bg-muted/20 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <h3 className="break-words text-sm font-semibold">{skill.name}</h3>
          <button
            type="button"
            onClick={() => void window.stela.shell.showItemInFolder(skill.relativePath)}
            className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground hover:text-foreground"
            title={t("skills.library.revealPath", { path: skill.relativePath })}
            aria-label={t("skills.library.revealPath", { path: skill.relativePath })}
          >
            <FolderOpen className="h-3 w-3 shrink-0" />
            <span className="truncate font-mono text-[11px]">{skill.relativePath}</span>
          </button>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <span
            className={
              archived
                ? "inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
                : "rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary"
            }
          >
            {archived ? <Archive className="h-3 w-3" /> : null}
            {t(`skills.library.status.${skill.status}`)}
          </span>
          <button
            type="button"
            onClick={() => void deleteSkill()}
            disabled={deleting}
            className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
            title={t("common.delete")}
            aria-label={t("common.delete")}
          >
            {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            <span>{t("common.delete")}</span>
          </button>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-1 text-xs">
        <span className="rounded border border-primary/30 bg-primary/10 px-2 py-0.5 font-semibold text-primary">
          {t("skills.library.category")}: {skill.category ?? "—"}
        </span>
        {skill.tags.map((tag) => (
          <span
            key={tag}
            className="rounded border border-primary/30 bg-primary/5 px-2 py-0.5 font-medium text-primary"
          >
            #{tag}
          </span>
        ))}
      </div>
      <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
        {skill.description}
      </p>
    </article>
  );
}
