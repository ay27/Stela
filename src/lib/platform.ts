/** Renderer 平台标记，由 main.tsx 写入 <html data-platform>. */

export type StelaPlatform = "mac" | "win" | "linux";

function readPlatform(): StelaPlatform | null {
  if (typeof document === "undefined") return null;
  const p = document.documentElement.dataset.platform;
  if (p === "mac" || p === "win" || p === "linux") return p;
  return null;
}

export function isMacPlatform(): boolean {
  return readPlatform() === "mac";
}

export function isWindowsPlatform(): boolean {
  return readPlatform() === "win";
}
