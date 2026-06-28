/**
 * 轻量级 DOM 级右键菜单，给 runsql NodeView 用。
 *
 * 不走 React / Radix：NodeView 是纯 DOM，走 Radix 要再起一个 React root 并
 * 手动 portal 定位，成本不值。这里用一个 document.body 挂载的 div，匹配
 * 项目里 Radix ContextMenu.Content 的视觉样式（rounded-md / border / bg-popover
 * / shadow-md），关闭行为：mousedown 空白处 / Esc / 选中项。
 *
 * 公开一个 `showContextMenu({x, y, items})`，items 可含分隔符（`kind: "separator"`），
 * 调用即显示，返回一个 disposer 便于主动收起（本模块暂时不使用）。
 */

export interface MenuItem {
  kind?: "item";
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  destructive?: boolean;
  /** 展示在右侧的快捷键提示，例如 "⌘⏎" */
  shortcut?: string;
}

export interface MenuSeparator {
  kind: "separator";
}

export type MenuEntry = MenuItem | MenuSeparator;

export interface ShowMenuOptions {
  x: number;
  y: number;
  items: MenuEntry[];
}

let activeMenu: HTMLElement | null = null;
let cleanup: (() => void) | null = null;

function dismiss() {
  if (activeMenu) {
    activeMenu.remove();
    activeMenu = null;
  }
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
}

export function showContextMenu({ x, y, items }: ShowMenuOptions): () => void {
  dismiss();

  const menu = document.createElement("div");
  menu.className = "stela-cb__ctxmenu";
  menu.setAttribute("role", "menu");
  // 先隐藏放到 body，拿到尺寸再定位，避免超出视口
  menu.style.visibility = "hidden";
  menu.style.position = "fixed";
  menu.style.left = "0px";
  menu.style.top = "0px";
  menu.style.zIndex = "80";

  for (const entry of items) {
    if (entry.kind === "separator") {
      const sep = document.createElement("div");
      sep.className = "stela-cb__ctxmenu-separator";
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "stela-cb__ctxmenu-item";
    if (entry.destructive) btn.classList.add("stela-cb__ctxmenu-item--danger");
    if (entry.disabled) {
      btn.classList.add("stela-cb__ctxmenu-item--disabled");
      btn.setAttribute("aria-disabled", "true");
    }
    const label = document.createElement("span");
    label.className = "stela-cb__ctxmenu-label";
    label.textContent = entry.label;
    btn.appendChild(label);
    if (entry.shortcut) {
      const sc = document.createElement("span");
      sc.className = "stela-cb__ctxmenu-shortcut";
      sc.textContent = entry.shortcut;
      btn.appendChild(sc);
    }
    if (!entry.disabled) {
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        dismiss();
        entry.onSelect();
      });
    }
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);

  const rect = menu.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.min(x, vw - rect.width - 8);
  const top = Math.min(y, vh - rect.height - 8);
  menu.style.left = `${Math.max(4, left)}px`;
  menu.style.top = `${Math.max(4, top)}px`;
  menu.style.visibility = "visible";

  activeMenu = menu;

  const onDocDown = (ev: MouseEvent) => {
    if (!activeMenu) return;
    if (activeMenu.contains(ev.target as Node)) return;
    dismiss();
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      dismiss();
    }
  };
  const onScroll = () => dismiss();
  window.addEventListener("mousedown", onDocDown, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onScroll);

  cleanup = () => {
    window.removeEventListener("mousedown", onDocDown, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", onScroll);
  };

  return dismiss;
}
