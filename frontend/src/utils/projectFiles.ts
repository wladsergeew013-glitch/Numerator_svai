import { GridSettings, PileProject, ViewSettings } from '../types/project';

export const UI_SETTINGS_FILE_KIND = 'pile-numbering-ui-settings';
export const UI_SETTINGS_FILE_SCHEMA_VERSION = 1;

export interface UiSettingsFile {
  kind: typeof UI_SETTINGS_FILE_KIND;
  schemaVersion: typeof UI_SETTINGS_FILE_SCHEMA_VERSION;
  exportedAt: string;
  gridSettings: GridSettings;
  viewSettings: ViewSettings;
}

export type ProjectFilePayload = Omit<PileProject, 'gridSettings' | 'viewSettings'> & {
  gridSettings?: never;
  viewSettings?: never;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function makeProjectFilePayload(project: PileProject): ProjectFilePayload {
  const { gridSettings: _gridSettings, viewSettings: _viewSettings, ...projectData } = project;
  return projectData;
}

export function makeUiSettingsFile(project: PileProject): UiSettingsFile {
  return {
    kind: UI_SETTINGS_FILE_KIND,
    schemaVersion: UI_SETTINGS_FILE_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    gridSettings: project.gridSettings,
    viewSettings: project.viewSettings
  };
}

export function parseUiSettingsFile(payload: unknown): Pick<UiSettingsFile, 'gridSettings' | 'viewSettings'> {
  if (!isObject(payload)) {
    throw new Error('Файл настроек интерфейса должен быть JSON-объектом.');
  }

  const kind = payload.kind;
  const hasKnownKind = kind === undefined || kind === UI_SETTINGS_FILE_KIND;
  if (!hasKnownKind) {
    throw new Error('Это не файл настроек интерфейса нумератора.');
  }

  const gridSettings = isObject(payload.gridSettings) ? payload.gridSettings : {};
  const viewSettings = isObject(payload.viewSettings) ? payload.viewSettings : {};

  if (Object.keys(gridSettings).length === 0 && Object.keys(viewSettings).length === 0) {
    throw new Error('В файле нет gridSettings/viewSettings.');
  }

  return {
    gridSettings: gridSettings as Partial<GridSettings> as GridSettings,
    viewSettings: viewSettings as Partial<ViewSettings> as ViewSettings
  };
}
