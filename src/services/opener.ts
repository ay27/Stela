/**
 * 全局 `<a>` 点击拦截器（Electron 适配）。
 *
 * 三类链接：
 *   1. http(s) / mailto    → main 进程 shell.openExternal（带协议白名单）
 *   2. 文档内锚点 #slug    → 当前 tab 重放 reveal
 *   3. vault 相对路径      → openFile + slug
 *   4. 其它 scheme         → 阻止
 *
 * Electron WebView 默认会让 `<a target="_blank">` 触发 will-navigate，被
 * security.ts 拦截到 main 进程；这里在 renderer 侧用 capture 阶段提前接管，
 * 避免 Milkdown / Crepe 内部 popover 抢跑。
 */

import { useWorkspace } from "@/state/workspace";
import {
  isVaultRelativeHref,
  probeFirstExisting,
  resolveHrefToCandidates,
} from "./link-resolver";

const EXTERNAL_PREFIXES = /^(https?:|mailto:)/i;

export async function openExternalUrl(href: string): Promise<void> {
  try {
    await window.stela.shell.openExternal(href);
  } catch (err) {
    console.error("[stela] openExternalUrl failed", href, err);
  }
}

function handleAnchorClick(href: string): boolean {
  const slug = href.slice(1);
  if (!slug) return false;
  const decoded = safeDecode(slug);
  const ws = useWorkspace.getState();
  const activeTab = ws.tabs.find((t) => t.id === ws.activeTabId);
  if (!activeTab || activeTab.kind !== "file" || !activeTab.path) return false;
  ws.openFile(activeTab.path, { scrollToSlug: decoded });
  return true;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

async function handleRelativeClick(href: string): Promise<boolean> {
  const ws = useWorkspace.getState();
  if (!ws.vaultPath) return false;

  const activeTab = ws.tabs.find((t) => t.id === ws.activeTabId);
  const basePath =
    activeTab?.kind === "file" && activeTab.path
      ? activeTab.path
      : `${ws.vaultPath}/.`;

  const resolved = resolveHrefToCandidates({
    basePath,
    vaultRoot: ws.vaultPath,
    href,
  });
  if (!resolved) return false;

  const { path, exists } = await probeFirstExisting(resolved.candidates);
  if (!exists) {
    console.warn(
      "[stela] relative link target not found",
      href,
      "candidates",
      resolved.candidates,
    );
    return false;
  }

  ws.openFile(path, { scrollToSlug: resolved.slug });
  return true;
}

export function installExternalLinkHandler(): () => void {
  const onClick = (ev: MouseEvent) => {
    if (ev.defaultPrevented) return;
    if (ev.button !== 0) return;

    const target = ev.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest("a[href]") as HTMLAnchorElement | null;
    if (!anchor) return;

    const href = anchor.getAttribute("href");
    if (!href) return;

    if (EXTERNAL_PREFIXES.test(href)) {
      ev.preventDefault();
      ev.stopPropagation();
      void openExternalUrl(href);
      return;
    }

    if (href.startsWith("#")) {
      if (handleAnchorClick(href)) {
        ev.preventDefault();
        ev.stopPropagation();
      }
      return;
    }

    if (isVaultRelativeHref(href)) {
      ev.preventDefault();
      ev.stopPropagation();
      void handleRelativeClick(href);
      return;
    }
  };

  document.addEventListener("click", onClick, true);
  return () => document.removeEventListener("click", onClick, true);
}
