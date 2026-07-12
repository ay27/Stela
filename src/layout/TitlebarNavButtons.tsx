/**
 * macOS 红绿灯右侧的文档前进/后退按钮。
 *
 * 外层顶栏保持 stela-app-drag；本组件根节点是 stela-app-no-drag，
 * 只挖掉按钮 hit area，右侧空白仍可拖窗。
 *
 * Win/Linux 不渲染（右上角已有 titleBarOverlay）；快捷键仍全局可用。
 */

import { ArrowLeft, ArrowRight } from "lucide-react";

import { useT } from "@/i18n/use-t";
import { formatHotkey } from "@/lib/hotkeys";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/state/workspace";

function isMacPlatform(): boolean {
  if (typeof document !== "undefined") {
    return document.documentElement.dataset.platform === "mac";
  }
  return false;
}

const btnClass =
  "inline-flex h-6 w-6 flex-none items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40";

export function TitlebarNavButtons() {
  const t = useT();
  const navIndex = useWorkspace((s) => s.navIndex);
  const navLen = useWorkspace((s) => s.navStack.length);
  const goBack = useWorkspace((s) => s.goBack);
  const goForward = useWorkspace((s) => s.goForward);

  if (!isMacPlatform()) return null;

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
