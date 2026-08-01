import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { FileCode2, Loader2 } from "lucide-react";

import { listSqlTemplates, type SqlTemplate } from "@/services/sql-templates";
import { useT } from "@/i18n/use-t";
import { useWorkspace } from "@/state/workspace";
import { useSqlTemplatePicker } from "@/state/sql-template-picker";

export function SqlTemplatePicker() {
  const t = useT();
  const vaultPath = useWorkspace((state) => state.vaultPath);
  const open = useSqlTemplatePicker((state) => state.open);
  const select = useSqlTemplatePicker((state) => state.select);
  const close = useSqlTemplatePicker((state) => state.close);
  const [templates, setTemplates] = useState<SqlTemplate[] | null>(null);

  useEffect(() => {
    if (!open) return;
    if (!vaultPath) {
      setTemplates([]);
      return;
    }
    setTemplates(null);
    let active = true;
    void listSqlTemplates(vaultPath)
      .then((items) => {
        if (active) setTemplates(items);
      })
      .catch(() => {
        if (active) setTemplates([]);
      });
    return () => {
      active = false;
    };
  }, [open, vaultPath]);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[110] bg-black/25 backdrop-blur-[1px]" />
        <Dialog.Content
          className="fixed left-1/2 top-[24vh] z-[111] w-[620px] max-w-[92vw] -translate-x-1/2 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-2xl"
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <Dialog.Title className="sr-only">
            {t("templates.picker.title")}
          </Dialog.Title>
          <Command className="flex flex-col" label={t("templates.picker.title")}>
            <div className="flex items-center gap-2 border-b border-border px-3">
              <FileCode2 className="h-4 w-4 text-muted-foreground" />
              <Command.Input
                autoFocus
                placeholder={t("templates.picker.placeholder")}
                className="w-full bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
            <Command.List className="max-h-[52vh] overflow-y-auto p-1">
              {templates === null ? (
                <div className="flex items-center justify-center gap-2 px-3 py-8 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("common.loading")}
                </div>
              ) : (
                <>
                  <Command.Empty className="px-3 py-8 text-center text-sm text-muted-foreground">
                    {t("templates.picker.empty")}
                  </Command.Empty>
                  {templates.map((template) => (
                    <Command.Item
                      key={template.relativePath}
                      value={`${template.name} ${template.description} ${template.sql}`}
                      onSelect={() => select(template.sql)}
                      className="cursor-pointer rounded-md px-3 py-2.5 aria-selected:bg-accent"
                    >
                      <div className="flex min-w-0 items-start gap-2">
                        <FileCode2 className="mt-0.5 h-3.5 w-3.5 flex-none text-primary" />
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">{template.name}</div>
                          {template.description ? (
                            <p className="mt-0.5 truncate text-xs text-muted-foreground">
                              {template.description}
                            </p>
                          ) : null}
                          <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                            {template.sql.replace(/\s+/g, " ")}
                          </p>
                        </div>
                      </div>
                    </Command.Item>
                  ))}
                </>
              )}
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
