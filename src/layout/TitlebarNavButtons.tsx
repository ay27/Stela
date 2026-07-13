/**
 * 文档前进/后退按钮，嵌在 frameless 顶栏 drag 区内（自身 no-drag）。
 *
 * - macOS：Sidebar 顶栏，红绿灯右侧（stela-titlebar-safe-left）
 * - Windows：Sidebar 顶栏；侧栏收起时改由 TabBar / Welcome 顶条承接
 * - Linux：同 Windows；TabBar 右上仍有 overlay 安全区
 */

import { ArrowLeft, ArrowRight } from "lucide-react";

import { useT } from "@/i18n/use-t";
import { formatHotkey } from "@/lib/hotkeys";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/state/workspace";

const btnClass =
  "inline-flex h-6 w-6 flex-none items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40";

export function TitlebarNavButtons() {
  const t = useT();
  const navIndex = useWorkspace((s) => s.navIndex);
  const navLen = useWorkspace((s) => s.navStack.length);
  const goBack = useWorkspace((s) => s.goBack);
  const goForward = useWorkspace((s) => s.goForward);

  const canGoBack = navIndex > 0;
  const canGoForward = navIndex >= 0 && navIndex < navLen - 1;
  const backHint = formatHotkey("Mod+[");
  const forwardHint = formatHotkey("Mod+]");

  return (
    <div
      className="stela-app-no-drag ml-1 flex flex-none items-center gap-0.5"
      role="group"
      aria-label={t("nav.group")}
    >
      <button
        type="button"
        className={cn(btnClass)}
        disabled={!canGoBack}
        onClick={() => goBack()}
        title={`${t("nav.back")} (${backHint})`}
        aria-label={t("nav.back")}
      >
        <ArrowLeft className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        className={cn(btnClass)}
        disabled={!canGoForward}
        onClick={() => goForward()}
        title={`${t("nav.forward")} (${forwardHint})`}
        aria-label={t("nav.forward")}
      >
        <ArrowRight className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
