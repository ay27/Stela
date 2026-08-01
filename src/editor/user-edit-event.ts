export const STELA_USER_EDIT_EVENT = "stela:user-edit";

/** Mark a UI command as an intentional document edit before dispatching PM. */
export function markStelaUserEdit(element: HTMLElement): void {
  element.dispatchEvent(
    new CustomEvent(STELA_USER_EDIT_EVENT, { bubbles: true }),
  );
}
