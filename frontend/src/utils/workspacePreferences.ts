import { useState, type Dispatch, type SetStateAction } from 'react';
import { useProjectStore } from '../store/useProjectStore';

// These choices live in the backend config, independent of the EXE's random port.
export function useWorkspaceWindow(id: string, fallback = false): [boolean, Dispatch<SetStateAction<boolean>>] {
  const { workspace, updateWorkspace } = useProjectStore();
  const value = workspace.windows[id] ?? fallback;
  return [value, next => {
    const current = useProjectStore.getState().workspace.windows[id] ?? fallback;
    updateWorkspace({ windows: { [id]: typeof next === 'function' ? next(current) : next } });
  }];
}

export function useWorkspaceTab<T extends string>(id: string, allowed: readonly T[], fallback: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const [initial] = useState(fallback);
  const { workspace, updateWorkspace } = useProjectStore();
  const normalize = (value?: string) => allowed.includes(value as T) ? value as T : initial;
  return [normalize(workspace.tabs[id]), next => {
    const current = normalize(useProjectStore.getState().workspace.tabs[id]);
    updateWorkspace({ tabs: { [id]: typeof next === 'function' ? next(current) : next } });
  }];
}

export function useWorkspaceList<T extends string>(id: string, allowed: readonly T[], fallback: () => T[]): [T[], Dispatch<SetStateAction<T[]>>] {
  const [initial] = useState(fallback);
  const { workspace, updateWorkspace } = useProjectStore();
  const normalize = (value?: string[]) => (value ?? initial).filter(item => allowed.includes(item as T)) as T[];
  return [normalize(workspace.lists[id]), next => {
    const current = normalize(useProjectStore.getState().workspace.lists[id]);
    updateWorkspace({ lists: { [id]: typeof next === 'function' ? next(current) : next } });
  }];
}
