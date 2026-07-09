/** Minimal keyboard event shape for DOM + React. */
export interface PromptSubmitKeyEvent {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean;
}

/** Enter submits; Shift+Enter newline; IME composition must not submit. */
export function shouldSubmitPrompt(
  ev: PromptSubmitKeyEvent,
  composing: boolean,
): boolean {
  return (
    ev.key === "Enter" &&
    !ev.shiftKey &&
    !composing &&
    !ev.isComposing
  );
}
