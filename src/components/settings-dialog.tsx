/**
 * Settings Dialog（M4）
 *
 * 整体结构：左侧竖向 Tabs（Radix Tabs primitives），右侧 tab 内容；外壳沿用
 * [ConnectionsDialog](./connections-dialog.tsx) 的 Radix Dialog 风格保持一致。
 *
 * Tabs：
 *   - Connections：复用 [ConnectionsTab](./settings/connections-tab.tsx)
 *     （入口：本对话框 / 命令面板 / Welcome；Sidebar 不再放快捷入口）
 *   - Execution：onError 单选；其它字段标 M5
 *   - Persistence：SQLite 路径 / 文件大小 / cleanup 策略 / 立即清理按钮
 *   - Security：明文存储 banner + 路径
 *   - UI：BlockResult 默认 page size
 *   - Appearance：light / dark / system 三态
 */

import * as Dialog from "@radix-ui/react-dialog";
import * as Tabs from "@radix-ui/react-tabs";
import { useEffect, useState } from "react";
import {
  Database,
  Bot,
  Folder,
  GitBranch,
  Keyboard,
  Monitor as MonitorIcon,
  Palette,
  Play,
  Plug,
  RefreshCw,
  Settings as SettingsIcon,
  ShieldAlert,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useT } from "@/i18n/use-t";
import { useDialogs } from "@/state/dialogs";

import { AppearanceTab } from "./settings/appearance-tab";
import { AiTab } from "./settings/ai-tab";
import { ConnectionsTab } from "./settings/connections-tab";
import { ExecutionTab } from "./settings/execution-tab";
import { PersistenceTab } from "./settings/persistence-tab";
import { PluginsTab } from "./settings/plugins-tab";
import { SecurityTab } from "./settings/security-tab";
import { ShortcutsTab } from "./settings/shortcuts-tab";
import { GitTab } from "./settings/git-tab";
import { UITab } from "./settings/ui-tab";
import { UpdateTab } from "./settings/update-tab";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface TabSpec {
  id: string;
  labelKey: string;
  icon: React.ComponentType<{ className?: string }>;
  render: () => JSX.Element;
}

const TABS: TabSpec[] = [
  { id: "connections", labelKey: "settings.tabs.connections", icon: Database, render: () => <ConnectionsTab /> },
  { id: "plugins", labelKey: "settings.tabs.plugins", icon: Plug, render: () => <PluginsTab /> },
  { id: "git", labelKey: "settings.tabs.git", icon: GitBranch, render: () => <GitTab /> },
  { id: "ai", labelKey: "settings.tabs.ai", icon: Bot, render: () => <AiTab /> },
  { id: "execution", labelKey: "settings.tabs.execution", icon: Play, render: () => <ExecutionTab /> },
  { id: "persistence", labelKey: "settings.tabs.persistence", icon: Folder, render: () => <PersistenceTab /> },
  { id: "security", labelKey: "settings.tabs.security", icon: ShieldAlert, render: () => <SecurityTab /> },
  { id: "updates", labelKey: "settings.tabs.updates", icon: RefreshCw, render: () => <UpdateTab /> },
  { id: "ui", labelKey: "settings.tabs.ui", icon: MonitorIcon, render: () => <UITab /> },
  { id: "appearance", labelKey: "settings.tabs.appearance", icon: Palette, render: () => <AppearanceTab /> },
  { id: "shortcuts", labelKey: "settings.tabs.shortcuts", icon: Keyboard, render: () => <ShortcutsTab /> },
];

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const t = useT();
  const settingsTab = useDialogs((s) => s.settingsTab);
  const [tab, setTab] = useState(settingsTab ?? "connections");

  useEffect(() => {
    if (open) setTab(settingsTab ?? "connections");
  }, [open, settingsTab]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 flex h-[80vh] w-[920px] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-border bg-background text-foreground shadow-2xl",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          )}
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-2">
              <SettingsIcon className="h-4 w-4 text-muted-foreground" />
              <div>
                <Dialog.Title className="text-sm font-semibold">
                  {t("settings.title")}
                </Dialog.Title>
                <Dialog.Description className="text-xs text-muted-foreground">
                  {t("settings.description")}
                </Dialog.Description>
              </div>
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

          <Tabs.Root
            value={tab}
            onValueChange={setTab}
            orientation="vertical"
            className="flex flex-1 min-h-0"
          >
            <Tabs.List
              aria-label="Settings sections"
              className="flex w-44 flex-none flex-col border-r border-border bg-muted/20 p-2"
            >
              {TABS.map((tabSpec) => {
                const Icon = tabSpec.icon;
                return (
                  <Tabs.Trigger
                    key={tabSpec.id}
                    value={tabSpec.id}
                    className={cn(
                      "flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm",
                      "text-muted-foreground hover:bg-accent hover:text-foreground",
                      "data-[state=active]:bg-accent data-[state=active]:text-foreground data-[state=active]:font-medium",
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    {t(tabSpec.labelKey)}
                  </Tabs.Trigger>
                );
              })}
            </Tabs.List>
            <div className="flex-1 min-w-0 overflow-hidden">
              {TABS.map((tabSpec) => (
                <Tabs.Content
                  key={tabSpec.id}
                  value={tabSpec.id}
                  className="h-full overflow-auto focus:outline-none"
                >
                  {tabSpec.render()}
                </Tabs.Content>
              ))}
            </div>
          </Tabs.Root>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
