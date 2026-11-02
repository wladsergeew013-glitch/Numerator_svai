type Drop = { x: number; y: number; finished: boolean };
type PanelWindow = {
  popup: Window;
  mount: HTMLElement;
  placeholder: HTMLElement;
  onReady: (popup: Window) => void;
  onReturn: (drop?: Drop) => void;
  onDrag: (drop: Drop) => void;
  onClose?: () => void;
  timer: number;
};

const panels = new Map<string, PanelWindow>();
type DesktopWindow = Window & {
  pileNativePanelsReady?: boolean;
  pywebview?: { api?: { startPanelMove?: (id: string) => Promise<void> } };
};

export function nativePanelsAvailable() {
  return Boolean((window as DesktopWindow).pileNativePanelsReady);
}

function restore(id: string, drop?: Drop) {
  const panel = panels.get(id);
  if (!panel) return;
  panels.delete(id);
  window.clearTimeout(panel.timer);
  panel.placeholder.appendChild(panel.mount);
  panel.onReturn(drop);
  // Close only after the live DOM has returned to its original document.
  if (!panel.popup.closed) panel.popup.close();
}

function ready(id: string) {
  const panel = panels.get(id);
  if (!panel) return;
  window.clearTimeout(panel.timer);
  try {
    const doc = panel.popup.document;
    doc.open();
    doc.write('<!doctype html><html><head><meta charset="utf-8"></head><body class="detached-panel-window"></body></html>');
    doc.close();
    const base = doc.createElement('base');
    base.href = document.baseURI;
    doc.head.appendChild(base);
    for (const style of document.querySelectorAll('link[rel="stylesheet"],style')) {
      doc.head.appendChild(style.cloneNode(true));
    }
    doc.documentElement.lang = 'ru';
    doc.body.appendChild(panel.mount);
    panel.popup.addEventListener('keydown', event => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('input,textarea,select,[contenteditable="true"]')) return;
      const forwarded = new KeyboardEvent('keydown', {
        key: event.key, code: event.code, ctrlKey: event.ctrlKey, altKey: event.altKey,
        shiftKey: event.shiftKey, metaKey: event.metaKey, bubbles: true, cancelable: true
      });
      if (!window.dispatchEvent(forwarded)) event.preventDefault();
    });
    panel.popup.addEventListener('resize', () => {
      window.dispatchEvent(new CustomEvent('pile-panel-native-resized', { detail: { id } }));
    });
    // Native title tooltips also work on controls created by the opener's realm.
    doc.addEventListener('mouseover', event => {
      const element = (event.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-tooltip]');
      if (element?.dataset.tooltip) element.title = element.dataset.tooltip;
    });
    panel.onReady(panel.popup);
  } catch (error) {
    console.error('Could not move panel into its native window', error);
    restore(id);
  }
}

const callbacks = {
  nativeReady: ({ id }: { id: string }) => ready(id),
  returnPanel: ({ id }: { id: string }) => restore(id),
  closePanel: ({ id }: { id: string }) => {
    const close = panels.get(id)?.onClose;
    restore(id);
    close?.();
  },
  failed: ({ id }: { id: string }) => restore(id),
  dragOver: ({ id, ...drop }: Drop & { id: string }) => panels.get(id)?.onDrag(drop)
};
if (typeof window !== 'undefined') {
  (window as unknown as { __pilePanels: typeof callbacks }).__pilePanels = callbacks;
}

export function detachPanelWindow(options: {
  id: string; title: string; width: number; height: number; drag: boolean;
  mount: HTMLElement; placeholder: HTMLElement;
  onReady: PanelWindow['onReady']; onReturn: PanelWindow['onReturn']; onDrag: PanelWindow['onDrag'];
  onClose?: PanelWindow['onClose'];
}) {
  if (!nativePanelsAvailable() || panels.has(options.id)) return false;
  const query = new URLSearchParams({ id: options.id, title: options.title, drag: options.drag ? '1' : '0' });
  const popup = window.open(`about:blank#pile-panel?${query}`, `pile-panel-${options.id}`,
    `popup=yes,width=${Math.round(options.width)},height=${Math.round(options.height)}`);
  if (!popup) return false;
  const timer = window.setTimeout(() => restore(options.id), 15_000);
  panels.set(options.id, { ...options, popup, timer });
  return true;
}

export function returnPanelWindow(id: string, drop?: Drop) { restore(id, drop); }
export function disposePanelWindow(id: string) {
  // Component removal already unmounts the portal; keep native cleanup idempotent.
  restore(id);
}
export function beginNativePanelMove(id: string) {
  void (window as DesktopWindow).pywebview?.api?.startPanelMove?.(id);
}
