/**
 * Settings → Shortcuts 面板。把 `docs/keybindings.md` 里记录的键位分组渲染为表格，
 * 供用户在 App 内直接查询。
 *
 * 数据源直接硬编码在这里（常量 GROUPS）——比运行时读 md 更快、更可预期，文档和 UI
 * 两处同步即可。
 */

import { Keyboard as KeyboardIcon } from "lucide-react";

import { useT } from "@/i18n/use-t";
import { formatHotkey } from "@/lib/hotkeys";
import { cn } from "@/lib/utils";

interface ShortcutItem {
  /** 留空表示非键位行（仅说明文字，不渲染 kbd） */
  keys?: string;
  actionKey: string;
}

interface ShortcutGroup {
  titleKey: string;
  descriptionKey?: string;
  items: ShortcutItem[];
}

const GROUPS: ShortcutGroup[] = [
  {
    titleKey: "shortcuts.global.title",
    descriptionKey: "shortcuts.global.description",
    items: [
      { keys: "Mod+K", actionKey: "shortcuts.global.commandPalette" },
      { keys: "Mod+N", actionKey: "shortcuts.global.newNote" },
      { keys: "Mod+W", actionKey: "shortcuts.global.closeTab" },
      { keys: "Mod+F / Mod+Shift+F", actionKey: "shortcuts.global.search" },
      { keys: "Mod+B", actionKey: "shortcuts.global.toggleSidebar" },
      { keys: "Mod+,", actionKey: "shortcuts.global.settings" },
      { keys: "Mod+I", actionKey: "shortcuts.global.addToChat" },
      { keys: "Mod+Enter", actionKey: "shortcuts.global.runBlock" },
      { keys: "Mod+1 … Mod+9", actionKey: "shortcuts.global.switchTab" },
    ],
  },
  {
    titleKey: "shortcuts.editor.title",
    descriptionKey: "shortcuts.editor.description",
    items: [
      { keys: "Mod+Enter", actionKey: "shortcuts.editor.run" },
      { keys: "Mod+R", actionKey: "shortcuts.editor.refresh" },
      { keys: "Mod+Alt+L", actionKey: "shortcuts.editor.format" },
    ],
  },
  {
    titleKey: "shortcuts.context.title",
    descriptionKey: "shortcuts.context.description",
    items: [
      { actionKey: "shortcuts.context.run" },
      { actionKey: "shortcuts.context.refresh" },
      { keys: "Mod+I", actionKey: "shortcuts.context.addToChat" },
      { actionKey: "shortcuts.context.copy" },
      { actionKey: "shortcuts.context.delete" },
    ],
  },
];

export function ShortcutsTab() {
  const t = useT();
  return (
    <div className="flex h-full flex-col gap-4 overflow-auto px-5 py-4 text-xs">
      <div className="flex items-start gap-2">
        <KeyboardIcon className="mt-0.5 h-4 w-4 flex-none text-muted-foreground" />
        <div>
          <p className="text-sm font-medium text-foreground">
            {t("shortcuts.title")}
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {t("shortcuts.modHint")}
          </p>
        </div>
      </div>

      {GROUPS.map((group) => (
        <section key={group.titleKey} className="rounded-md border border-border bg-muted/20">
          <div className="border-b border-border px-3 py-2">
            <h3 className="text-[12px] font-semibold text-foreground">
              {t(group.titleKey)}
            </h3>
            {group.descriptionKey ? (
              <p className="mt-0.5 text-[10.5px] text-muted-foreground">
                {t(group.descriptionKey)}
              </p>
            ) : null}
          </div>
          <ul className="divide-y divide-border">
            {group.items.map((item, idx) => (
              <li
                key={`${group.titleKey}-${idx}`}
                className="flex items-start gap-3 px-3 py-1.5"
              >
                <div className="w-40 flex-none">
                  {item.keys ? (
                    <KbdExpression expression={item.keys} />
                  ) : (
                    <span className="text-[10px] text-muted-foreground">—</span>
                  )}
                </div>
                <div className="min-w-0 flex-1 text-[11.5px] text-foreground/90">
                  {t(item.actionKey)}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/**
 * 支持在表达式里用 `…`、`/`、空格等写多键位（例如 `Mod+1 … Mod+9`）。
 * 策略：用 `([A-Za-z0-9+]+)` 正则切出 token，对每个 token 里含 `+` 的当成快捷键
 * 走 `formatHotkey`，其它原样渲染。
 */
function KbdExpression({ expression }: { expression: string }) {
  const tokens = expression.split(/(\s+|…|\/)/g).filter(Boolean);
  return (
    <div className="flex flex-wrap items-center gap-1">
      {tokens.map((tok, i) => {
        if (/^[+]/.test(tok)) return null;
        if (/^(\s+|…|\/)$/.test(tok)) {
          return (
            <span key={i} className="text-[10px] text-muted-foreground">
              {tok.trim() === "" ? "" : tok}
            </span>
          );
        }
        return <Kbd key={i}>{formatHotkey(tok)}</Kbd>;
      })}
    </div>
  );
}

function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded border border-border bg-background px-1.5 font-mono text-[10.5px] font-medium text-foreground shadow-[0_1px_0_0_hsl(var(--border))]",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
