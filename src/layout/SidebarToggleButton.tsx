import { PanelLeftClose, PanelLeftOpen } from "lucide-react";

import { useT } from "@/i18n/use-t";
import { useLayout } from "@/state/layout";
import { cn } from "@/lib/utils";

export function SidebarToggleButton({
  collapsed,
  className,
}: {
  collapsed: boolean;
  className?: string;
}) {
  const t = useT();
  const toggleSidebar = useLayout((s) => s.toggleSidebar);

  return (
    <button
      type="button"
      onClick={() => toggleSidebar()}
      title={collapsed ? t("sidebar.expand") : t("sidebar.collapse")}
      className={cn(
        "stela-app-no-drag flex flex-none items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground",
        className,
      )}
    >
      {collapsed ? (
        <PanelLeftOpen className="h-3.5 w-3.5" />
      ) : (
        <PanelLeftClose className="h-3.5 w-3.5" />
      )}
    </button>
  );
}
