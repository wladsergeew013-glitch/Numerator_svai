import { useProjectStore } from '../store/useProjectStore';
import type { PileProject } from '../types/project';
import { projectSaveSignature } from './projectSaveState';
import { hasPendingProjectSaves, projectSaveGeneration, waitForProjectSaves } from './projectSaves';

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

function confirmProjectTransition(): true | Promise<boolean> {
  const state = useProjectStore.getState();
  if (projectSaveSignature(state.project) === state.savedProjectSignature) return true;
  return new Promise((resolve, reject) => {
    const detail: ProjectTransitionRequest = { handled: false, respond: resolve };
    window.dispatchEvent(new CustomEvent('pile-numbering:project-transition-requested', { detail }));
    if (!detail.handled) reject(new Error('Не удалось показать запрос сохранения. Сначала сохраните текущий проект.'));
  });
}

let openGeneration = 0;

type ProjectLoad<T> = () => Promise<T | null>;

async function transitionToSelected<T>(
  select: () => Promise<ProjectLoad<T> | null>, apply: (value: T) => void
): Promise<boolean> {
  const generation = ++openGeneration;
  const context = captureProjectContext();
  const projectId = useProjectStore.getState().project.project.id;
  const load = await select();
  if (load === null) return false;

  while (generation === openGeneration) {
    if (hasPendingProjectSaves(projectId)) await waitForProjectSaves(projectId);
    if (generation !== openGeneration) return false;
    assertProjectContext(context);
    if (hasPendingProjectSaves(projectId)) continue;

    const confirmation = confirmProjectTransition();
    if (confirmation !== true && !await confirmation) return false;
    if (generation !== openGeneration) return false;
    assertProjectContext(context);
    if (hasPendingProjectSaves(projectId)) continue;

    const savedGeneration = projectSaveGeneration();
    const value = await load();
    if (generation !== openGeneration || value === null) return false;
    assertProjectContext(context);
    // A write queued while reading may have replaced the selected file.
    if (savedGeneration !== projectSaveGeneration()) continue;
    apply(value);
    return true;
  }
  return false;
}

export function runProjectTransition<T>(load: ProjectLoad<T>, apply: (value: T) => void): Promise<boolean> {
  return transitionToSelected(async () => load, apply);
}

interface OpenedProject {
  project: PileProject;
  fileName: string;
}

function applyOpenedProject(value: OpenedProject): void {
  useProjectStore.getState().openProjectFromFile(value.project, value.fileName);
}

export function openProjectSafely(load: ProjectLoad<OpenedProject>): Promise<boolean> {
  return runProjectTransition(load, applyOpenedProject);
}

export async function openProjectFromPickerSafely(openBrowserDialog: () => void): Promise<boolean> {
  const api = (window as unknown as {
    pywebview?: { api?: {
      selectProjectJson?: () => Promise<{ selectionId?: string; canceled?: boolean; error?: string }>;
      readProjectJson?: (selectionId: string) => Promise<{ fileName?: string; content?: string; error?: string }>;
    } };
  }).pywebview?.api;
  if (!api?.selectProjectJson || !api.readProjectJson) {
    openBrowserDialog();
    return false;
  }
  return transitionToSelected(async () => {
    const selected = await api.selectProjectJson!();
    if (selected.canceled) return null;
    const selectionId = selected.selectionId;
    if (!selectionId) throw new Error(selected.error || 'Не удалось выбрать файл проекта.');
    return async () => {
      const loaded = await api.readProjectJson!(selectionId);
      if (!loaded.fileName || !loaded.content) throw new Error(loaded.error || 'Не удалось прочитать файл проекта.');
      return { project: JSON.parse(loaded.content) as PileProject, fileName: loaded.fileName };
    };
  }, applyOpenedProject);
}
