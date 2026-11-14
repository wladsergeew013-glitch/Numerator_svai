import { useProjectStore } from '../store/useProjectStore';
import type { PileProject } from '../types/project';
import { projectSaveSignature } from './projectSaveState';

export interface ProjectContext {
  sessionId: string;
  signature: string;
}

export function captureProjectContext(): ProjectContext {
  const state = useProjectStore.getState();
  return { sessionId: state.projectSessionId, signature: projectSaveSignature(state.project) };
}

export function isProjectSession(context: ProjectContext): boolean {
  return context.sessionId === useProjectStore.getState().projectSessionId;
}

export function assertProjectContext(context: ProjectContext): void {
  if (!isProjectSession(context) || projectSaveSignature(useProjectStore.getState().project) !== context.signature) {
    throw new Error('Проект изменился во время операции. Результат не применён. Повторите операцию в нужном проекте.');
  }
}

export interface ProjectTransitionRequest {
  handled: boolean;
  respond: (proceed: boolean) => void;
}

async function confirmProjectTransition(): Promise<boolean> {
  const state = useProjectStore.getState();
  if (projectSaveSignature(state.project) === state.savedProjectSignature) return true;
  return new Promise((resolve, reject) => {
    const detail: ProjectTransitionRequest = { handled: false, respond: resolve };
    window.dispatchEvent(new CustomEvent('pile-numbering:project-transition-requested', { detail }));
    if (!detail.handled) reject(new Error('Не удалось показать запрос сохранения. Сначала сохраните текущий проект.'));
  });
}

let openGeneration = 0;

export async function runProjectTransition<T>(load: () => Promise<T | null>, apply: (value: T) => void): Promise<boolean> {
  const generation = ++openGeneration;
  const context = captureProjectContext();
  const value = await load();
  if (generation !== openGeneration || value === null) return false;
  assertProjectContext(context);
  if (!await confirmProjectTransition() || generation !== openGeneration) return false;
  assertProjectContext(context);
  apply(value);
  return true;
}

export function openProjectSafely(load: () => Promise<{ project: PileProject; fileName: string } | null>): Promise<boolean> {
  return runProjectTransition(load, value => useProjectStore.getState().openProjectFromFile(value.project, value.fileName));
}
