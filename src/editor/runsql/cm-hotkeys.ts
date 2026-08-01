export interface PhysicalKeyEvent {
  code: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * CodeMirror keymaps compare `event.key`, but macOS Option changes a letter
 * into a symbol. Match the physical code for Mod+Alt letter shortcuts instead.
 */
export function matchesModAltPhysicalKey(
  event: PhysicalKeyEvent,
  code: string,
  isMac = /Mac|iPhone|iPad|iPod/i.test(
    typeof navigator === "undefined" ? "" : navigator.platform || navigator.userAgent,
  ),
): boolean {
  return (
    event.code === code &&
    event.altKey &&
    !event.shiftKey &&
    (isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)
  );
}
