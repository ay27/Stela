/**
 * ThemeProvider：根据 `useSettings.settings.appearance.theme` 切换 `<html class="dark">`。
 *
 * - 三态：`light` / `dark` / `system`
 * - `system` 模式监听 `matchMedia("(prefers-color-scheme: dark)")` 实时跟随
 * - 不渲染任何 DOM，只挂副作用；包在 `<App />` 外层即可
 *
 * 副产物：导出 `useEffectiveTheme()` 给 UI（toggle 图标、icon 颜色）读当前生效色板。
 */

import { useEffect } from "react";

import { useSettings } from "@/state/settings";
import type { ThemeMode } from "@/contracts/settings";
import { isWindowsPlatform } from "@/lib/platform";

let lastTitleBarKey = "";

function syncWindowsTitleBar(dark: boolean, mode: ThemeMode): void {
  if (!isWindowsPlatform()) return;
  const key = `${dark}:${mode}`;
  if (key === lastTitleBarKey) return;
  lastTitleBarKey = key;
  void window.stela?.window?.syncTitleBarTheme?.(dark, mode);
}

function applyTheme(_mode: ThemeMode, effective: "light" | "dark") {
  const root = document.documentElement;
  if (effective === "dark") root.classList.add("dark");
  else root.classList.remove("dark");
  root.dataset.theme = effective;
}

function resolveEffective(mode: ThemeMode): "light" | "dark" {
  if (mode === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return mode;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const initialize = useSettings((s) => s.initialize);
  const mode = useSettings((s) => s.settings.appearance.theme);
  const loaded = useSettings((s) => s.loaded);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  useEffect(() => {
    const effective = resolveEffective(mode);
    applyTheme(mode, effective);
    syncWindowsTitleBar(effective === "dark", mode);
  }, [mode]);

  useEffect(() => {
    if (mode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handle = () => {
      const effective = mq.matches ? "dark" : "light";
      applyTheme("system", effective);
      syncWindowsTitleBar(effective === "dark", "system");
    };
    mq.addEventListener("change", handle);
    return () => mq.removeEventListener("change", handle);
  }, [mode]);

  if (!loaded) {
    return null;
  }

  return <>{children}</>;
}

export function useEffectiveTheme(): "light" | "dark" {
  const mode = useSettings((s) => s.settings.appearance.theme);
  if (mode === "system") {
    if (typeof window === "undefined") return "light";
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return mode;
}

export function useThemeMode(): ThemeMode {
  return useSettings((s) => s.settings.appearance.theme);
}
