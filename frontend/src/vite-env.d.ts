/// <reference types="vite/client" />

declare module 'react-dom' {
  export function createPortal(children: import('react').ReactNode, container: Element | DocumentFragment): import('react').ReactPortal;
}

// Fallback declaration for environments where @types/react-dom is not installed yet.
// This keeps the local build/EXE builder stable even if node_modules was created
// before dev type packages were added.
declare module 'react-dom/client' {
  import type { ReactNode } from 'react';

  export interface Root {
    render(children: ReactNode): void;
    unmount(): void;
  }

  export function createRoot(container: Element | DocumentFragment): Root;
  export function hydrateRoot(container: Element | DocumentFragment, children: ReactNode): Root;
}
