import { LocalProjectInfo, NumberingSettings, PileGroup, PilePoint, PileProject } from '../types/project';

export const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8000';

function formatApiError(status: number, text: string): string {
  if (!text) return `HTTP ${status}`;
  try {
    const payload = JSON.parse(text) as { detail?: unknown };
    const detail = payload.detail;
    if (typeof detail === 'string') return detail;
    if (detail && typeof detail === 'object') {
      const data = detail as Record<string, unknown>;
      const parts: string[] = [];
      const message = typeof data.message === 'string' ? data.message : '';
      if (message) parts.push(message);
      const context = typeof data.context === 'string' ? data.context : '';
      if (context) parts.push(`Контекст: ${context}`);
      const firstError = typeof data.firstError === 'string' ? data.firstError : '';
      if (firstError) parts.push(`Первая ошибка: ${firstError}`);
      const logFile = typeof data.logFile === 'string' ? data.logFile : '';
      if (logFile) parts.push(`Лог: ${logFile}`);
      if (parts.length) return parts.join('\n');
      return JSON.stringify(detail);
    }
  } catch {
    // Fall back to raw response text below.
  }
  return text || `HTTP ${status}`;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${url}`, init);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(formatApiError(response.status, text));
  }
  return response.json() as Promise<T>;
}

export async function importCsv(file: File): Promise<PilePoint[]> {
  const formData = new FormData();
  formData.append('file', file);
  const data = await request<{ points: PilePoint[] }>('/api/import/csv', {
    method: 'POST',
    body: formData
  });
  return data.points;
}

export async function numberRows(params: {
  points: PilePoint[];
  groups: PileGroup[];
  groupId?: string | null;
  settings: NumberingSettings;
  numberingMode: 'global_sequential' | 'per_group';
}): Promise<PilePoint[]> {
  const data = await request<{ points: PilePoint[] }>('/api/numbering/rows', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
  return data.points;
}

export async function listLocalProjects(): Promise<LocalProjectInfo[]> {
  const data = await request<{ projects: LocalProjectInfo[] }>('/api/projects/local');
  return data.projects;
}

export async function saveLocalProject(project: PileProject): Promise<{ saved: boolean; fileName: string; name: string }> {
  return request<{ saved: boolean; fileName: string; name: string }>('/api/projects/local/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(project)
  });
}

export async function openLocalProject(fileName: string): Promise<PileProject> {
  return request<PileProject>(`/api/projects/local/${encodeURIComponent(fileName)}`);
}
export interface PanelStateConfig {
  x?: number | null;
  y?: number | null;
  width?: number | null;
  height?: number | null;
  dock?: string | null;
}

export interface AutosaveSettingsPayload {
  enabled?: boolean;
  intervalMinutes?: number;
  folderPath?: string | null;
}

export interface UserConfigPayload {
  projectName?: string | null;
  gridSettings?: Record<string, unknown>;
  viewSettings?: Record<string, unknown>;
  commandIcons?: Record<string, string>;
  groupManagerVisible?: boolean | null;
  groupManagerDock?: string | null;
  groupManagerCollapsed?: boolean | null;
  autoAssignSelection?: boolean | null;
  collapsedGroupIds?: string[];
  toolbarHeight?: number | null;
  panels?: Record<string, PanelStateConfig>;
  autosaveSettings?: AutosaveSettingsPayload;
}

export async function getUserConfig(): Promise<UserConfigPayload> {
  return request<UserConfigPayload>('/api/config/user');
}

export async function saveUserConfig(config: UserConfigPayload): Promise<UserConfigPayload> {
  return request<UserConfigPayload>('/api/config/user', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config)
  });
}

export async function autosaveProject(project: PileProject, folderPath?: string | null): Promise<{ saved: boolean; fileName: string; path: string }> {
  return request<{ saved: boolean; fileName: string; path: string }>('/api/autosave/project', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, folderPath: folderPath || null })
  });
}

export async function selectAutosaveFolder(): Promise<string | null> {
  const data = await request<{ folderPath?: string | null }>('/api/system/select-folder');
  return data.folderPath ?? null;
}



export async function createDesktopShortcut(): Promise<{ created: boolean; path?: string | null; target?: string | null }> {
  return request<{ created: boolean; path?: string | null; target?: string | null }>('/api/system/desktop-shortcut', {
    method: 'POST'
  });
}

export async function uploadApplicationIcon(file: File): Promise<{ saved: boolean; fileName: string; path?: string | null }> {
  const formData = new FormData();
  formData.append('file', file);
  return request<{ saved: boolean; fileName: string; path?: string | null }>('/api/config/app-icon', {
    method: 'POST',
    body: formData
  });
}


export interface UserIconInfo {
  fileName: string;
  url: string;
  contentType?: string | null;
  sizeBytes: number;
}

export async function listUserIcons(): Promise<UserIconInfo[]> {
  const data = await request<{ icons: UserIconInfo[] }>('/api/assets/icons');
  return data.icons;
}

export async function uploadUserIcon(file: File): Promise<UserIconInfo> {
  const formData = new FormData();
  formData.append('file', file);
  const data = await request<{ icon: UserIconInfo }>('/api/assets/icons', {
    method: 'POST',
    body: formData
  });
  return data.icon;
}

export async function deleteUserIcon(fileName: string): Promise<void> {
  await request<{ deleted: boolean }>(`/api/assets/icons/${encodeURIComponent(fileName)}`, { method: 'DELETE' });
}


export function resolveApiAssetUrl(url: string): string {
  if (!url) return url;
  if (/^https?:\/\//i.test(url) || url.startsWith('data:') || url.startsWith('blob:')) return url;
  const base = API_BASE.endsWith('/') ? API_BASE.slice(0, -1) : API_BASE;
  const path = url.startsWith('/') ? url : `/${url}`;
  return `${base}${path}`;
}
export interface NanoCadBlockAttributeSummary {
  tag: string;
  count: number;
  sampleValues: string[];
  score?: number;
}

export interface NanoCadBlockSummary {
  name: string;
  count: number;
  sampleInsertionPoint?: [number, number, number] | null;
  attributes: NanoCadBlockAttributeSummary[];
  numberAttributeCandidates: string[];
}

export interface NanoCadBlocksScanResponse {
  connected: boolean;
  documentName?: string | null;
  blocks: NanoCadBlockSummary[];
}

export interface NanoCadPickBlockResponse {
  blockName: string;
  objectName?: string | null;
  insertionPoint?: [number, number, number] | null;
  attributes: Record<string, string>;
  numberAttributeCandidates: string[];
}

export async function scanNanoCadBlocks(): Promise<NanoCadBlocksScanResponse> {
  return request<NanoCadBlocksScanResponse>('/api/nanocad/blocks/scan');
}

export async function pickNanoCadBlockSample(): Promise<NanoCadPickBlockResponse> {
  return request<NanoCadPickBlockResponse>('/api/nanocad/blocks/pick', { method: 'POST' });
}

export async function importNanoCadBlocks(params: {
  blockName: string;
  numberAttribute?: string | null;
  baseX?: number;
  baseY?: number;
  tolerance?: number;
}): Promise<PilePoint[]> {
  const data = await request<{ points: PilePoint[]; count: number }>('/api/nanocad/blocks/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
  return data.points;
}

export interface NanoCadBlockExportResult {
  updated: number;
  matched: number;
  scanned: number;
  points: number;
  unusedPoints: number;
  missingAttribute?: number;
  missingParameter?: number;
  tolerance: number;
  unmatchedBlocks?: Array<{ x: number; y: number }>;
  unmatchedObjects?: Array<{ objectName?: string; x: number; y: number }>;
  skippedNoCoordinates?: number;
}

export async function exportNanoCadBlocks(params: {
  blockName: string;
  numberAttribute: string;
  points: Array<{ id?: string | null; x: number; y: number; number?: number | string | null; sourceNumber?: number | string | null; groupId?: string | null }>;
  baseX?: number;
  baseY?: number;
  tolerance?: number;
  selectedGroupIds?: string[] | null;
}): Promise<NanoCadBlockExportResult> {
  return request<NanoCadBlockExportResult>('/api/nanocad/blocks/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
}

export interface NanoCadModelStudioParameterSummary {
  name: string;
  count: number;
  sampleValues: string[];
  score?: number;
}

export interface NanoCadModelStudioObjectSummary {
  name: string;
  technicalName?: string;
  apiType?: string;
  displayName?: string;
  count: number;
  coordinateCount?: number;
  sampleInsertionPoint?: [number, number, number] | null;
  parameters: NanoCadModelStudioParameterSummary[];
  numberParameterCandidates: string[];
}

export interface NanoCadModelStudioScanResponse {
  connected: boolean;
  documentName?: string | null;
  objects: NanoCadModelStudioObjectSummary[];
}

export async function scanNanoCadModelStudioObjects(): Promise<NanoCadModelStudioScanResponse> {
  return request<NanoCadModelStudioScanResponse>('/api/nanocad/modelstudio/scan');
}

export async function importNanoCadModelStudioObjects(params: {
  objectName?: string | null;
  selectedObjectNames?: string[] | null;
  selectedObjectParameters?: Record<string, string> | null;
  numberParameter?: string | null;
  baseX?: number;
  baseY?: number;
  tolerance?: number;
}): Promise<PilePoint[]> {
  const data = await request<{ points: PilePoint[]; count: number }>('/api/nanocad/modelstudio/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
  return data.points;
}

export async function exportNanoCadModelStudioObjects(params: {
  objectName?: string | null;
  selectedObjectNames?: string[] | null;
  numberParameter: string;
  points: Array<{ id?: string | null; x: number; y: number; number?: number | string | null; sourceNumber?: number | string | null; groupId?: string | null }>;
  baseX?: number;
  baseY?: number;
  tolerance?: number;
  selectedGroupIds?: string[] | null;
}): Promise<NanoCadBlockExportResult> {
  return request<NanoCadBlockExportResult>('/api/nanocad/modelstudio/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
}

