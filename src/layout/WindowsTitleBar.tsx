/**
 * Windows 专用系统标题行：应用名 + 原生窗口控制按钮（titleBarOverlay）。
 *
 * macOS 红绿灯嵌在 Sidebar / TabBar 顶栏；Win 控件在右上角，与 TabBar
 * 叠在一起会挡 tab / Agent 按钮。单独一行把 overlay 挪到最顶，下面 chrome 下移。
 */

import { isWindowsPlatform } from "@/lib/platform";
import { useT } from "@/i18n/use-t";

export function WindowsTitleBar() {
  const t = useT();
  if (!isWindowsPlatform()) return null;

  return (
    <header
      className="stela-win-titlebar stela-app-drag relative flex h-9 flex-none items-center border-b border-border bg-sidebar text-sidebar-foreground"
      aria-label={t("app.title")}
    >
      <span className="stela-app-no-drag select-none px-3 text-[12px] font-semibold tracking-tight">
        Stela
      </span>
      {/* overlay 按钮区：绝对定位 no-drag，不占 flex 宽度，避免右侧挤出空白条 */}
      <div
        className="stela-app-no-drag absolute inset-y-0 right-0 w-[138px]"
        aria-hidden
      />
    </header>
  );
}
