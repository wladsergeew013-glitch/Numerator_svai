import { ChangeEvent, CSSProperties, ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { exportNanoCadBlocks, exportNanoCadModelStudioObjects, getUserConfig, importCsv, importNanoCadBlocks, importNanoCadModelStudioObjects, listLocalProjects, openLocalProject, pickNanoCadBlockSample, saveLocalProject, saveUserConfig, scanNanoCadBlocks, scanNanoCadModelStudioObjects, type NanoCadBlockSummary, type NanoCadModelStudioObjectSummary } from '../api/client';
import { useProjectStore } from '../store/useProjectStore';
import { LocalProjectInfo, PileGroup, PilePoint, PileProject } from '../types/project';
import { DraggablePanel } from './DraggablePanel';
import { WorkspaceSettingsPanel } from './WorkspaceSettingsPanel';

interface Props {
  onCsvImport: (file: File) => void;
  canvasWidth: number;
  canvasHeight: number;
  onHeightChange: (height: number) => void;
}

const TOOLBAR_STORAGE_KEY = 'pile-numbering:toolbar-height';
const RIBBON_MODE_KEY = 'pile-numbering:ribbon-mode:v1';
const RIBBON_TAB_KEY = 'pile-numbering:ribbon-tab:v1';
const RIBBON_COLLAPSED_KEY = 'pile-numbering:ribbon-collapsed:v1';
const RIBBON_DENSITY_KEY = 'pile-numbering:ribbon-density:v1';
const DEFAULT_TOOLBAR_HEIGHT = 138;
const MIN_TOOLBAR_HEIGHT = 104;
const MAX_TOOLBAR_HEIGHT = 280;
const APP_VERSION = '0.2.0';
const ABOUT_EMAIL = 'vvsergeev@proektirovanie.gazprom.ru';

type RibbonMode = 'tabs' | 'all';
type RibbonDensity = 'compact' | 'normal' | 'comfortable';
type RibbonTab = 'file' | 'work' | 'settings' | 'history';
type SectionId = 'file' | 'editing' | 'groups' | 'numbering' | 'workspace' | 'history';

const ALL_SECTIONS: SectionId[] = ['file', 'editing', 'groups', 'numbering', 'workspace', 'history'];
const TAB_SECTIONS: Record<RibbonTab, SectionId[]> = {
  file: ['file'],
  work: ['editing', 'groups', 'numbering'],
  settings: ['workspace'],
  history: ['history']
};

const TAB_LABELS: Record<RibbonTab, string> = {
  file: 'Файл',
  work: 'Редактирование / группы / нумерация',
  settings: 'Настройки',
  history: 'История'
};

const DENSITY_LABELS: Record<RibbonDensity, string> = {
  compact: 'Плотно',
  normal: 'Нормально',
  comfortable: 'Свободно'
};

const DENSITY_PRESETS: Record<RibbonDensity, {
  commandWidth: number;
  commandHeight: number;
  tileWidth: number;
  tileHeight: number;
  commandGap: number;
  groupMinHeight: number;
  sectionPaddingY: number;
}> = {
  compact: { commandWidth: 86, commandHeight: 58, tileWidth: 52, tileHeight: 34, commandGap: 4, groupMinHeight: 70, sectionPaddingY: 4 },
  normal: { commandWidth: 92, commandHeight: 66, tileWidth: 56, tileHeight: 39, commandGap: 5, groupMinHeight: 80, sectionPaddingY: 5 },
  comfortable: { commandWidth: 98, commandHeight: 76, tileWidth: 60, tileHeight: 46, commandGap: 7, groupMinHeight: 92, sectionPaddingY: 7 }
};

function loadToolbarHeight() {
  if (typeof window === 'undefined') return DEFAULT_TOOLBAR_HEIGHT;
  try {
    const raw = window.localStorage.getItem(TOOLBAR_STORAGE_KEY);
    const value = Number(raw);
    if (!Number.isFinite(value)) return DEFAULT_TOOLBAR_HEIGHT;
    return Math.min(Math.max(value, MIN_TOOLBAR_HEIGHT), MAX_TOOLBAR_HEIGHT);
  } catch {
    return DEFAULT_TOOLBAR_HEIGHT;
  }
}

function loadRibbonMode(): RibbonMode {
  if (typeof window === 'undefined') return 'tabs';
  try {
    const value = window.localStorage.getItem(RIBBON_MODE_KEY);
    return value === 'all' || value === 'tabs' ? value : 'tabs';
  } catch {
    return 'tabs';
  }
}


function loadRibbonDensity(): RibbonDensity {
  if (typeof window === 'undefined') return 'compact';
  try {
    const value = window.localStorage.getItem(RIBBON_DENSITY_KEY);
    return value === 'compact' || value === 'normal' || value === 'comfortable' ? value : 'compact';
  } catch {
    return 'compact';
  }
}

function loadRibbonTab(): RibbonTab {
  if (typeof window === 'undefined') return 'file';
  try {
    const value = window.localStorage.getItem(RIBBON_TAB_KEY);
    return value === 'file' || value === 'work' || value === 'settings' || value === 'history' ? value : 'file';
  } catch {
    return 'file';
  }
}

function loadCollapsedSections(): SectionId[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RIBBON_COLLAPSED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is SectionId => ALL_SECTIONS.includes(x as SectionId));
  } catch {
    return [];
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function CommandButton({ icon, label, tooltip, onClick, children, active = false }: {
  icon: string;
  label: string;
  tooltip: string;
  onClick?: () => void;
  children?: ReactNode;
  active?: boolean;
}) {
  const className = `ribbon-command ${active ? 'active' : ''}`;
  const content = (
    <>
      {children}
      <span className="ribbon-command-tile" aria-hidden="true"><span className="ribbon-icon">{icon}</span></span>
      <span className="ribbon-label">{label}</span>
    </>
  );

  if (children) {
    return <label className={className} data-tooltip={tooltip}>{content}</label>;
  }
  return <button className={className} data-tooltip={tooltip} onClick={onClick}>{content}</button>;
}

function formatProjectDate(value?: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function baseNameFromFile(fileName: string) {
  const clean = (fileName || '').split(/[\\/]/).pop() || 'project';
  return clean
    .replace(/\.pilenum\.json$/i, '')
    .replace(/\.json$/i, '')
    .replace(/\.csv$/i, '')
    .trim() || 'project';
}

function needsSaveNamePrompt(project: PileProject) {
  return !project.project.fileName;
}


interface CsvPreviewData {
  file: File;
  fileName: string;
  delimiter: string;
  hasHeader: boolean;
  columns: string[];
  rows: string[][];
  previewRows: string[][];
  sourceKind: 'csv' | 'excel';
  sheetName?: string;
}

type TransferSource = 'file' | 'nanocad';
type ExportTarget = 'json' | 'nanocad';

type ModelIssueLevel = 'error' | 'warning' | 'info';

interface ModelIssue {
  level: ModelIssueLevel;
  title: string;
  details: string[];
}

interface ModelCheckResult {
  totalPoints: number;
  totalGroups: number;
  pointsWithoutGroup: number;
  unnumberedPoints: number;
  manualNumberedPoints: number;
  duplicateNumbersGlobal: number;
  duplicateManualNumbers: number;
  invalidGroupRefs: number;
  emptyGroups: number;
  invalidManualLinks: number;
  issues: ModelIssue[];
}

function safeFileName(value: string, fallback = 'project') {
  const clean = (value || fallback).trim().replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_').replace(/^\.+|\.+$/g, '');
  return clean || fallback;
}

function detectDelimiter(line: string) {
  const candidates = [';', ',', '\t'];
  return candidates
    .map((delimiter) => ({ delimiter, count: splitCsvLine(line, delimiter).length }))
    .sort((a, b) => b.count - a.count)[0]?.delimiter ?? ';';
}

function splitCsvLine(line: string, delimiter: string) {
  const result: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"') {
      if (quoted && next === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === delimiter && !quoted) {
      result.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  result.push(current.trim());
  return result;
}

function looksLikeNumber(value: string) {
  const clean = value.trim().replace(/\s+/g, '').replace(',', '.');
  return clean !== '' && Number.isFinite(Number(clean));
}

function parseImportNumber(value: string) {
  const clean = value.trim().replace(/\s+/g, '').replace(',', '.');
  if (!clean) return NaN;
  const parsed = Number(clean);
  return Number.isFinite(parsed) ? parsed : NaN;
}

interface ModelStudioImportMatch {
  existing: PilePoint;
  incoming: PilePoint;
  distance: number;
}

function splitModelStudioImportPoints(existingPoints: PilePoint[], incomingPoints: PilePoint[], tolerance = 1) {
  const used = new Set<string>();
  const matches: ModelStudioImportMatch[] = [];
  const newPoints: PilePoint[] = [];
  const safeTolerance = Math.max(0.000001, tolerance);

  for (const incoming of incomingPoints) {
    let best: ModelStudioImportMatch | null = null;
    for (const existing of existingPoints) {
      if (used.has(existing.id)) continue;
      const dist = Math.hypot(existing.x - incoming.x, existing.y - incoming.y);
      if (dist <= safeTolerance && (!best || dist < best.distance)) best = { existing, incoming, distance: dist };
    }
    if (best) {
      used.add(best.existing.id);
      matches.push(best);
    } else {
      newPoints.push(incoming);
    }
  }

  return { matches, newPoints };
}

function replaceModelStudioMatchedPoints(existingPoints: PilePoint[], matches: ModelStudioImportMatch[], newPoints: PilePoint[]) {
  const byExistingId = new Map(matches.map((match) => [match.existing.id, match]));
  const replaced = existingPoints.map((point) => {
    const match = byExistingId.get(point.id);
    if (!match) return point;
    return {
      ...match.incoming,
      id: point.id,
      groupId: point.groupId ?? match.incoming.groupId ?? null,
      locked: point.locked,
      manualNumber: point.manualNumber,
      meta: {
        ...(point.meta ?? {}),
        ...(match.incoming.meta ?? {}),
        replacedFromNanoCad: true,
        previousSourceNumber: point.sourceNumber ?? null,
        previousNumber: point.number ?? null
      }
    };
  });
  return [...replaced, ...newPoints];
}


function guessHasHeader(firstRow: string[], secondRow: string[]) {
  if (!firstRow.length) return false;
  const namedColumns = firstRow.filter((value) => /[a-zа-я]/i.test(value)).length;
  const numericInFirst = firstRow.filter(looksLikeNumber).length;
  const numericInSecond = secondRow.filter(looksLikeNumber).length;
  return namedColumns > 0 || (numericInFirst < Math.max(1, numericInSecond) && numericInSecond >= 2);
}

function guessColumnIndex(columns: string[], patterns: RegExp[], fallback: number) {
  const index = columns.findIndex((column) => patterns.some((pattern) => pattern.test(column.trim())));
  return index >= 0 ? index : Math.min(fallback, Math.max(0, columns.length - 1));
}

function escapeCsv(value: string) {
  const text = String(value ?? '');
  if (/[",\n\r;]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

async function readTextFile(file: File) {
  const buffer = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    try {
      return new TextDecoder('windows-1251').decode(buffer);
    } catch {
      return new TextDecoder('utf-8').decode(buffer);
    }
  }
}

async function buildCsvPreview(file: File): Promise<CsvPreviewData> {
  const text = (await readTextFile(file)).replace(/^\uFEFF/, '');
  const rawLines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (rawLines.length === 0) throw new Error('CSV пустой.');
  const delimiter = detectDelimiter(rawLines[0]);
  const parsedRows = rawLines.map((line) => splitCsvLine(line, delimiter));
  const width = Math.max(...parsedRows.map((row) => row.length));
  const normalizedRows = parsedRows.map((row) => Array.from({ length: width }, (_, index) => row[index] ?? ''));
  const hasHeader = guessHasHeader(normalizedRows[0] ?? [], normalizedRows[1] ?? []);
  const columns = hasHeader
    ? (normalizedRows[0] ?? []).map((value, index) => value.trim() || `Колонка ${index + 1}`)
    : Array.from({ length: width }, (_, index) => `Колонка ${index + 1}`);
  const rows = hasHeader ? normalizedRows.slice(1) : normalizedRows;
  if (columns.length < 2) throw new Error('В CSV должно быть минимум две колонки для X и Y.');
  return { file, fileName: file.name, delimiter, hasHeader, columns, rows, previewRows: rows.slice(0, 12), sourceKind: 'csv' };
}

async function buildExcelPreview(file: File): Promise<CsvPreviewData> {
  const XLSX = await import('xlsx');
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('В Excel-файле нет листов.');
  const sheet = workbook.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json<Array<string | number | boolean | null>>(sheet, {
    header: 1,
    blankrows: false,
    defval: ''
  }) as Array<Array<string | number | boolean | null>>;
  const parsedRows = rawRows
    .map((row) => row.map((value) => String(value ?? '').trim()))
    .filter((row) => row.some((value) => value.trim() !== ''));
  if (parsedRows.length === 0) throw new Error('Excel-лист пустой.');
  const width = Math.max(...parsedRows.map((row) => row.length));
  const normalizedRows = parsedRows.map((row) => Array.from({ length: width }, (_, index) => row[index] ?? ''));
  const hasHeader = guessHasHeader(normalizedRows[0] ?? [], normalizedRows[1] ?? []);
  const columns = hasHeader
    ? (normalizedRows[0] ?? []).map((value, index) => value.trim() || `Колонка ${index + 1}`)
    : Array.from({ length: width }, (_, index) => `Колонка ${index + 1}`);
  const rows = hasHeader ? normalizedRows.slice(1) : normalizedRows;
  if (columns.length < 2) throw new Error('В Excel должно быть минимум две колонки для X и Y.');
  return { file, fileName: file.name, delimiter: '', hasHeader, columns, rows, previewRows: rows.slice(0, 12), sourceKind: 'excel', sheetName };
}

async function buildImportPreview(file: File): Promise<CsvPreviewData> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) return buildExcelPreview(file);
  return buildCsvPreview(file);
}

function makeNormalizedCsvFile(
  preview: CsvPreviewData,
  xIndex: number,
  yIndex: number,
  numberIndex: number | null,
  basePoint: { enabled: boolean; x: number; y: number }
) {
  const lines = ['X,Y,Number'];
  for (const row of preview.rows) {
    const rawX = row[xIndex] ?? '';
    const rawY = row[yIndex] ?? '';
    if (!rawX.trim() && !rawY.trim()) continue;
    let x = rawX;
    let y = rawY;
    if (basePoint.enabled) {
      const parsedX = parseImportNumber(rawX);
      const parsedY = parseImportNumber(rawY);
      if (Number.isFinite(parsedX)) x = String(Math.round((parsedX + basePoint.x) * 1000) / 1000);
      if (Number.isFinite(parsedY)) y = String(Math.round((parsedY + basePoint.y) * 1000) / 1000);
    }
    const number = numberIndex === null ? '' : row[numberIndex] ?? '';
    lines.push([x, y, number].map(escapeCsv).join(','));
  }
  const name = preview.fileName.replace(/\.(csv|xlsx|xls)$/i, '') || 'import';
  return new File([lines.join('\n')], `${name}.normalized.csv`, { type: 'text/csv;charset=utf-8' });
}


function isPointUnnumbered(point: PileProject['points'][number]) {
  return point.number === null || point.number === undefined || !Number.isFinite(Number(point.number));
}

function pointDisplayName(point: PileProject['points'][number], index: number) {
  const source = point.sourceNumber ? ` · исходный № ${point.sourceNumber}` : '';
  const number = point.number !== null && point.number !== undefined ? ` · номер ${point.number}` : ' · без номера';
  return `${index + 1}: id ${point.id.slice(-6)}${number}${source} · X=${point.x}, Y=${point.y}`;
}

function groupDisplayName(project: PileProject, groupId: string | null | undefined) {
  if (!groupId) return 'Без группы';
  return project.groups.find((group) => group.id === groupId)?.name ?? `Неизвестная группа ${groupId}`;
}

function pushIssue(issues: ModelIssue[], level: ModelIssueLevel, title: string, details: string[]) {
  if (details.length === 0) return;
  issues.push({ level, title, details: details.slice(0, 18) });
}

function buildModelCheck(project: PileProject): ModelCheckResult {
  const issues: ModelIssue[] = [];
  const groupIds = new Set(project.groups.map((group) => group.id));
  const pointById = new Map(project.points.map((point) => [point.id, point]));
  const pointIndex = new Map(project.points.map((point, index) => [point.id, index]));
  const pointsWithoutGroup = project.points.filter((point) => !point.groupId).length;
  const invalidGroupRefPoints = project.points.filter((point) => point.groupId && !groupIds.has(point.groupId));
  const unnumbered = project.points.filter(isPointUnnumbered);
  const manualNumbered = project.points.filter((point) => point.manualNumber);

  pushIssue(issues, 'warning', 'Точки без группы', project.points
    .map((point, index) => (!point.groupId ? pointDisplayName(point, index) : ''))
    .filter(Boolean));

  pushIssue(issues, 'warning', 'Точки без номера', unnumbered.map((point) => pointDisplayName(point, pointIndex.get(point.id) ?? 0)));

  pushIssue(issues, 'error', 'Точки с неизвестной группой', invalidGroupRefPoints.map((point) => `${pointDisplayName(point, pointIndex.get(point.id) ?? 0)} · groupId=${point.groupId}`));

  const emptyGroups = project.groups.filter((group) => !project.points.some((point) => point.groupId === group.id));
  pushIssue(issues, 'info', 'Пустые группы', emptyGroups.map((group) => `${group.name} · id ${group.id.slice(-6)}`));

  const duplicateGlobalDetails: string[] = [];
  const byNumber = new Map<number, typeof project.points>();
  for (const point of project.points) {
    if (isPointUnnumbered(point)) continue;
    const number = Number(point.number);
    const current = byNumber.get(number) ?? [];
    current.push(point);
    byNumber.set(number, current);
  }
  for (const [number, points] of byNumber) {
    if (points.length <= 1) continue;
    duplicateGlobalDetails.push(`№ ${number}: ${points.map((point) => `${groupDisplayName(project, point.groupId)} / ${point.id.slice(-6)}`).join('; ')}`);
  }
  pushIssue(issues, 'error', 'Дубли номеров в проекте', duplicateGlobalDetails);

  const duplicateManualDetails: string[] = [];
  const manualByNumber = new Map<number, typeof project.points>();
  for (const point of manualNumbered) {
    if (isPointUnnumbered(point)) continue;
    const number = Number(point.number);
    const current = manualByNumber.get(number) ?? [];
    current.push(point);
    manualByNumber.set(number, current);
  }
  for (const [number, points] of manualByNumber) {
    if (points.length <= 1) continue;
    duplicateManualDetails.push(`Ручной № ${number}: ${points.map((point) => `${groupDisplayName(project, point.groupId)} / ${point.id.slice(-6)}`).join('; ')}`);
  }
  pushIssue(issues, 'error', 'Дубли ручных номеров', duplicateManualDetails);

  const invalidLinks: string[] = [];
  for (const group of project.groups) {
    const groupPointIds = new Set(project.points.filter((point) => point.groupId === group.id).map((point) => point.id));
    const seenLinks = new Set<string>();
    for (const link of group.numbering.manualLinks ?? []) {
      const key = `${link.fromId}->${link.toId}`;
      if (seenLinks.has(key)) invalidLinks.push(`${group.name}: дубль связи ${link.fromId.slice(-6)} → ${link.toId.slice(-6)}`);
      seenLinks.add(key);
      if (!link.fromId || !link.toId || link.fromId === link.toId) invalidLinks.push(`${group.name}: некорректная ручная связь ${key}`);
      if (!pointById.has(link.fromId) || !pointById.has(link.toId)) invalidLinks.push(`${group.name}: связь указывает на удалённую точку ${key}`);
      if (!groupPointIds.has(link.fromId) || !groupPointIds.has(link.toId)) invalidLinks.push(`${group.name}: связь выходит за пределы группы ${key}`);
    }
  }
  pushIssue(issues, 'error', 'Проблемы ручных связей', invalidLinks);

  if (issues.length === 0) {
    issues.push({
      level: 'info',
      title: 'Критичных проблем не найдено',
      details: ['Группы, ссылки, номера и ручные связи прошли базовую проверку модели.']
    });
  }

  return {
    totalPoints: project.points.length,
    totalGroups: project.groups.length,
    pointsWithoutGroup,
    unnumberedPoints: unnumbered.length,
    manualNumberedPoints: manualNumbered.length,
    duplicateNumbersGlobal: duplicateGlobalDetails.length,
    duplicateManualNumbers: duplicateManualDetails.length,
    invalidGroupRefs: invalidGroupRefPoints.length,
    emptyGroups: emptyGroups.length,
    invalidManualLinks: invalidLinks.length,
    issues
  };
}


function manualLinkKey(fromId: string, toId: string) {
  return `${fromId}->${toId}`;
}

export function Toolbar({ onCsvImport, canvasWidth, canvasHeight, onHeightChange }: Props) {
  const {
    toggleGrid,
    updateViewSettings,
    project,
    groupManagerVisible,
    journalVisible,
    pointInfoVisible,
    editingPanelVisible,
    editingTool,
    numberingPreview,
    selectedGroupId,
    selectedPointIds,
    autoAssignSelection,
    manualLinkClearMode,
    manualLinkClearSelection,
    openProjectFromFile,
    createNewProject,
    setProjectLocalFileName,
    setProjectName,
    pushHistory,
    applyRowsNumbering,
    applyRowsNumberingAll,
    assignSelectionToGroup,
    toggleAutoAssignSelection,
    toggleGroupManager,
    toggleJournal,
    togglePointInfo,
    openEditingTool,
    deleteSelectedPoints,
    toggleNumberingPreview,
    setNumberingPreviewMode,
    startManualLinkClearMode,
    cancelManualLinkClearMode,
    setManualLinkClearSelection,
    toggleManualLinkClearSelection,
    clearSelectedNumberingManualLinks,
    recordOperation,
    undo,
    redo,
    zoomExtents,
    setSelection,
    cancelNumberingPreview,
    closeEditingPanel,
    appendImportedPoints,
    setPoints,
    updateGroupMeta
  } = useProjectStore();

  const [toolbarHeight, setToolbarHeight] = useState(loadToolbarHeight);
  const [ribbonMode, setRibbonMode] = useState<RibbonMode>(loadRibbonMode);
  const [ribbonDensity, setRibbonDensity] = useState<RibbonDensity>(loadRibbonDensity);
  const [activeTab, setActiveTab] = useState<RibbonTab>(loadRibbonTab);
  const [collapsedSections, setCollapsedSections] = useState<SectionId[]>(loadCollapsedSections);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [aboutEmailCopied, setAboutEmailCopied] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [localProjects, setLocalProjects] = useState<LocalProjectInfo[]>([]);
  const [projectStatus, setProjectStatus] = useState<string>('');
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [createProjectName, setCreateProjectName] = useState('Новый проект');
  const [renameProjectOpen, setRenameProjectOpen] = useState(false);
  const [renameProjectName, setRenameProjectName] = useState('');
  const [importPanelOpen, setImportPanelOpen] = useState(false);
  const [importSource, setImportSource] = useState<TransferSource>('file');
  const [importPreview, setImportPreview] = useState<CsvPreviewData | null>(null);
  const [importXColumn, setImportXColumn] = useState('0');
  const [importYColumn, setImportYColumn] = useState('1');
  const [importNumberColumn, setImportNumberColumn] = useState('');
  const [importStatus, setImportStatus] = useState('');
  const [importUseBasePoint, setImportUseBasePoint] = useState(false);
  const [importBaseX, setImportBaseX] = useState('0');
  const [importBaseY, setImportBaseY] = useState('0');
  const [nanoCadMode, setNanoCadMode] = useState<'blocks' | 'model_studio'>('blocks');
  const [nanoCadBlockMode, setNanoCadBlockMode] = useState<'scan' | 'pick'>('scan');
  const [nanoCadBlocks, setNanoCadBlocks] = useState<NanoCadBlockSummary[]>([]);
  const [nanoCadSelectedBlock, setNanoCadSelectedBlock] = useState('');
  const [nanoCadNumberAttribute, setNanoCadNumberAttribute] = useState('');
  const [nanoCadModelObjects, setNanoCadModelObjects] = useState<NanoCadModelStudioObjectSummary[]>([]);
  const [nanoCadSelectedModelObject, setNanoCadSelectedModelObject] = useState('');
  const [nanoCadModelNumberParameter, setNanoCadModelNumberParameter] = useState('');
  const [nanoCadModelObjectFilter, setNanoCadModelObjectFilter] = useState('');
  const [nanoCadModelNameMode, setNanoCadModelNameMode] = useState<'display' | 'technical'>('display');
  const [nanoCadSelectedModelObjectNames, setNanoCadSelectedModelObjectNames] = useState<string[]>([]);
  const [nanoCadModelNumberParameterByObject, setNanoCadModelNumberParameterByObject] = useState<Record<string, string>>({});
  const [nanoCadStatus, setNanoCadStatus] = useState('');
  const [exportPanelOpen, setExportPanelOpen] = useState(false);
  const [exportTarget, setExportTarget] = useState<ExportTarget>('json');
  const [exportNanoCadMode, setExportNanoCadMode] = useState<'blocks' | 'model_studio'>('blocks');
  const [exportSelectedGroupIds, setExportSelectedGroupIds] = useState<string[]>([]);
  const [exportUseBasePoint, setExportUseBasePoint] = useState(true);
  const [exportBaseX, setExportBaseX] = useState('0');
  const [exportBaseY, setExportBaseY] = useState('0');
  const [exportTolerance, setExportTolerance] = useState('1');
  const [exportStatus, setExportStatus] = useState('');
  const [modelCheckOpen, setModelCheckOpen] = useState(false);
  const [clearLinksPanelOpen, setClearLinksPanelOpen] = useState(false);
  const resizeRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const importFileInputRef = useRef<HTMLInputElement | null>(null);
  const ribbonScrollRef = useRef<HTMLDivElement | null>(null);
  const ribbonScrollLeftRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    getUserConfig()
      .then((config) => {
        if (cancelled) return;
        if (typeof config.toolbarHeight === 'number' && Number.isFinite(config.toolbarHeight)) {
          setToolbarHeight(clamp(config.toolbarHeight, MIN_TOOLBAR_HEIGHT, MAX_TOOLBAR_HEIGHT));
        }
      })
      .catch(() => {
        // fallback to localStorage
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    onHeightChange(toolbarHeight);
    try {
      window.localStorage.setItem(TOOLBAR_STORAGE_KEY, String(toolbarHeight));
    } catch {
      // ignore
    }
    const timer = window.setTimeout(() => {
      getUserConfig()
        .then((config) => saveUserConfig({ ...config, toolbarHeight }))
        .catch(() => {
          // backend config unavailable in browser fallback
        });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [onHeightChange, toolbarHeight]);

  useEffect(() => {
    try {
      window.localStorage.setItem(RIBBON_MODE_KEY, ribbonMode);
      window.localStorage.setItem(RIBBON_TAB_KEY, activeTab);
      window.localStorage.setItem(RIBBON_DENSITY_KEY, ribbonDensity);
      window.localStorage.setItem(RIBBON_COLLAPSED_KEY, JSON.stringify(collapsedSections));
    } catch {
      // ignore
    }
  }, [activeTab, collapsedSections, ribbonMode, ribbonDensity]);

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const resize = resizeRef.current;
      if (!resize) return;
      const nextHeight = clamp(resize.startHeight + event.clientY - resize.startY, MIN_TOOLBAR_HEIGHT, MAX_TOOLBAR_HEIGHT);
      setToolbarHeight(nextHeight);
    };

    const onUp = () => {
      resizeRef.current = null;
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  useLayoutEffect(() => {
    const node = ribbonScrollRef.current;
    if (!node) return;
    const maxScroll = Math.max(0, node.scrollWidth - node.clientWidth);
    node.scrollLeft = Math.min(ribbonScrollLeftRef.current, maxScroll);
  });

  const heightScale = useMemo(() => clamp((toolbarHeight - 30) / (DEFAULT_TOOLBAR_HEIGHT - 30), 0.58, 1.18), [toolbarHeight]);
  const widthScale = useMemo(() => clamp(toolbarHeight / DEFAULT_TOOLBAR_HEIGHT, 0.94, 1.06), [toolbarHeight]);
  const densityPreset = DENSITY_PRESETS[ribbonDensity];
  const currentSectionIds = ribbonMode === 'all' ? ALL_SECTIONS : TAB_SECTIONS[activeTab];
  const allCurrentCollapsed = currentSectionIds.every((id) => collapsedSections.includes(id));
  const modelCheck = useMemo(() => buildModelCheck(project), [project]);


  const scaledWidthPx = (value: number) => `${Math.round(value * widthScale)}px`;
  const scaledHeightPx = (value: number) => `${Math.round(value * heightScale)}px`;
  const toolbarStyle = {
    '--toolbar-scale': String(heightScale),
    '--toolbar-height': `${toolbarHeight}px`,
    '--ribbon-command-width': scaledWidthPx(densityPreset.commandWidth),
    '--ribbon-command-height': scaledHeightPx(densityPreset.commandHeight),
    '--ribbon-tile-width': scaledWidthPx(densityPreset.tileWidth),
    '--ribbon-tile-height': scaledHeightPx(densityPreset.tileHeight),
    '--ribbon-icon-size': `${Math.max(17, Math.round(densityPreset.tileHeight * 0.54 * heightScale))}px`,
    '--ribbon-command-gap': scaledWidthPx(densityPreset.commandGap),
    '--ribbon-group-min-height': scaledHeightPx(densityPreset.groupMinHeight),
    '--ribbon-section-padding-y': scaledHeightPx(densityPreset.sectionPaddingY),
    '--ribbon-label-font-size': `${Math.max(9, Math.round(10.8 * heightScale * 10) / 10)}px`,
    '--ribbon-label-height': `${Math.max(16, Math.round(23 * heightScale))}px`
  } as CSSProperties;

  const isSectionVisible = (id: SectionId) => ribbonMode === 'all' || TAB_SECTIONS[activeTab].includes(id);
  const isSectionCollapsed = (id: SectionId) => collapsedSections.includes(id);

  const toggleSection = (id: SectionId) => {
    setCollapsedSections((items) => items.includes(id) ? items.filter((x) => x !== id) : [...items, id]);
  };

  const toggleCurrentSections = () => {
    setCollapsedSections((items) => {
      const current = new Set(currentSectionIds);
      if (allCurrentCollapsed) return items.filter((id) => !current.has(id));
      return Array.from(new Set([...items, ...currentSectionIds]));
    });
  };

  const showAllCurrentSections = () => {
    const current = new Set(currentSectionIds);
    setCollapsedSections((items) => items.filter((id) => !current.has(id)));
  };

  const resetRibbonLayout = () => {
    setRibbonMode('tabs');
    setActiveTab('file');
    setCollapsedSections([]);
    setRibbonDensity('normal');
    setToolbarHeight(DEFAULT_TOOLBAR_HEIGHT);
  };

  const RibbonSection = ({ id, title, className, children }: { id: SectionId; title: string; className?: string; children: ReactNode }) => {
    if (!isSectionVisible(id)) return null;
    const collapsed = isSectionCollapsed(id);
    return (
      <div className={`ribbon-section ${className ?? ''} ${collapsed ? 'collapsed-ribbon-section' : ''}`.trim()}>
        <div className="ribbon-section-head">
          <div className="ribbon-section-title">{title}</div>
          <button
            className="ribbon-section-toggle"
            data-tooltip={collapsed ? 'Развернуть секцию' : 'Свернуть секцию'}
            onClick={() => toggleSection(id)}
          >
            {collapsed ? '▸' : '▾'}
          </button>
        </div>
        {!collapsed && children}
      </div>
    );
  };

  const downloadProjectJson = async () => {
    const { gridSettings: _gridSettings, viewSettings: _viewSettings, ...projectPayload } = project;
    const fileName = `${safeFileName(project.project.name || 'project')}.pilenum.json`;
    const jsonText = JSON.stringify(projectPayload, null, 2);
    const blob = new Blob([jsonText], { type: 'application/json;charset=utf-8' });

    const desktopApi = (window as unknown as {
      pywebview?: { api?: { saveProjectJson?: (fileName: string, content: string) => Promise<{ saved?: boolean; path?: string; canceled?: boolean; error?: string }> } };
    }).pywebview?.api;

    if (desktopApi?.saveProjectJson) {
      try {
        const result = await desktopApi.saveProjectJson(fileName, jsonText);
        if (result?.saved) {
          setProjectStatus(`Экспортирован JSON: ${result.path || fileName}`);
          return;
        }
        if (result?.canceled) {
          setProjectStatus('Экспорт JSON отменён пользователем.');
          return;
        }
        if (result?.error) throw new Error(result.error);
      } catch (error) {
        console.warn('pywebview JSON export failed, trying browser save picker', error);
      }
    }

    const picker = (window as unknown as {
      showSaveFilePicker?: (options: unknown) => Promise<{ createWritable: () => Promise<{ write: (data: Blob) => Promise<void>; close: () => Promise<void> }> }>;
    }).showSaveFilePicker;

    if (picker) {
      try {
        const handle = await picker({
          suggestedName: fileName,
          types: [{
            description: 'Pile Numbering project JSON',
            accept: { 'application/json': ['.pilenum.json', '.json'] }
          }]
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        setProjectStatus(`Экспортирован JSON: ${fileName}`);
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          setProjectStatus('Экспорт JSON отменён пользователем.');
          return;
        }
        console.warn('showSaveFilePicker failed, falling back to link download', error);
      }
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setProjectStatus(`Экспортирован JSON: ${fileName}`);
  };

  const openCreateProjectDialog = () => {
    setCreateProjectName(project.project.name && project.project.name !== 'Untitled project' ? `${project.project.name} копия` : 'Новый проект');
    setCreateProjectOpen(true);
  };

  const createProjectFromDialog = () => {
    const cleanName = createProjectName.trim();
    if (!cleanName) {
      setProjectStatus('Имя проекта не задано. Создание отменено.');
      return;
    }
    createNewProject(cleanName);
    setCreateProjectOpen(false);
    setProjectsOpen(true);
    setProjectStatus(`Создан новый пустой проект: ${cleanName}`);
  };

  const openRenameProjectDialog = () => {
    setRenameProjectName(project.project.name || 'Без имени');
    setRenameProjectOpen(true);
  };

  const renameProjectFromDialog = () => {
    const cleanName = renameProjectName.trim();
    if (!cleanName) {
      setProjectStatus('Имя проекта не задано. Переименование отменено.');
      return;
    }
    if (cleanName === project.project.name) {
      setRenameProjectOpen(false);
      return;
    }
    pushHistory();
    setProjectName(cleanName);
    setRenameProjectOpen(false);
    recordOperation('project_renamed', { name: cleanName, previousName: project.project.name });
    setProjectStatus(`Проект переименован: ${cleanName}. При следующем сохранении файл получит это имя.`);
  };

  const openImportDialog = () => {
    setImportPanelOpen(true);
    setImportSource('file');
    setImportStatus('');
  };

  const openExportDialog = () => {
    setExportPanelOpen(true);
    setExportTarget('json');
    setExportStatus('');
    if (project.groups.length && exportSelectedGroupIds.length === 0) setExportSelectedGroupIds(project.groups.map((group) => group.id));
    setProjectStatus('');
  };

  const selectImportFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      setImportStatus('Читаю файл...');
      const preview = await buildImportPreview(file);
      const xIndex = guessColumnIndex(preview.columns, [/^x$/i, /^х$/i, /coord.*x/i, /коорд.*x/i], 0);
      const yIndex = guessColumnIndex(preview.columns, [/^y$/i, /^у$/i, /coord.*y/i, /коорд.*y/i], Math.min(1, preview.columns.length - 1));
      const nIndex = preview.columns.findIndex((column) => /^(n|no|num|number|номер|№)$/i.test(column.trim()) || /номер/i.test(column));
      setImportPreview(preview);
      setImportXColumn(String(xIndex));
      setImportYColumn(String(yIndex));
      setImportNumberColumn(nIndex >= 0 ? String(nIndex) : '');
      const sheetText = preview.sheetName ? ` · лист: ${preview.sheetName}` : '';
      setImportStatus(`Файл загружен: ${file.name}${sheetText}. Проверь колонки X/Y и подтверди импорт.`);
    } catch (e) {
      setImportPreview(null);
      setImportStatus(e instanceof Error ? e.message : 'Не удалось прочитать файл. Для Excel нужен установленный пакет xlsx.');
    } finally {
      event.currentTarget.value = '';
    }
  };

  const confirmImportFromFile = async () => {
    if (!importPreview) {
      setImportStatus('Сначала выбери CSV-файл.');
      return;
    }
    const xIndex = Number(importXColumn);
    const yIndex = Number(importYColumn);
    const numberIndex = importNumberColumn === '' ? null : Number(importNumberColumn);
    if (!Number.isInteger(xIndex) || !Number.isInteger(yIndex) || xIndex === yIndex) {
      setImportStatus('Выбери разные колонки X и Y.');
      return;
    }
    if (numberIndex !== null && (numberIndex === xIndex || numberIndex === yIndex)) {
      setImportStatus('Колонка номера не должна совпадать с X/Y.');
      return;
    }
    const baseX = importUseBasePoint ? parseImportNumber(importBaseX) : 0;
    const baseY = importUseBasePoint ? parseImportNumber(importBaseY) : 0;
    if (importUseBasePoint && (!Number.isFinite(baseX) || !Number.isFinite(baseY))) {
      setImportStatus('Базовая точка должна быть числом по X и Y.');
      return;
    }
    const normalized = makeNormalizedCsvFile(importPreview, xIndex, yIndex, numberIndex, { enabled: importUseBasePoint, x: baseX, y: baseY });
    const imported = await importCsv(normalized);
    const withMeta = imported.map((point) => ({
      ...point,
      meta: {
        ...(point.meta ?? {}),
        source: importPreview.sourceKind,
        originalFileName: importPreview.fileName,
        importBasePoint: importUseBasePoint ? { x: baseX, y: baseY } : { x: 0, y: 0 }
      }
    }));
    appendImportedPoints(importPreview.fileName, withMeta);
    requestAnimationFrame(() => zoomExtents(canvasWidth, canvasHeight));
    setImportStatus(`Импортировано в текущий проект: ${importPreview.fileName}`);
    setProjectStatus(`Импорт добавлен в текущий проект: ${importPreview.fileName}${importUseBasePoint ? ` · базовая точка ${baseX}; ${baseY}` : ''}`);
    setImportPanelOpen(false);
    setImportPreview(null);
  };


  const setNanoCadTransferStatus = (target: 'import' | 'export', message: string) => {
    if (target === 'export') setExportStatus(message);
    else setNanoCadStatus(message);
  };

  const refreshNanoCadBlocks = async (target: 'import' | 'export' = 'import') => {
    try {
      setNanoCadTransferStatus(target, 'Подключаюсь к nanoCAD и читаю блоки...');
      const data = await scanNanoCadBlocks();
      setNanoCadBlocks(data.blocks);
      const first = data.blocks[0];
      if (first) {
        setNanoCadSelectedBlock((current) => current || first.name);
        setNanoCadNumberAttribute((current) => current || first.numberAttributeCandidates[0] || first.attributes[0]?.tag || '');
      }
      setNanoCadTransferStatus(target, `Скан блоков готов: найдено типов ${data.blocks.length}${data.documentName ? ` · ${data.documentName}` : ''}`);
    } catch (e) {
      setNanoCadTransferStatus(target, e instanceof Error ? e.message : 'Не удалось прочитать блоки nanoCAD.');
    }
  };

  const pickNanoCadSample = async (target: 'import' | 'export' = 'import') => {
    try {
      setNanoCadTransferStatus(target, 'Жду выбора блока в nanoCAD...');
      const picked = await pickNanoCadBlockSample();
      setNanoCadSelectedBlock(picked.blockName);
      setNanoCadNumberAttribute(picked.numberAttributeCandidates[0] || Object.keys(picked.attributes)[0] || '');
      setNanoCadTransferStatus(target, `Выбран образец блока: ${picked.blockName}. Сканирую все такие блоки.`);
      await refreshNanoCadBlocks(target);
      setNanoCadSelectedBlock(picked.blockName);
    } catch (e) {
      setNanoCadTransferStatus(target, e instanceof Error ? e.message : 'Не удалось выбрать блок в nanoCAD.');
    }
  };

  const modelStudioObjectLabel = (obj: NanoCadModelStudioObjectSummary) => {
    const humanName = obj.displayName || obj.name;
    const apiType = obj.technicalName || obj.name;
    return nanoCadModelNameMode === 'technical' ? apiType : humanName;
  };

  const modelStudioObjectMeta = (obj: NanoCadModelStudioObjectSummary) => {
    const apiType = obj.technicalName || obj.name;
    const coords = typeof obj.coordinateCount === 'number' ? `координаты ${obj.coordinateCount}/${obj.count}` : `объектов ${obj.count}`;
    return `Тип элемента API: ${apiType} · ${obj.count} шт. · ${coords}`;
  };

  const modelStudioObjectsForList = useMemo(() => nanoCadModelObjects, [nanoCadModelObjects]);

  const modelStudioSelectedObject = useMemo(() => (
    nanoCadModelObjects.find((obj) => obj.name === nanoCadSelectedModelObject) ?? nanoCadModelObjects.find((obj) => nanoCadSelectedModelObjectNames.includes(obj.name)) ?? nanoCadModelObjects[0] ?? null
  ), [nanoCadModelObjects, nanoCadSelectedModelObject, nanoCadSelectedModelObjectNames]);

  const selectedModelStudioObjectNamesForRequest = () => {
    const valid = new Set(nanoCadModelObjects.map((obj) => obj.name));
    const names = nanoCadSelectedModelObjectNames.filter((name) => valid.has(name));
    if (names.length > 0) return names;
    return nanoCadSelectedModelObject ? [nanoCadSelectedModelObject] : [];
  };

  const defaultModelStudioParameter = (obj: NanoCadModelStudioObjectSummary | null | undefined) => (
    obj?.numberParameterCandidates.find((name) => name.toUpperCase() === 'GPP_PILE_NUMBER') ||
    obj?.numberParameterCandidates[0] ||
    obj?.parameters.find((param) => param.name.toUpperCase() === 'GPP_PILE_NUMBER')?.name ||
    obj?.parameters[0]?.name ||
    ''
  );

  const modelStudioNumberParameterForObject = (name: string) => {
    const obj = nanoCadModelObjects.find((item) => item.name === name);
    return nanoCadModelNumberParameterByObject[name] ?? defaultModelStudioParameter(obj);
  };

  const setModelStudioNumberParameterForObject = (name: string, parameter: string) => {
    setNanoCadModelNumberParameterByObject((items) => ({ ...items, [name]: parameter }));
  };

  const selectModelStudioMainObject = (name: string) => {
    setNanoCadSelectedModelObject(name);
    setNanoCadSelectedModelObjectNames((items) => items.includes(name) ? items : [...items, name]);
    const parameter = modelStudioNumberParameterForObject(name);
    setNanoCadModelNumberParameter(parameter);
  };

  const toggleModelStudioObjectSelection = (name: string, checked: boolean) => {
    setNanoCadSelectedModelObjectNames((items) => checked ? Array.from(new Set([...items, name])) : items.filter((item) => item !== name));
    if (checked) selectModelStudioMainObject(name);
  };

  const refreshNanoCadModelStudioObjects = async (target: 'import' | 'export' = 'import') => {
    try {
      setNanoCadTransferStatus(target, 'Подключаюсь к nanoCAD и читаю объекты Model Studio...');
      const data = await scanNanoCadModelStudioObjects();
      setNanoCadModelObjects(data.objects);
      const defaultParams = Object.fromEntries(data.objects.map((obj) => [obj.name, defaultModelStudioParameter(obj)]));
      setNanoCadModelNumberParameterByObject(defaultParams);
      const selectedByDefault = data.objects.filter((obj) => (obj.coordinateCount ?? obj.count) > 0).map((obj) => obj.name);
      const first = data.objects[0];
      if (first) {
        setNanoCadSelectedModelObject(first.name);
        setNanoCadSelectedModelObjectNames(selectedByDefault.length ? selectedByDefault : [first.name]);
        setNanoCadModelNumberParameter(defaultModelStudioParameter(first));
      } else {
        setNanoCadSelectedModelObject('');
        setNanoCadSelectedModelObjectNames([]);
        setNanoCadModelNumberParameter('');
      }
      const withCoords = data.objects.reduce((sum, obj) => sum + (obj.coordinateCount ?? 0), 0);
      const total = data.objects.reduce((sum, obj) => sum + obj.count, 0);
      setNanoCadTransferStatus(target, `Скан Model Studio готов: групп ${data.objects.length}, объектов ${total}, с координатами ${withCoords}${data.documentName ? ` · ${data.documentName}` : ''}`);
    } catch (e) {
      setNanoCadTransferStatus(target, e instanceof Error ? e.message : 'Не удалось прочитать объекты Model Studio.');
    }
  };

  const selectedExportGroups = useMemo(() => {
    if (exportSelectedGroupIds.length === 0) return project.groups;
    const selected = new Set(exportSelectedGroupIds);
    return project.groups.filter((group) => selected.has(group.id));
  }, [exportSelectedGroupIds, project.groups]);

  const exportPoints = useMemo(() => {
    if (exportSelectedGroupIds.length === 0) return project.points;
    const selected = new Set(exportSelectedGroupIds);
    return project.points.filter((point) => point.groupId && selected.has(point.groupId));
  }, [exportSelectedGroupIds, project.points]);

  const parseExportBase = () => {
    const baseX = exportUseBasePoint ? parseImportNumber(exportBaseX) : 0;
    const baseY = exportUseBasePoint ? parseImportNumber(exportBaseY) : 0;
    const tolerance = parseImportNumber(exportTolerance);
    if (exportUseBasePoint && (!Number.isFinite(baseX) || !Number.isFinite(baseY))) {
      throw new Error('Базовая точка экспорта должна быть числом по X и Y.');
    }
    if (!Number.isFinite(tolerance) || tolerance <= 0) throw new Error('Допуск поиска должен быть положительным числом.');
    return { baseX, baseY, tolerance };
  };

  const confirmNanoCadBlockImport = async () => {
    const baseX = importUseBasePoint ? parseImportNumber(importBaseX) : 0;
    const baseY = importUseBasePoint ? parseImportNumber(importBaseY) : 0;
    if (importUseBasePoint && (!Number.isFinite(baseX) || !Number.isFinite(baseY))) {
      setNanoCadStatus('Базовая точка должна быть числом по X и Y.');
      return;
    }
    try {
      if (nanoCadMode === 'model_studio') {
        const selectedObjectNames = selectedModelStudioObjectNamesForRequest();
        if (selectedObjectNames.length === 0) {
          setNanoCadStatus('Сначала выбери, какие объекты Model Studio импортировать.');
          return;
        }
        const selectedObjectParameters = Object.fromEntries(
          selectedObjectNames
            .map((name) => [name, modelStudioNumberParameterForObject(name)] as const)
            .filter(([, parameter]) => Boolean(parameter))
        );
        setNanoCadStatus('Импортирую выбранные объекты Model Studio из nanoCAD...');
        const points = await importNanoCadModelStudioObjects({
          objectName: selectedObjectNames.length === 1 ? selectedObjectNames[0] : null,
          selectedObjectNames,
          selectedObjectParameters,
          numberParameter: nanoCadModelNumberParameter || null,
          baseX,
          baseY,
          tolerance: 1
        });

        const { matches, newPoints } = splitModelStudioImportPoints(project.points, points, 1);
        if (matches.length > 0) {
          const shouldReplace = window.confirm(
            `Найдено совпадений с текущим проектом: ${matches.length}.\n\n` +
            `ОК — заменить совпавшие точки данными из Model Studio и добавить новые (${newPoints.length}).\n` +
            `Отмена — оставить совпавшие точки как есть и добавить только новые (${newPoints.length}).`
          );
          if (shouldReplace) {
            setPoints(replaceModelStudioMatchedPoints(project.points, matches, newPoints));
            setNanoCadStatus(`Импорт Model Studio: заменено ${matches.length}, добавлено новых ${newPoints.length}. Типов выбрано: ${selectedObjectNames.length}.`);
            setProjectStatus(`Импорт Model Studio: заменено ${matches.length} · новых ${newPoints.length}`);
          } else if (newPoints.length > 0) {
            appendImportedPoints(`nanoCAD:ModelStudio:new_objects`, newPoints);
            setNanoCadStatus(`Импорт Model Studio: совпавшие оставлены, добавлено новых ${newPoints.length}.`);
            setProjectStatus(`Импорт Model Studio: добавлено новых ${newPoints.length}`);
          } else {
            setNanoCadStatus('Импорт Model Studio: все объекты уже есть в проекте, новые точки не добавлены.');
          }
        } else {
          appendImportedPoints(`nanoCAD:ModelStudio:${selectedObjectNames.length === 1 ? selectedObjectNames[0] : 'selected_objects'}`, points);
          setNanoCadStatus(`Импортировано объектов Model Studio: ${points.length}. Типов выбрано: ${selectedObjectNames.length}.`);
          setProjectStatus(`Импорт Model Studio: ${selectedObjectNames.length} групп · ${points.length} точек`);
        }
        requestAnimationFrame(() => zoomExtents(canvasWidth, canvasHeight));
        return;
      }

      if (!nanoCadSelectedBlock) {
        setNanoCadStatus('Сначала выбери тип блока или образец в nanoCAD.');
        return;
      }
      setNanoCadStatus('Импортирую блоки из nanoCAD...');
      const points = await importNanoCadBlocks({
        blockName: nanoCadSelectedBlock,
        numberAttribute: nanoCadNumberAttribute || null,
        baseX,
        baseY,
        tolerance: 1
      });
      appendImportedPoints(`nanoCAD:${nanoCadSelectedBlock}`, points);
      requestAnimationFrame(() => zoomExtents(canvasWidth, canvasHeight));
      setNanoCadStatus(`Импортировано блоков: ${points.length}. Атрибут номера: ${nanoCadNumberAttribute || 'не задан'}.`);
      setProjectStatus(`Импорт из nanoCAD: ${nanoCadSelectedBlock} · ${points.length} точек`);
    } catch (e) {
      setNanoCadStatus(e instanceof Error ? e.message : 'Не удалось импортировать данные nanoCAD.');
    }
  };

  const confirmExport = async () => {
    if (exportTarget === 'json') {
      await downloadProjectJson();
      setExportPanelOpen(false);
      return;
    }
    try {
      const { baseX, baseY, tolerance } = parseExportBase();
      setExportStatus('Экспортирую номера в nanoCAD...');
      const payloadPoints = exportPoints.map((point) => ({
        id: point.id,
        x: point.x,
        y: point.y,
        number: point.number ?? null,
        sourceNumber: point.sourceNumber ?? null,
        groupId: point.groupId ?? null
      }));
      const modelStudioExportObjectNames = selectedModelStudioObjectNamesForRequest();
      if (exportNanoCadMode === 'model_studio' && modelStudioExportObjectNames.length === 0) {
        throw new Error('Сначала отсканируй Model Studio и выбери, какие типы объектов обновлять.');
      }
      const result = exportNanoCadMode === 'blocks'
        ? await exportNanoCadBlocks({
            blockName: nanoCadSelectedBlock,
            numberAttribute: nanoCadNumberAttribute,
            points: payloadPoints,
            baseX,
            baseY,
            tolerance,
            selectedGroupIds: exportSelectedGroupIds.length ? exportSelectedGroupIds : null
          })
        : await exportNanoCadModelStudioObjects({
            objectName: modelStudioExportObjectNames.length === 1 ? modelStudioExportObjectNames[0] : null,
            selectedObjectNames: modelStudioExportObjectNames,
            numberParameter: nanoCadModelNumberParameter,
            points: payloadPoints,
            baseX,
            baseY,
            tolerance,
            selectedGroupIds: exportSelectedGroupIds.length ? exportSelectedGroupIds : null
          });
      const message = `Экспорт nanoCAD: обновлено ${result.updated}, сопоставлено ${result.matched}/${result.scanned}, неиспользованных точек ${result.unusedPoints}.`;
      setExportStatus(message);
      setProjectStatus(message);
    } catch (e) {
      setExportStatus(e instanceof Error ? e.message : 'Не удалось экспортировать в nanoCAD.');
    }
  };

  const refreshLocalProjects = async () => {
    const items = await listLocalProjects();
    setLocalProjects(items);
  };

  const toggleProjectsPopover = async () => {
    const next = !projectsOpen;
    setProjectsOpen(next);
    if (next) {
      try {
        await refreshLocalProjects();
        setProjectStatus('');
      } catch (e) {
        setProjectStatus(e instanceof Error ? e.message : 'Не удалось получить список проектов. Проверь, что backend запущен и обновлён.');
      }
    }
  };

  const saveProjectToLocalFolder = async () => {
    try {
      let projectToSave = project;

      if (needsSaveNamePrompt(project)) {
        const cleanName = (project.project.name || baseNameFromFile(project.project.sourceFileName || 'project')).trim() || 'Новый проект';
        projectToSave = {
          ...project,
          project: {
            ...project.project,
            name: cleanName
          }
        };
      }

      const result = await saveLocalProject(projectToSave);
      setProjectLocalFileName(result.fileName, result.name);
      recordOperation('local_project_saved', { fileName: result.fileName, name: result.name });
      setProjectStatus(`Сохранено: ${result.fileName}`);
      await refreshLocalProjects();
    } catch (e) {
      setProjectStatus(e instanceof Error ? e.message : 'Не удалось сохранить проект');
    }
  };

  const openLocal = async (fileName: string) => {
    try {
      const loaded = await openLocalProject(fileName);
      openProjectFromFile(loaded, fileName);
      setProjectStatus(`Открыт проект: ${fileName}`);
    } catch (e) {
      setProjectStatus(e instanceof Error ? e.message : 'Не удалось открыть проект');
    }
  };

  const openProjectFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as PileProject;
      openProjectFromFile(parsed, file.name);
      setProjectStatus(`Открыт файл: ${file.name}`);
    } catch (error) {
      setProjectStatus(error instanceof Error ? error.message : 'Не удалось открыть файл проекта');
    } finally {
      e.currentTarget.value = '';
    }
  };

  const importCsvIntoCurrentProject = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      await onCsvImport(file);
      setProjectStatus(`Импорт добавлен в текущий проект: ${file.name}`);
    } finally {
      e.currentTarget.value = '';
    }
  };

  const currentProjectState = project.project.fileName
    ? `Файл: ${project.project.fileName}`
    : project.project.sourceFileName
      ? `Источник: ${project.project.sourceFileName}`
      : 'Новый проект, ещё не сохранён';
  const activeGroup = project.groups.find((group) => group.id === selectedGroupId) ?? project.groups[0] ?? null;
  const activeGroupPointIds = new Set(project.points.filter((point) => point.groupId === activeGroup?.id).map((point) => point.id));
  const validManualLinks = (activeGroup?.numbering.manualLinks ?? []).filter((link, index, list) => {
    if (!link.fromId || !link.toId || link.fromId === link.toId) return false;
    if (!activeGroupPointIds.has(link.fromId) || !activeGroupPointIds.has(link.toId)) return false;
    const key = manualLinkKey(link.fromId, link.toId);
    return list.findIndex((item) => manualLinkKey(item.fromId, item.toId) === key) === index;
  });
  const validManualLinkKeys = validManualLinks.map((link) => manualLinkKey(link.fromId, link.toId));
  const selectedManualLinkKeys = manualLinkClearMode
    ? manualLinkClearSelection.filter((key) => validManualLinkKeys.includes(key))
    : validManualLinkKeys;
  const manualLinksCount = validManualLinks.length;
  const selectedManualLinksCount = selectedManualLinkKeys.length;
  const showClearLinksPanel = () => {
    if (clearLinksPanelOpen) {
      setClearLinksPanelOpen(false);
      cancelManualLinkClearMode();
      return;
    }
    setClearLinksPanelOpen(true);
    startManualLinkClearMode();
    if (!numberingPreview.visible || numberingPreview.displayMode !== 'full') setNumberingPreviewMode('full');
  };
  const closeClearLinksPanel = () => {
    setClearLinksPanelOpen(false);
    cancelManualLinkClearMode();
  };
  const applyClearLinks = () => {
    clearSelectedNumberingManualLinks();
    setClearLinksPanelOpen(false);
  };

  const toggleNumberingAnimation = () => {
    if (numberingPreview.visible && numberingPreview.displayMode === 'animated') {
      setNumberingPreviewMode('paused');
      return;
    }
    setNumberingPreviewMode('animated');
  };

  const handleAssignCommand = () => {
    if (selectedPointIds.length > 0) {
      assignSelectionToGroup();
      return;
    }
    toggleAutoAssignSelection();
  };

  const copyTextFallback = (text: string) => {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(textarea);
    if (!copied) throw new Error('copy command failed');
  };

  const copyAboutEmail = async () => {
    try {
      if (navigator.clipboard?.writeText && window.isSecureContext) {
        await navigator.clipboard.writeText(ABOUT_EMAIL);
      } else {
        copyTextFallback(ABOUT_EMAIL);
      }
      setAboutEmailCopied(true);
      window.setTimeout(() => setAboutEmailCopied(false), 1800);
    } catch {
      setProjectStatus('Не удалось скопировать почту автоматически. Адрес можно выделить и скопировать вручную.');
    }
  };

  const toggleEmptyPointCheck = () => {
    const next = !project.viewSettings.highlightUnnumbered;
    updateViewSettings({ highlightUnnumbered: next });
    if (!next) return;
    cancelNumberingPreview();
    closeEditingPanel();
    setClearLinksPanelOpen(false);
    cancelManualLinkClearMode();
    const emptyIds = project.points.filter(isPointUnnumbered).map((point) => point.id);
    setSelection(emptyIds);
    setProjectStatus(emptyIds.length > 0 ? `Найдено точек без номера: ${emptyIds.length}` : 'Пустых/ненумерованных точек не найдено.');
  };

  return (
    <>
      <header className="ribbon-toolbar" style={toolbarStyle}>
        <div className="ribbon-tabs-row">
          <div className="ribbon-tabs">
            {(Object.keys(TAB_LABELS) as RibbonTab[]).map((tab) => (
              <button
                key={tab}
                className={`ribbon-tab-button ${activeTab === tab ? 'active' : ''}`}
                onClick={() => {
                  setActiveTab(tab);
                  if (ribbonMode !== 'tabs') setRibbonMode('tabs');
                }}
              >
                {TAB_LABELS[tab]}
              </button>
            ))}
          </div>
          <div className="ribbon-current-project" data-tooltip="Текущий проект
Название, файл и состояние текущего проекта.">
            <span>Текущий проект:</span>
            <strong>{project.project.name || 'Без имени'}</strong>
            <em>{currentProjectState}</em>
          </div>
          <div className="ribbon-tab-actions">
            <button className={`ribbon-mode-button ${aboutOpen ? 'active' : ''}`} data-tooltip="О проекте\nКраткая визитка программы и разработчика." onClick={() => setAboutOpen((value) => !value)}>О проекте</button>
            <button className={`ribbon-mode-button ${ribbonMode === 'tabs' ? 'active' : ''}`} onClick={() => setRibbonMode('tabs')}>По вкладкам</button>
            <button className={`ribbon-mode-button ${ribbonMode === 'all' ? 'active' : ''}`} onClick={() => setRibbonMode('all')}>Все секции</button>
            <select
              className="ribbon-density-select"
              value={ribbonDensity}
              title="Плотность кнопок ленты"
              onChange={(event) => setRibbonDensity(event.target.value as RibbonDensity)}
            >
              {(Object.keys(DENSITY_LABELS) as RibbonDensity[]).map((density) => (
                <option key={density} value={density}>{DENSITY_LABELS[density]}</option>
              ))}
            </select>
            <button className="ribbon-mode-button" onClick={showAllCurrentSections}>Развернуть</button>
            <button className="ribbon-mode-button" onClick={toggleCurrentSections}>{allCurrentCollapsed ? 'Развернуть вкладку' : 'Свернуть вкладку'}</button>
            <button className="ribbon-mode-button" onClick={resetRibbonLayout}>Сброс ленты</button>
          </div>
        </div>

        <div
          className="ribbon-scroll"
          ref={ribbonScrollRef}
          onScroll={(event) => { ribbonScrollLeftRef.current = event.currentTarget.scrollLeft; }}
          onMouseDownCapture={() => { if (ribbonScrollRef.current) ribbonScrollLeftRef.current = ribbonScrollRef.current.scrollLeft; }}
        >
          {allCurrentCollapsed && (
            <div className="ribbon-empty-tab">
              <strong>Секции вкладки свернуты</strong>
              <span>Нажми, чтобы вернуть команды на ленту.</span>
              <button className="btn small" onClick={showAllCurrentSections}>Развернуть вкладку</button>
            </div>
          )}
          <RibbonSection id="file" title="Файл" className="file-section">
            <div className="file-ribbon-layout">
              <div className="file-ribbon-group">
                <div className="file-ribbon-group-title">Проект</div>
                <div className="ribbon-commands">
                  <CommandButton icon="✚" label="Создать" active={createProjectOpen} tooltip={'Создать проект\nОткрывает окно создания нового пустого проекта.'} onClick={openCreateProjectDialog} />
                  <CommandButton icon="📂" label="Открыть" tooltip={'Открыть проект\nОткрывает готовый .pilenum.json или .json файл как текущий проект.'}>
                    <input type="file" accept=".json,.pilenum.json" hidden onChange={(e) => void openProjectFile(e)} />
                  </CommandButton>
                  <CommandButton icon="💽" label="Сохранить" tooltip={'Сохранить проект\nСохраняет текущий проект в локальную папку projects. Для нового проекта берёт имя из строки проекта.'} onClick={() => void saveProjectToLocalFolder()} />
                  <CommandButton icon="✎" label="Переим." active={renameProjectOpen} tooltip={'Переименовать проект\nМеняет имя текущего проекта. При следующем сохранении локальный файл получит новое имя.'} onClick={openRenameProjectDialog} />
                  <CommandButton icon="🗂" label="Проекты" active={projectsOpen} tooltip={'Папка проектов\nОткрывает список локальных проектов из папки projects. Выбранный проект подсвечивается.'} onClick={() => void toggleProjectsPopover()} />
                </div>
              </div>
              <div className="file-ribbon-group">
                <div className="file-ribbon-group-title">Данные</div>
                <div className="ribbon-commands">
                  <CommandButton icon="➕" label="Импорт" active={importPanelOpen} tooltip={'Импорт данных\nCSV/Excel с предпросмотром, импорт блоков nanoCAD и подготовка объектов Model Studio.'} onClick={openImportDialog} />
                  <CommandButton icon="📤" label="Экспорт" active={exportPanelOpen} tooltip={'Экспорт данных\nСохраняет JSON проекта или записывает номера обратно в nanoCAD.'} onClick={openExportDialog} />
                </div>
              </div>
            </div>
          </RibbonSection>

          <RibbonSection id="editing" title="Редактирование" className="editing-section">
            <div className="file-ribbon-layout single-ribbon-layout">
              <div className="file-ribbon-group ghost-ribbon-group">
                <div className="file-ribbon-group-title ghost-ribbon-group-title">Точки</div>
                <div className="ribbon-commands">
                  <CommandButton icon="＋" label="Точка" active={editingPanelVisible && editingTool === 'create'} tooltip={'Создать точку\nОткрывает окно создания точки по координатам X/Y.'} onClick={() => openEditingTool('create')} />
                  <CommandButton icon="⌫" label="Удалить" tooltip={'Удалить\nУдаляет выбранные точки с поля. Перед удалением выбери одну или несколько точек.'} onClick={deleteSelectedPoints} />
                  <CommandButton icon="↔" label="Переместить" active={editingPanelVisible && editingTool === 'move'} tooltip={'Переместить\nОткрывает окно перемещения выбранных точек вдоль оси X/Y на заданное расстояние.'} onClick={() => openEditingTool('move')} />
                  <CommandButton icon="⧉" label="Копировать" active={editingPanelVisible && editingTool === 'copy'} tooltip={'Копировать\nКопирует выбранные точки по заданному смещению или через базовую точку и точку вставки.'} onClick={() => openEditingTool('copy')} />
                  <CommandButton icon="🧾" label="Коп.св-ва" active={editingPanelVisible && editingTool === 'props'} tooltip={'Копировать свойства\nКопирует группу исходной точки на выбранные точки-приёмники.'} onClick={() => openEditingTool('props')} />
                  <CommandButton icon="ℹ" label="Инфо" active={pointInfoVisible} tooltip={'Информация о точке\nВключает режим выбора одной точки. Клик в поле выбирает ближайшую точку, группы в этом режиме не назначаются.'} onClick={togglePointInfo} />
                </div>
              </div>
            </div>
          </RibbonSection>

          <RibbonSection id="groups" title="Группы">
            <div className="file-ribbon-layout single-ribbon-layout">
              <div className="file-ribbon-group ghost-ribbon-group">
                <div className="file-ribbon-group-title ghost-ribbon-group-title">Диспетчер</div>
                <div className="ribbon-commands">
                  <CommandButton icon="▤" label="Группы" active={groupManagerVisible} tooltip={'Диспетчер групп\nПоказывает или скрывает окно групп. Его можно перемещать, менять размер и закреплять по краям.'} onClick={toggleGroupManager} />
                  <CommandButton
                    icon={autoAssignSelection ? '☑' : '☐'}
                    label="Назначить"
                    active={autoAssignSelection}
                    tooltip={selectedPointIds.length > 0
                      ? 'Назначить выделение\nНазначает выбранные точки в активную группу один раз. Режим автоназначения не переключается.'
                      : `Автоназначение рамкой\n${autoAssignSelection ? 'Включено: выделение рамкой отправляет точки в активную группу.' : 'Выключено: нажми, чтобы включить назначение рамкой.'}`}
                    onClick={handleAssignCommand}
                  />
                </div>
              </div>
            </div>
          </RibbonSection>

          <RibbonSection id="numbering" title="Нумерация" className="numbering-section">
            <div className="ribbon-commands ribbon-commands-numbering">
              <div className="ribbon-command-subgroup ribbon-command-subgroup-links">
                <div className="ribbon-subtitle">Связи / просмотр</div>
                <div className="ribbon-subcommands">
                  <CommandButton icon="⛓" label="Весь путь" active={numberingPreview.visible && numberingPreview.displayMode === 'full'} tooltip={'Весь путь\nПоказывает всю траекторию сразу. По стрелке можно кликнуть, затем выбрать новую точку-приёмник для ручной связи.'} onClick={() => setNumberingPreviewMode('full')} />
                  <CommandButton icon={numberingPreview.visible && numberingPreview.displayMode === 'animated' ? '⏸' : '▶'} label={numberingPreview.visible && numberingPreview.displayMode === 'animated' ? 'Пауза' : 'Мультик'} active={numberingPreview.visible && (numberingPreview.displayMode === 'animated' || numberingPreview.displayMode === 'paused')} tooltip={'Мультик / пауза\nПервое нажатие запускает анимацию порядка. Повторное нажатие ставит паузу или продолжает анимацию.'} onClick={toggleNumberingAnimation} />
                  <div className="clear-links-anchor">
                    <CommandButton icon="🧹" label="Очистить" active={clearLinksPanelOpen} tooltip={'Очистить ручные связи\nОткроет панель выбора: красным подсветятся связи, которые будут удалены.'} onClick={showClearLinksPanel} />
                    {clearLinksPanelOpen && (
                      <div className="clear-links-popover">
                        <strong>Ручные связи</strong>
                        <span>{activeGroup ? `Группа: ${activeGroup.name}` : 'Активная группа не выбрана'}</span>
                        <small>{manualLinksCount > 0 ? `Выбрано к удалению: ${selectedManualLinksCount} из ${manualLinksCount}. На поле красным подсвечены связи, которые удалятся.` : 'В активной группе нет ручных связей.'}</small>
                        {manualLinksCount > 0 && (
                          <div className="clear-links-list">
                            <div className="clear-links-list-actions">
                              <button className="btn small" onClick={() => setManualLinkClearSelection(validManualLinkKeys)}>Все</button>
                              <button className="btn small" onClick={() => setManualLinkClearSelection([])}>Ни одной</button>
                            </div>
                            {validManualLinks.map((link, index) => {
                              const key = manualLinkKey(link.fromId, link.toId);
                              const checked = selectedManualLinkKeys.includes(key);
                              return (
                                <label key={key} className={`clear-link-row ${checked ? 'selected' : ''}`}>
                                  <input type="checkbox" checked={checked} onChange={() => toggleManualLinkClearSelection(key)} />
                                  <span>Связь {index + 1}</span>
                                  <code>{link.fromId.slice(-4)} → {link.toId.slice(-4)}</code>
                                </label>
                              );
                            })}
                          </div>
                        )}
                        <div className="clear-links-actions">
                          <button className="btn danger" disabled={selectedManualLinksCount === 0} onClick={applyClearLinks}>Удалить выбранные</button>
                          <button className="btn" onClick={closeClearLinksPanel}>Отмена</button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <div className="ribbon-command-subgroup ribbon-command-subgroup-apply">
                <div className="ribbon-subtitle">Применить</div>
                <div className="ribbon-subcommands">
                  <CommandButton icon="№" label="Группа" tooltip={'Нумеровать группу\nПрименяет выбранный метод нумерации только к активной группе.'} onClick={() => void applyRowsNumbering()} />
                  <CommandButton icon="№№" label="Все" tooltip={'Нумеровать всё\nНумерует все группы по порядку диспетчера.'} onClick={() => void applyRowsNumberingAll()} />
                </div>
              </div>
            </div>
          </RibbonSection>

          <RibbonSection id="workspace" title="Рабочее поле" className="workspace-section">
            <div className="file-ribbon-layout single-ribbon-layout">
              <div className="file-ribbon-group ghost-ribbon-group">
                <div className="file-ribbon-group-title ghost-ribbon-group-title">Поле</div>
                <div className="ribbon-commands">
                  <CommandButton icon="⛶" label="Всё поле" tooltip={'Zoom Extents\nЦентрирует и масштабирует поле так, чтобы увидеть все точки.'} onClick={() => zoomExtents(canvasWidth, canvasHeight)} />
                  <CommandButton icon="#" label="Сетка" active={project.gridSettings.enabled} tooltip={'Сетка\nВключает или выключает вспомогательную сетку. Главные оси X/Y остаются отдельно.'} onClick={toggleGrid} />
                  <CommandButton icon="12" label="Номера" active={project.viewSettings.showPointNumbers} tooltip={'Показать номера точек\nВключает или скрывает текст нумерации на поле.'} onClick={() => updateViewSettings({ showPointNumbers: !project.viewSettings.showPointNumbers })} />
                  <CommandButton icon="○!" label="Пустые" active={project.viewSettings.highlightUnnumbered} tooltip={'Проверить пустые\nВыделяет все точки без номера, затемняет остальные точки и выключает временные режимы предпросмотра/редактирования.'} onClick={toggleEmptyPointCheck} />
                  <CommandButton icon="✓" label="Проверка" active={modelCheckOpen} tooltip={'Проверка модели\nПоказывает сводку по точкам, группам, ненумерованным точкам, дублям и ручным связям.'} onClick={() => setModelCheckOpen((value) => !value)} />
                  <CommandButton icon="⚙" label="Настройки" active={workspaceOpen} tooltip={'Настройки рабочего поля\nОткрывает отдельное перемещаемое окно настроек.'} onClick={() => setWorkspaceOpen((value) => !value)} />
                </div>
              </div>
            </div>
          </RibbonSection>

          <RibbonSection id="history" title="История">
            <div className="file-ribbon-layout single-ribbon-layout">
              <div className="file-ribbon-group ghost-ribbon-group">
                <div className="file-ribbon-group-title ghost-ribbon-group-title">Операции</div>
                <div className="ribbon-commands">
                  <CommandButton icon="↶" label="Отмена" tooltip={'Отмена\nВозвращает предыдущее состояние.'} onClick={undo} />
                  <CommandButton icon="↷" label="Повтор" tooltip={'Повтор\nВозвращает отменённое действие.'} onClick={redo} />
                  <CommandButton icon="🧾" label="Журнал" active={journalVisible} tooltip={'Журнал изменений\nПоказывает список основных операций: импорт, группы, назначение точек, нумерацию.'} onClick={toggleJournal} />
                </div>
              </div>
            </div>
          </RibbonSection>
        </div>
        <div
          className="toolbar-resize-handle"
          data-tooltip="Потяни вниз, чтобы увеличить панель кнопок. Кнопки и иконки увеличиваются пропорционально."
          onMouseDown={(event) => {
            resizeRef.current = { startY: event.clientY, startHeight: toolbarHeight };
            event.preventDefault();
          }}
        />
      </header>
      {createProjectOpen && (
        <DraggablePanel
          id="create-project-dialog"
          title="Создать проект"
          initialX={24}
          initialY={toolbarHeight + 14}
          width={420}
          height={250}
          minWidth={360}
          minHeight={220}
          dockable
          dockOffsetTop={toolbarHeight}
          dockOffsetBottom={28}
          onClose={() => setCreateProjectOpen(false)}
        >
          <div className="project-dialog-panel">
            <div className="panel-hint">Новый проект создаётся пустым. Текущий проект останется в истории отмены, но лучше сохрани его перед созданием нового.</div>
            <label className="form-row">
              <span>Имя проекта</span>
              <input value={createProjectName} onChange={(event) => setCreateProjectName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') createProjectFromDialog(); }} autoFocus />
            </label>
            <div className="dialog-actions-row">
              <button className="btn primary" onClick={createProjectFromDialog}>Создать проект</button>
              <button className="btn" onClick={() => setCreateProjectOpen(false)}>Отмена</button>
            </div>
          </div>
        </DraggablePanel>
      )}
      {renameProjectOpen && (
        <DraggablePanel
          id="rename-project-dialog"
          title="Переименовать проект"
          initialX={36}
          initialY={toolbarHeight + 18}
          width={440}
          height={240}
          minWidth={360}
          minHeight={210}
          dockable
          dockOffsetTop={toolbarHeight}
          dockOffsetBottom={28}
          onClose={() => setRenameProjectOpen(false)}
        >
          <div className="project-dialog-panel">
            <div className="panel-hint">Меняется имя текущего проекта. Локальный файл будет записан под новым именем при следующем сохранении.</div>
            <label className="form-row">
              <span>Новое имя проекта</span>
              <input value={renameProjectName} onChange={(event) => setRenameProjectName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') renameProjectFromDialog(); }} autoFocus />
            </label>
            <div className="dialog-actions-row">
              <button className="btn primary" onClick={renameProjectFromDialog}>Переименовать</button>
              <button className="btn" onClick={() => setRenameProjectOpen(false)}>Отмена</button>
            </div>
          </div>
        </DraggablePanel>
      )}

      {importPanelOpen && (
        <DraggablePanel
          id="import-data-dialog"
          title="Импорт данных"
          initialX={38}
          initialY={toolbarHeight + 18}
          width={720}
          height={610}
          minWidth={560}
          minHeight={420}
          dockable
          dockOffsetTop={toolbarHeight}
          dockOffsetBottom={28}
          onClose={() => setImportPanelOpen(false)}
        >
          <div className="transfer-dialog-panel import-wizard-panel">
            <div className="wizard-step">
              <div className="wizard-step-title"><b>1</b><span>Источник</span></div>
              <div className="transfer-mode-grid">
                <button className={`transfer-mode-card ${importSource === 'file' ? 'active' : ''}`} onClick={() => setImportSource('file')}>
                  <strong>CSV / Excel</strong>
                  <span>Файл с координатами. После выбора проверяем таблицу и колонки.</span>
                </button>
                <button className={`transfer-mode-card ${importSource === 'nanocad' ? 'active' : ''}`} onClick={() => setImportSource('nanocad')}>
                  <strong>nanoCAD</strong>
                  <span>Чтение блоков или объектов Model Studio через COM.</span>
                </button>
              </div>
            </div>

            {importSource === 'file' ? (
              <>
                <div className="wizard-step">
                  <div className="wizard-step-title"><b>2</b><span>Файл и колонки</span></div>
                  <input ref={importFileInputRef} type="file" accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" hidden onChange={(event) => void selectImportFile(event)} />
                  <div className="dialog-actions-row left">
                    <button className="btn primary" onClick={() => importFileInputRef.current?.click()}>Выбрать CSV / Excel</button>
                    {importPreview && <span className="transfer-file-name">{importPreview.fileName}</span>}
                  </div>
                  {importPreview ? (
                    <>
                      <div className="column-map-grid">
                        <label><span>Координата X</span><select value={importXColumn} onChange={(event) => setImportXColumn(event.target.value)}>{importPreview.columns.map((column, index) => <option key={index} value={index}>{column}</option>)}</select></label>
                        <label><span>Координата Y</span><select value={importYColumn} onChange={(event) => setImportYColumn(event.target.value)}>{importPreview.columns.map((column, index) => <option key={index} value={index}>{column}</option>)}</select></label>
                        <label><span>Исходный номер</span><select value={importNumberColumn} onChange={(event) => setImportNumberColumn(event.target.value)}><option value="">Не импортировать</option>{importPreview.columns.map((column, index) => <option key={index} value={index}>{column}</option>)}</select></label>
                      </div>
                      <div className="csv-preview-wrap"><table className="csv-preview-table"><thead><tr>{importPreview.columns.map((column, index) => <th key={index}>{column}</th>)}</tr></thead><tbody>{importPreview.previewRows.map((row, rowIndex) => (<tr key={rowIndex}>{importPreview.columns.map((_column, colIndex) => <td key={colIndex}>{row[colIndex] ?? ''}</td>)}</tr>))}</tbody></table></div>
                    </>
                  ) : <div className="empty-message">Выбери CSV, XLSX или XLS. После выбора появится предпросмотр и выбор колонок.</div>}
                </div>
                <div className="wizard-step">
                  <div className="wizard-step-title"><b>3</b><span>Базовая точка</span></div>
                  <div className="base-point-card flat">
                    <label className="cad-checkbox-line"><input type="checkbox" checked={importUseBasePoint} onChange={(event) => setImportUseBasePoint(event.target.checked)} /><span>Применить базовую точку / смещение при импорте</span></label>
                    <div className="base-point-grid"><label><span>База X</span><input value={importBaseX} onChange={(event) => setImportBaseX(event.target.value)} disabled={!importUseBasePoint} /></label><label><span>База Y</span><input value={importBaseY} onChange={(event) => setImportBaseY(event.target.value)} disabled={!importUseBasePoint} /></label></div>
                    <small>Для файлов итоговая координата = координата из файла + базовая точка. Значение сохраняется в meta точек.</small>
                  </div>
                </div>
                {importStatus && <div className="project-status">{importStatus}</div>}
                <div className="dialog-actions-row"><button className="btn primary" disabled={!importPreview} onClick={() => void confirmImportFromFile()}>Подтвердить импорт</button><button className="btn" onClick={() => setImportPanelOpen(false)}>Закрыть</button></div>
              </>
            ) : (
              <div className="nanocad-import-panel">
                <div className="wizard-step">
                  <div className="wizard-step-title"><b>2</b><span>Тип объектов nanoCAD</span></div>
                  <div className="transfer-mode-grid compact">
                    <button className={`transfer-mode-card ${nanoCadMode === 'blocks' ? 'active' : ''}`} onClick={() => setNanoCadMode('blocks')}><strong>Блоки</strong><span>AcDbBlockReference: InsertionPoint + атрибуты блока.</span></button>
                    <button className={`transfer-mode-card ${nanoCadMode === 'model_studio' ? 'active' : ''}`} onClick={() => setNanoCadMode('model_studio')}><strong>Model Studio</strong><span>Объект определяется по Object.Element, номер берётся из параметра.</span></button>
                  </div>
                </div>
                <div className="wizard-step">
                  <div className="wizard-step-title"><b>3</b><span>{nanoCadMode === 'blocks' ? 'Поиск блоков' : 'Поиск объектов Model Studio'}</span></div>
                  {nanoCadMode === 'blocks' ? (
                    <div className="dialog-actions-row left">
                      <button className={`btn ${nanoCadBlockMode === 'scan' ? 'primary' : ''}`} data-tooltip="Сканирует ModelSpace и группирует все AcDbBlockReference по EffectiveName/Name." onClick={() => { setNanoCadBlockMode('scan'); void refreshNanoCadBlocks(); }}>Сканировать все блоки</button>
                      <button className={`btn ${nanoCadBlockMode === 'pick' ? 'primary' : ''}`} data-tooltip="В nanoCAD выбери один блок-образец. Приложение найдёт все блоки с таким EffectiveName." onClick={() => { setNanoCadBlockMode('pick'); void pickNanoCadSample(); }}>Выбрать образец в nanoCAD</button>
                    </div>
                  ) : (
                    <div className="dialog-actions-row left"><button className="btn primary" onClick={() => void refreshNanoCadModelStudioObjects()}>Сканировать Model Studio</button></div>
                  )}
                </div>
                <div className="wizard-step">
                  <div className="wizard-step-title"><b>4</b><span>Параметры чтения</span></div>
                  {nanoCadMode === 'blocks' ? (nanoCadBlocks.length > 0 ? (
                    <div className="nanocad-block-grid">
                      <label><span>Тип блока</span><select value={nanoCadSelectedBlock} onChange={(event) => { const blockName = event.target.value; setNanoCadSelectedBlock(blockName); const block = nanoCadBlocks.find((item) => item.name === blockName); setNanoCadNumberAttribute(block?.numberAttributeCandidates[0] || block?.attributes[0]?.tag || ''); }}>{nanoCadBlocks.map((block) => <option key={block.name} value={block.name}>{block.name} · {block.count}</option>)}</select></label>
                      <label><span>Атрибут номера сваи</span><select value={nanoCadNumberAttribute} onChange={(event) => setNanoCadNumberAttribute(event.target.value)}><option value="">Не брать номер</option>{(nanoCadBlocks.find((block) => block.name === nanoCadSelectedBlock)?.attributes ?? []).map((attribute) => (<option key={attribute.tag} value={attribute.tag}>{attribute.tag}{(nanoCadBlocks.find((block) => block.name === nanoCadSelectedBlock)?.numberAttributeCandidates ?? []).includes(attribute.tag) ? ' · похоже на номер' : ''}</option>))}</select></label>
                    </div>
                  ) : <div className="empty-message">Сначала отсканируй блоки или выбери образец. Для номера приложение подсветит похожие атрибуты.</div>) : (nanoCadModelObjects.length > 0 ? (
                    <div className="modelstudio-selection-panel">
                      <div className="modelstudio-display-row">
                        <label><span>Отображение списка</span><select value={nanoCadModelNameMode} onChange={(event) => setNanoCadModelNameMode(event.target.value as 'display' | 'technical')}><option value="display">Имя</option><option value="technical">Тип элемента API</option></select></label>
                        <div className="dialog-actions-row left"><button className="btn small" onClick={() => setNanoCadSelectedModelObjectNames(modelStudioObjectsForList.map((obj) => obj.name))}>Выбрать всё</button><button className="btn small" onClick={() => setNanoCadSelectedModelObjectNames([])}>Снять выбор</button><small>Выбрано групп: {selectedModelStudioObjectNamesForRequest().length}</small></div>
                      </div>
                      <div className="modelstudio-object-list grouped">
                        {modelStudioObjectsForList.map((obj) => (<div key={obj.name} className="modelstudio-object-group"><label className="modelstudio-object-item"><input type="checkbox" checked={nanoCadSelectedModelObjectNames.includes(obj.name)} onChange={(event) => toggleModelStudioObjectSelection(obj.name, event.target.checked)} /><span className="modelstudio-object-text"><strong>{modelStudioObjectLabel(obj)}</strong><small>{modelStudioObjectMeta(obj)}</small></span></label><label className="modelstudio-param-row"><span>Параметр чтения номера</span><select value={modelStudioNumberParameterForObject(obj.name)} onChange={(event) => setModelStudioNumberParameterForObject(obj.name, event.target.value)}><option value="">Не брать номер</option>{obj.parameters.map((parameter) => (<option key={parameter.name} value={parameter.name}>{parameter.name}{obj.numberParameterCandidates.includes(parameter.name) ? ' · похоже на номер' : ''}</option>))}</select></label></div>))}
                      </div>
                    </div>
                  ) : <div className="empty-message">Сканирование Model Studio использует Object.Element. Проверишь на рабочей модели, потому что COM-структура может отличаться.</div>)}
                </div>
                <div className="wizard-step">
                  <div className="wizard-step-title"><b>5</b><span>Базовая точка и импорт</span></div>
                  <div className="base-point-card flat"><label className="cad-checkbox-line"><input type="checkbox" checked={importUseBasePoint} onChange={(event) => setImportUseBasePoint(event.target.checked)} /><span>Импортировать относительно базовой точки</span></label><div className="base-point-grid"><label><span>База X</span><input value={importBaseX} onChange={(event) => setImportBaseX(event.target.value)} disabled={!importUseBasePoint} /></label><label><span>База Y</span><input value={importBaseY} onChange={(event) => setImportBaseY(event.target.value)} disabled={!importUseBasePoint} /></label></div><small>Для nanoCAD координата проекта = InsertionPoint − базовая точка. При экспорте обратно используется InsertionPoint = точка проекта + база с допуском 1 мм.</small></div>
                </div>
                {nanoCadStatus && <div className="project-status">{nanoCadStatus}</div>}
                <div className="dialog-actions-row"><button className="btn primary" disabled={nanoCadMode === 'blocks' ? !nanoCadSelectedBlock : false} onClick={() => void confirmNanoCadBlockImport()}>{nanoCadMode === 'blocks' ? 'Импортировать блоки' : 'Импортировать Model Studio'}</button><button className="btn" onClick={() => setImportPanelOpen(false)}>Закрыть</button></div>
              </div>
            )}
          </div>
        </DraggablePanel>
      )}
      {exportPanelOpen && (
        <DraggablePanel
          id="export-data-dialog"
          title="Экспорт данных"
          initialX={54}
          initialY={toolbarHeight + 22}
          width={660}
          height={560}
          minWidth={520}
          minHeight={380}
          dockable
          dockOffsetTop={toolbarHeight}
          dockOffsetBottom={28}
          onClose={() => setExportPanelOpen(false)}
        >
          <div className="transfer-dialog-panel import-wizard-panel">
            <div className="wizard-step">
              <div className="wizard-step-title"><b>1</b><span>Куда экспортируем</span></div>
              <div className="transfer-mode-grid">
                <button className={`transfer-mode-card ${exportTarget === 'json' ? 'active' : ''}`} onClick={() => setExportTarget('json')}><strong>JSON проекта</strong><span>Скачать .pilenum.json для переноса или архива.</span></button>
                <button className={`transfer-mode-card ${exportTarget === 'nanocad' ? 'active' : ''}`} onClick={() => setExportTarget('nanocad')}><strong>nanoCAD</strong><span>Записать номера обратно в блоки или объекты Model Studio.</span></button>
              </div>
            </div>
            {exportTarget === 'json' ? (
              <div className="current-project-card"><strong>{project.project.name || 'Без имени'}</strong><span>{project.points.length} точек · {project.groups.length} групп</span><small>Экспортируется проектный JSON. В EXE и современных браузерах будет предложено выбрать папку/файл сохранения.</small></div>
            ) : (
              <>
                <div className="wizard-step">
                  <div className="wizard-step-title"><b>2</b><span>Тип объектов nanoCAD</span></div>
                  <div className="transfer-mode-grid compact"><button className={`transfer-mode-card ${exportNanoCadMode === 'blocks' ? 'active' : ''}`} onClick={() => setExportNanoCadMode('blocks')}><strong>Блоки</strong><span>Поиск по InsertionPoint и запись в атрибут блока.</span></button><button className={`transfer-mode-card ${exportNanoCadMode === 'model_studio' ? 'active' : ''}`} onClick={() => setExportNanoCadMode('model_studio')}><strong>Model Studio</strong><span>Поиск по точке объекта и запись в параметр Element.Parameters.</span></button></div>
                </div>
                <div className="wizard-step">
                  <div className="wizard-step-title"><b>3</b><span>Что экспортировать</span></div>
                  <div className="export-group-list">
                    <button className="btn small" onClick={() => setExportSelectedGroupIds(project.groups.map((group) => group.id))}>Все группы</button>
                    <button className="btn small" onClick={() => setExportSelectedGroupIds([])}>Все точки проекта</button>
                    {project.groups.map((group: PileGroup) => (
                      <label key={group.id} className="export-group-item"><input type="checkbox" checked={exportSelectedGroupIds.includes(group.id)} onChange={(event) => setExportSelectedGroupIds((items) => event.target.checked ? Array.from(new Set([...items, group.id])) : items.filter((id) => id !== group.id))} /><span className="group-color-dot" style={{ backgroundColor: group.color }} /><span>{group.name}</span><small>{project.points.filter((point: PilePoint) => point.groupId === group.id).length}</small></label>
                    ))}
                  </div>
                  <small>Выбрано групп: {selectedExportGroups.length}. Точек к экспорту: {exportPoints.length}. Сопоставление идёт по координатам с допуском.</small>
                </div>
                <div className="wizard-step">
                  <div className="wizard-step-title"><b>4</b><span>Скан nanoCAD для экспорта</span></div>
                  {exportNanoCadMode === 'blocks' ? (
                    <div className="nanocad-scan-actions">
                      <button className="btn primary" data-tooltip="Сканирует ModelSpace и обновляет список типов блоков для импорта и экспорта." onClick={() => void refreshNanoCadBlocks('export')}>Сканировать блоки</button>
                      <button className="btn" data-tooltip="Выбери один блок-образец в nanoCAD. Затем приложение найдёт все блоки с таким EffectiveName." onClick={() => void pickNanoCadSample('export')}>Выбрать образец</button>
                      <small>Скан нужен и для импорта, и для экспорта: из него берутся тип блока и список атрибутов.</small>
                    </div>
                  ) : (
                    <div className="nanocad-scan-actions">
                      <button className="btn primary" data-tooltip="Сканирует объекты, у которых доступен Object.Element, и обновляет список параметров Model Studio." onClick={() => void refreshNanoCadModelStudioObjects('export')}>Сканировать Model Studio</button>
                      <small>Best-effort режим: проверишь на рабочем nanoCAD, потому что COM-структура Model Studio может отличаться.</small>
                    </div>
                  )}
                </div>
                <div className="wizard-step">
                  <div className="wizard-step-title"><b>5</b><span>Настройки сопоставления</span></div>
                  {exportNanoCadMode === 'blocks' ? (
                    <div className="nanocad-block-grid"><label><span>Тип блока</span><select value={nanoCadSelectedBlock} onChange={(event) => setNanoCadSelectedBlock(event.target.value)}>{nanoCadBlocks.map((block) => <option key={block.name} value={block.name}>{block.name} · {block.count}</option>)}{!nanoCadBlocks.some((block) => block.name === nanoCadSelectedBlock) && nanoCadSelectedBlock && <option value={nanoCadSelectedBlock}>{nanoCadSelectedBlock}</option>}</select></label><label><span>Атрибут номера</span><input value={nanoCadNumberAttribute} onChange={(event) => setNanoCadNumberAttribute(event.target.value)} placeholder="НОМЕР_СВАИ" /></label></div>
                  ) : (
                    <div className="modelstudio-selection-panel compact">
                      <div className="modelstudio-display-row"><label><span>Отображение списка</span><select value={nanoCadModelNameMode} onChange={(event) => setNanoCadModelNameMode(event.target.value as 'display' | 'technical')}><option value="display">Имя</option><option value="technical">Тип элемента API</option></select></label><div className="dialog-actions-row left"><button className="btn small" onClick={() => setNanoCadSelectedModelObjectNames(modelStudioObjectsForList.map((obj) => obj.name))}>Выбрать всё</button><button className="btn small" onClick={() => setNanoCadSelectedModelObjectNames([])}>Снять выбор</button><small>Выбрано групп: {selectedModelStudioObjectNamesForRequest().length}</small></div></div>
                      <div className="modelstudio-object-list compact grouped">{modelStudioObjectsForList.map((obj) => (<label key={obj.name} className="modelstudio-object-item"><input type="checkbox" checked={nanoCadSelectedModelObjectNames.includes(obj.name)} onChange={(event) => toggleModelStudioObjectSelection(obj.name, event.target.checked)} /><span className="modelstudio-object-text"><strong>{modelStudioObjectLabel(obj)}</strong><small>{modelStudioObjectMeta(obj)}</small></span></label>))}</div>
                      <label className="modelstudio-export-param"><span>Параметр записи для всех выбранных объектов</span><input value={nanoCadModelNumberParameter} onChange={(event) => setNanoCadModelNumberParameter(event.target.value)} placeholder="GPP_PILE_NUMBER" /></label>
                    </div>
                  )}
                  <div className="base-point-card flat"><label className="cad-checkbox-line"><input type="checkbox" checked={exportUseBasePoint} onChange={(event) => setExportUseBasePoint(event.target.checked)} /><span>Использовать базовую точку для обратного поиска</span></label><div className="base-point-grid"><label><span>База X</span><input value={exportBaseX} onChange={(event) => setExportBaseX(event.target.value)} disabled={!exportUseBasePoint} /></label><label><span>База Y</span><input value={exportBaseY} onChange={(event) => setExportBaseY(event.target.value)} disabled={!exportUseBasePoint} /></label><label><span>Допуск, мм</span><input value={exportTolerance} onChange={(event) => setExportTolerance(event.target.value)} /></label></div><small>Для поиска в nanoCAD используется точка проекта + базовая точка. По умолчанию допуск 1 мм.</small></div>
                </div>
              </>
            )}
            {exportStatus && <div className="project-status">{exportStatus}</div>}
            <div className="dialog-actions-row"><button className="btn primary" onClick={() => void confirmExport()}>{exportTarget === 'json' ? 'Сохранить JSON...' : 'Экспортировать в nanoCAD'}</button><button className="btn" onClick={() => setExportPanelOpen(false)}>Закрыть</button></div>
          </div>
        </DraggablePanel>
      )}

      {modelCheckOpen && (
        <DraggablePanel
          id="model-check-dialog"
          title="Проверка модели"
          initialX={72}
          initialY={toolbarHeight + 26}
          width={680}
          height={560}
          minWidth={520}
          minHeight={360}
          dockable
          dockOffsetTop={toolbarHeight}
          dockOffsetBottom={28}
          onClose={() => setModelCheckOpen(false)}
        >
          <div className="model-check-panel">
            <div className="model-check-summary">
              <div><strong>{modelCheck.totalPoints}</strong><span>точек</span></div>
              <div><strong>{modelCheck.totalGroups}</strong><span>групп</span></div>
              <div className={modelCheck.unnumberedPoints ? 'warn' : ''}><strong>{modelCheck.unnumberedPoints}</strong><span>без номера</span></div>
              <div className={modelCheck.pointsWithoutGroup ? 'warn' : ''}><strong>{modelCheck.pointsWithoutGroup}</strong><span>без группы</span></div>
              <div className={modelCheck.duplicateNumbersGlobal ? 'bad' : ''}><strong>{modelCheck.duplicateNumbersGlobal}</strong><span>дублей №</span></div>
              <div className={modelCheck.invalidManualLinks ? 'bad' : ''}><strong>{modelCheck.invalidManualLinks}</strong><span>ошибок связей</span></div>
            </div>
            <div className="dialog-actions-row left">
              <button className="btn primary" onClick={toggleEmptyPointCheck}>Подсветить точки без номера</button>
              <button className="btn" onClick={() => setModelCheckOpen(false)}>Закрыть</button>
            </div>
            <div className="model-issue-list">
              {modelCheck.issues.map((issue, index) => (
                <div key={`${issue.title}-${index}`} className={`model-issue-card ${issue.level}`}>
                  <div className="model-issue-title">
                    <strong>{issue.level === 'error' ? 'Ошибка' : issue.level === 'warning' ? 'Внимание' : 'Инфо'}</strong>
                    <span>{issue.title}</span>
                  </div>
                  <ul>
                    {issue.details.map((detail, detailIndex) => <li key={detailIndex}>{detail}</li>)}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </DraggablePanel>
      )}
      {aboutOpen && (
        <DraggablePanel
          id="about-project-dialog"
          title="О проекте"
          initialX={Math.max(24, canvasWidth - 620)}
          initialY={toolbarHeight + 20}
          width={560}
          height={430}
          minWidth={380}
          minHeight={300}
          dockable
          dockOffsetTop={toolbarHeight}
          dockOffsetBottom={28}
          onClose={() => setAboutOpen(false)}
        >
          <div className="about-project-panel">
            <div className="about-project-card">
              <div className="about-project-header">
                <div>
                  <h3>Нумератор свайного поля</h3>
                  <p>Локальное CAD-приложение для импорта свайного поля, группировки свай, нумерации, проверки модели и обмена данными с nanoCAD.</p>
                </div>
                <span className="about-version-badge">Версия {APP_VERSION}</span>
              </div>
              <h4>Разработчик</h4>
              <dl>
                <dt>ФИО</dt>
                <dd>Сергеев Владислав Викторович</dd>
                <dt>Должность</dt>
                <dd>ведущий инженер Архитектурно-инженерного отдела Санкт-Петербургского филиала</dd>
                <dt>Рабочая почта</dt>
                <dd className="about-email-row">
                  <span className="about-copy-text">{ABOUT_EMAIL}</span>
                  <button
                    type="button"
                    className={`btn small about-copy-button ${aboutEmailCopied ? 'success' : ''}`}
                    onClick={() => void copyAboutEmail()}
                    aria-label="Скопировать рабочую почту разработчика"
                    title="Скопировать рабочую почту"
                  >
                    {aboutEmailCopied ? 'Скопировано' : 'Копировать'}
                  </button>
                </dd>
              </dl>
            </div>
          </div>
        </DraggablePanel>
      )}

      {projectsOpen && (
        <DraggablePanel
          id="projects-browser"
          title="Проекты"
          initialX={24}
          initialY={toolbarHeight + 14}
          width={420}
          height={430}
          minWidth={340}
          minHeight={260}
          dockable
          dockOffsetTop={toolbarHeight}
          dockOffsetBottom={28}
          onClose={() => setProjectsOpen(false)}
          actions={<button className="btn small" onClick={() => void refreshLocalProjects()}>Обновить</button>}
        >
          <div className="projects-panel">
            <div className="panel-hint">Локальная папка <b>projects</b>. Клик по проекту открывает его, окно остаётся открытым, текущий проект подсвечивается.</div>
            <div className="current-project-card">
              <strong>Текущий проект</strong>
              <span>{project.project.name}</span>
              <small>{project.project.fileName ?? 'ещё не сохранён в projects'} · {project.points.length} точек · {project.groups.length} групп</small>
            </div>
            <button className="btn full-width" onClick={() => void saveProjectToLocalFolder()}>Сохранить текущий проект в папку projects</button>
            {projectStatus && <div className="project-status">{projectStatus}</div>}
            <div className="local-project-list">
              {localProjects.length === 0 ? (
                <div className="empty-message">Папка projects пуста или список ещё не обновлён. Нажми “Сохранить текущий проект”.</div>
              ) : localProjects.map((item) => (
                <button
                  key={item.fileName}
                  className={`local-project-item ${project.project.fileName === item.fileName ? 'active' : ''}`}
                  onClick={() => void openLocal(item.fileName)}
                >
                  <strong>{item.name}</strong>
                  <span>{item.fileName}</span>
                  <small>{item.pointsCount} точек · {item.groupsCount} групп · {formatProjectDate(item.updatedAt)}</small>
                  {project.project.fileName === item.fileName && <em>Открыт сейчас</em>}
                </button>
              ))}
            </div>
          </div>
        </DraggablePanel>
      )}
      {workspaceOpen && (
        <WorkspaceSettingsPanel
          toolbarHeight={toolbarHeight}
          statusBarHeight={28}
          onClose={() => setWorkspaceOpen(false)}
        />
      )}
    </>
  );
}


