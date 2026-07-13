/**
 * 独立的 Connections Dialog 入口。
 *
 * M4 起，UI 主体已经抽到 [./settings/connections-tab.tsx](./settings/connections-tab.tsx)
 * 与 Settings Dialog 共用。本组件保留只是为了 Sidebar 底部的 "Connections" 快捷入口能
 * 直接打开连接管理界面，不必先经过 Settings Dialog。
 */

import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { ConnectionsTab } from "./settings/connections-tab";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n/use-t";

interface ConnectionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ConnectionsDialog({ open, onOpenChange }: ConnectionsDialogProps) {
  const t = useT();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 flex h-[80vh] w-[820px] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-border bg-background text-foreground shadow-2xl",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          )}
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div>
              <Dialog.Title className="text-sm font-semibold">
                {t("connections.dialog.title")}
              </Dialog.Title>
              <Dialog.Description className="text-xs text-muted-foreground">
                {t("connections.dialog.description")}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded-md p-1.5 text-muted-foreground hover:bg-accent"
                aria-label={t("settings.close")}
              >
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </div>
          <div className="flex flex-1 min-h-0 overflow-hidden">
            <ConnectionsTab />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
