// Text controls and modal dialogs own keyboard input before the CAD canvas.
export function workspaceKeyboardBlocked(event: KeyboardEvent): boolean {
  return event.defaultPrevented
    || Boolean(document.querySelector('[role="dialog"][aria-modal="true"]'))
    || (event.target instanceof HTMLElement
      && Boolean(event.target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]')));
}
