/**
 * cmd+K 命令面板。
 *
 * 来源：
 *   - 静态命令：Open Connections / Open Settings / New Stela Note / Toggle Theme /
 *     Choose Vault
 *   - 动态文件：vault 内所有 Stela 笔记（`.md`），cmdk 自带模糊匹配
 *
 * 全局快捷键 `⌘K` / `Ctrl+K` 在 [src/layout/AppShell.tsx](../layout/AppShell.tsx)
 * 注册并 lift 出本组件的 open state；同一份 dialog 实例避免重复 mount cmdk。
 *
 * 静态命令通过 `commandHandlers` prop 注入，避免本组件直接持有 Sidebar 局部 state。
 */

import * as Dialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import {
  Bot,
  Code2,
  Database,
  FileText,
  FolderOpen as FolderOpenIcon,
  Moon,
  NotebookPen,
  Settings as SettingsIcon,
  Sun,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { listVaultFiles } from "@/services/search";
import { useSettings } from "@/state/settings";
import { useWorkspace } from "@/state/workspace";
import { useT } from "@/i18n/use-t";

export interface CommandHandlers {
  openConnections: () => void;
  openSettings: () => void;
  newStelaNote: () => void;
  chooseVault: () => void;
  /** 往当前激活编辑器光标处插入一个空 runsql 块；无打开文件时返回 false（静默 no-op）。 */
  insertRunSqlBlock: () => boolean;
  openAgent: () => void;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  handlers: CommandHandlers;
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function CommandPalette({ open, onOpenChange, handlers }: Props) {
  const t = useT();
  const vaultPath = useWorkspace((s) => s.vaultPath);
  const openFile = useWorkspace((s) => s.openFile);
  const themeMode = useSettings((s) => s.settings.appearance.theme);
  const patchSettings = useSettings((s) => s.patch);

  const [files, setFiles] = useState<string[]>([]);
  const [search, setSearch] = useState("");

  // 每次打开时重新拉文件列表（vault 内容随时可能变）
  useEffect(() => {
    if (!open) return;
    setSearch("");
    if (!vaultPath) {
      setFiles([]);
      return;
    }
    // 传空数组让 service 层用默认 STELA_EXTENSIONS
    listVaultFiles(vaultPath)
      .then(setFiles)
      .catch((err) => {
        console.error("[stela] listVaultFiles failed", err);
        setFiles([]);
      });
  }, [open, vaultPath]);

  const close = () => onOpenChange(false);

  const cycleTheme = () => {
    const order = ["light", "dark", "system"] as const;
    const next = order[(order.indexOf(themeMode) + 1) % order.length];
    void patchSettings({ appearance: { theme: next } });
  };

  /**
   * 没输入关键字时只渲染前 N 个文件，避免 vault 里有几千个 .md 时一开面板就
   * mount 几千个 cmdk Item（首屏延迟与键盘上下移动都会卡）。一旦用户开始输入，
   * cmdk 自带模糊匹配会过滤；这时再放开全量列表，匹配后真实展示数自然受 query
   * 限制，不会再有 N 个 DOM 节点的成本。
   */
  const FILE_RENDER_CAP_NO_QUERY = 200;
  const fileItems = useMemo(() => {
    if (!vaultPath) return [];
    const mapped = files.map((path) => {
      const rel = path.startsWith(vaultPath)
        ? path.slice(vaultPath.length).replace(/^\/+/, "")
        : path;
      return { path, rel, name: basename(path) };
    });
    if (search.trim() === "" && mapped.length > FILE_RENDER_CAP_NO_QUERY) {
      return mapped.slice(0, FILE_RENDER_CAP_NO_QUERY);
    }
    return mapped;
  }, [files, vaultPath, search]);
  const hiddenFileCount =
    vaultPath && search.trim() === "" && files.length > FILE_RENDER_CAP_NO_QUERY
      ? files.length - FILE_RENDER_CAP_NO_QUERY
      : 0;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content
          className="fixed left-1/2 top-[18vh] z-50 w-[640px] max-w-[92vw] -translate-x-1/2 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-2xl"
          aria-describedby={undefined}
        >
          <Dialog.Title className="sr-only">
            {t("commandPalette.title")}
          </Dialog.Title>
          <Command label={t("commandPalette.aria")} className="flex flex-col">
            <div className="border-b border-border px-3">
              <Command.Input
                value={search}
                onValueChange={setSearch}
                autoFocus
                placeholder={t("commandPalette.placeholder")}
                className="w-full bg-transparent py-3 text-sm placeholder:text-muted-foreground focus:outline-none"
              />
            </div>
            <Command.List className="max-h-[60vh] overflow-y-auto p-1">
              <Command.Empty className="px-3 py-6 text-center text-xs text-muted-foreground">
                {t("commandPalette.empty")}
              </Command.Empty>

              <Command.Group
                heading={t("commandPalette.group.commands")}
                className="px-1 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
              >
                <CmdItem
                  icon={<Code2 className="h-3.5 w-3.5" />}
                  label={t("commandPalette.insertRunSql.label")}
                  hint={t("commandPalette.insertRunSql.hint")}
                  value={`${t("commandPalette.insertRunSql.label")} insert sql run query`}
                  onSelect={() => {
                    close();
                    handlers.insertRunSqlBlock();
                  }}
                />
                <CmdItem
                  icon={<NotebookPen className="h-3.5 w-3.5" />}
                  label={t("commandPalette.newNote.label")}
                  hint={t("commandPalette.newNote.hint")}
                  onSelect={() => {
                    close();
                    handlers.newStelaNote();
                  }}
                />
                <CmdItem
                  icon={<Bot className="h-3.5 w-3.5" />}
                  label={t("commandPalette.openAgent.label")}
                  onSelect={() => {
                    close();
                    handlers.openAgent();
                  }}
                />
                <CmdItem
                  icon={<Database className="h-3.5 w-3.5" />}
                  label={t("commandPalette.openConnections.label")}
                  onSelect={() => {
                    close();
                    handlers.openConnections();
                  }}
                />
                <CmdItem
                  icon={<SettingsIcon className="h-3.5 w-3.5" />}
                  label={t("commandPalette.openSettings.label")}
                  onSelect={() => {
                    close();
                    handlers.openSettings();
                  }}
                />
                <CmdItem
                  icon={
                    themeMode === "dark" ? (
                      <Moon className="h-3.5 w-3.5" />
                    ) : (
                      <Sun className="h-3.5 w-3.5" />
                    )
                  }
                  label={t("commandPalette.toggleTheme.label")}
                  hint={t("commandPalette.toggleTheme.hint", { theme: themeMode })}
                  onSelect={() => {
                    cycleTheme();
                    close();
                  }}
                />
                <CmdItem
                  icon={<FolderOpenIcon className="h-3.5 w-3.5" />}
                  label={t("commandPalette.chooseVault.label")}
                  onSelect={() => {
                    close();
                    handlers.chooseVault();
                  }}
                />
              </Command.Group>

              {fileItems.length > 0 ? (
                <Command.Group
                  heading={t("commandPalette.group.files")}
                  className="px-1 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
                >
                  {fileItems.map((f) => (
                    <CmdItem
                      key={f.path}
                      icon={<FileText className="h-3.5 w-3.5" />}
                      label={f.name}
                      hint={f.rel}
                      onSelect={() => {
                        close();
                        openFile(f.path);
                      }}
                      value={`${f.name} ${f.rel}`}
                    />
                  ))}
                  {hiddenFileCount > 0 ? (
                    <div className="px-2 py-1 text-[10px] italic text-muted-foreground">
                      {t("commandPalette.hiddenFiles", {
                        shown: fileItems.length,
                        hidden: hiddenFileCount,
                      })}
                    </div>
                  ) : null}
                </Command.Group>
              ) : null}
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function CmdItem({
  icon,
  label,
  hint,
  onSelect,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  onSelect: () => void;
  value?: string;
}) {
  return (
    <Command.Item
      value={value ?? label}
      onSelect={onSelect}
      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
    >
      <span className="text-muted-foreground">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {hint ? (
        <span className="ml-2 truncate text-[11px] text-muted-foreground">
          {hint}
        </span>
      ) : null}
    </Command.Item>
  );
}
