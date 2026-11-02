import { ReactNode, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

const roots = new Map<string, HTMLElement>();
const listeners = new Set<() => void>();
let activePanel: string | null = null;
export function registerPanelRoot(id: string, root: HTMLElement) {
  roots.set(id, root);
  for (const notify of listeners) notify();
  return () => {
    if (roots.get(id) === root) roots.delete(id);
    for (const notify of listeners) notify();
  };
}
export function activatePanelRoot(id: string) { activePanel = id; }
export function PanelOverlay({ children }: { children: ReactNode }) {
  const [owner] = useState(activePanel);
  const root = useSyncExternalStore(
    notify => { listeners.add(notify); return () => { listeners.delete(notify); }; },
    () => owner ? roots.get(owner) ?? document.body : document.body
  );
  return createPortal(children, root);
}
