import { create } from 'zustand';
import { getUserConfig, numberRows, saveUserConfig as saveUserConfigFile, type UserConfigPayload } from '../api/client';
import {
  CAD_BASE_COLORS,
  createEmptyProject,
  defaultNumberingSettings,
  GridSettings,
  GroupManagerDock,
  NumberingSettings,
  NumberingMethod,
  NumberingManualLink,
  NumberingPipeline,
  OperationRecord,
  PileGroup,
  Point2D,
  PilePoint,
  PileProject
} from '../types/project';

function makeGroupName(order: number) {
  return `Группа ${order}`;
}

function normalizeHex(color: string) {
  return color.trim().toLowerCase();
}

function makeGroupColor(order: number, existingGroups: PileGroup[]) {
  const used = new Set(existingGroups.map((g) => normalizeHex(g.color)));
  const free = CAD_BASE_COLORS.find((color) => !used.has(normalizeHex(color.value)));
  if (free) return free.value;
  return CAD_BASE_COLORS[(order - 1) % CAD_BASE_COLORS.length].value;
}

function makeGroup(order: number, existingGroups: PileGroup[], pipelineId: string | null): PileGroup {
  return {
    id: crypto.randomUUID(),
    name: makeGroupName(order),
    order,
    pipelineId,
    color: makeGroupColor(order, existingGroups),
    visible: true,
    locked: false,
    numbering: defaultNumberingSettings('rows')
  };
}

function isDefaultGroupName(value: string | undefined | null) {
  return /^Группа\s+\d+$/i.test((value ?? '').trim());
}

function normalizeGroupOrderAndNames(groups: PileGroup[]): PileGroup[] {
  return [...groups]
    .sort((a, b) => a.order - b.order)
    .map((group, index) => ({
      ...group,
      order: index + 1,
      name: isDefaultGroupName(group.name) ? makeGroupName(index + 1) : group.name
    }));
}

function reindexGroupOrderAndNames(groups: PileGroup[]): PileGroup[] {
  return groups.map((group, index) => ({
    ...group,
    order: index + 1,
    name: isDefaultGroupName(group.name) ? makeGroupName(index + 1) : group.name
  }));
}

function groupPointCount(points: PilePoint[], groupId: string) {
  return points.filter((point) => point.groupId === groupId).length;
}


const DEFAULT_PIPELINE_ID = 'pipeline-main';

function makePipelineName(order: number) {
  return `Пайплайн ${order}`;
}

function makePipeline(order: number): NumberingPipeline {
  return {
    id: `pipeline-${crypto.randomUUID()}`,
    name: makePipelineName(order),
    order
  };
}

function isDefaultPipelineName(value: string | undefined | null) {
  return /^Пайплайн\s+\d+$/i.test((value ?? '').trim());
}

function normalizePipelines(raw: NumberingPipeline[] | undefined | null): NumberingPipeline[] {
  const source = Array.isArray(raw) && raw.length > 0
    ? raw
    : [{ id: DEFAULT_PIPELINE_ID, name: makePipelineName(1), order: 1 }];

  const seen = new Set<string>();
  return source
    .map((pipeline, index) => ({
      id: pipeline?.id || (index === 0 ? DEFAULT_PIPELINE_ID : `pipeline-${crypto.randomUUID()}`),
      name: pipeline?.name || makePipelineName(index + 1),
      order: Number.isFinite(pipeline?.order) ? pipeline.order : index + 1
    }))
    .filter((pipeline) => {
      if (seen.has(pipeline.id)) return false;
      seen.add(pipeline.id);
      return true;
    })
    .sort((a, b) => a.order - b.order)
    .map((pipeline, index) => ({
      ...pipeline,
      order: index + 1,
      name: isDefaultPipelineName(pipeline.name) ? makePipelineName(index + 1) : pipeline.name
    }));
}

function defaultPipelineId(project: Pick<PileProject, 'pipelines'>) {
  return project.pipelines[0]?.id ?? DEFAULT_PIPELINE_ID;
}

function groupPipelineId(group: PileGroup, project: Pick<PileProject, 'pipelines'>) {
  const valid = new Set(project.pipelines.map((pipeline) => pipeline.id));
  return group.pipelineId && valid.has(group.pipelineId) ? group.pipelineId : defaultPipelineId(project);
}

function normalizeGroupOrderWithinPipelines(groups: PileGroup[], pipelines: NumberingPipeline[]): PileGroup[] {
  const pipelineOrder = new Map(pipelines.map((pipeline, index) => [pipeline.id, index]));
  const fallbackPipelineId = pipelines[0]?.id ?? DEFAULT_PIPELINE_ID;
  const counters = new Map<string, number>();
  return [...groups]
    .map((group) => ({
      ...group,
      pipelineId: group.pipelineId && pipelineOrder.has(group.pipelineId) ? group.pipelineId : fallbackPipelineId
    }))
    .sort((a, b) => (
      (pipelineOrder.get(a.pipelineId ?? fallbackPipelineId) ?? 0) - (pipelineOrder.get(b.pipelineId ?? fallbackPipelineId) ?? 0) ||
      a.order - b.order ||
      a.name.localeCompare(b.name, 'ru')
    ))
    .map((group) => {
      const pipelineId = group.pipelineId ?? fallbackPipelineId;
      const order = (counters.get(pipelineId) ?? 0) + 1;
      counters.set(pipelineId, order);
      return {
        ...group,
        order,
        name: isDefaultGroupName(group.name) ? makeGroupName(order) : group.name
      };
    });
}

function sortedPipelines(project: Pick<PileProject, 'pipelines'>) {
  return [...project.pipelines].sort((a, b) => a.order - b.order);
}

function sortedGroupsForPipeline(project: Pick<PileProject, 'groups' | 'pipelines'>, pipelineId: string | null | undefined) {
  const resolvedPipelineId = pipelineId ?? defaultPipelineId(project);
  return [...project.groups]
    .filter((group) => groupPipelineId(group, project) === resolvedPipelineId)
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'ru'));
}

function firstGroupInPipeline(project: PileProject, pipelineId: string | null | undefined) {
  return sortedGroupsForPipeline(project, pipelineId)[0] ?? null;
}

function pipelineStartNumber(project: PileProject, pipelineId: string | null | undefined) {
  const firstGroup = firstGroupInPipeline(project, pipelineId);
  return firstGroup?.numbering.startNumber ?? 1;
}

function nearestPointIdToAnchor(points: PilePoint[], anchor: Pick<PilePoint, 'x' | 'y'> | null | undefined) {
  if (!anchor || points.length === 0) return null;
  return [...points].sort((a, b) => pointDistance(a, anchor) - pointDistance(b, anchor))[0]?.id ?? null;
}

function buildOrderWithContinuity(points: PilePoint[], settings: NumberingSettings, previousEndPoint?: Pick<PilePoint, 'x' | 'y'> | null) {
  const effectiveSettings = !settings.startPointId && previousEndPoint
    ? { ...settings, startPointId: nearestPointIdToAnchor(points, previousEndPoint) }
    : settings;
  return {
    settings: effectiveSettings,
    route: buildNumberingOrder(points, effectiveSettings)
  };
}

interface EffectiveGroupNumberingContext {
  startNumber: number;
  previousEndPoint: PilePoint | null;
}

function resolveEffectiveGroupNumberingContext(project: PileProject, targetGroup: PileGroup): EffectiveGroupNumberingContext {
  if (project.numberingMode !== 'global_sequential') {
    return {
      startNumber: targetGroup.numbering.startNumber,
      previousEndPoint: null
    };
  }

  const pipelineId = groupPipelineId(targetGroup, project);
  const pipelineGroups = sortedGroupsForPipeline(project, pipelineId);
  let currentStart = pipelineStartNumber(project, pipelineId);
  let previousEndPoint: PilePoint | null = null;
  let simulatedPoints = project.points;

  for (const group of pipelineGroups) {
    const groupPoints = simulatedPoints.filter((point) => point.groupId === group.id);
    if (group.id === targetGroup.id) {
      return {
        startNumber: currentStart,
        previousEndPoint
      };
    }
    if (groupPoints.length === 0) continue;

    const continuityAnchor = previousEndPoint;
    const routePreview = buildOrderWithContinuity(groupPoints, group.numbering, continuityAnchor);
    previousEndPoint = routePreview.route[routePreview.route.length - 1] ?? previousEndPoint;

    if (group.locked) {
      currentStart = nextNumberAfterLockedGroup(simulatedPoints, group, currentStart);
      continue;
    }

    const result = applyNumberingToGroup(simulatedPoints, group, currentStart, continuityAnchor);
    simulatedPoints = result.points;
    currentStart = result.nextNumber;
    previousEndPoint = result.route[result.route.length - 1] ?? previousEndPoint;
  }

  return {
    startNumber: currentStart,
    previousEndPoint
  };
}

function buildPreviewOrderForGroup(project: PileProject, targetGroup: PileGroup) {
  const pipelineId = groupPipelineId(targetGroup, project);
  const groups = sortedGroupsForPipeline(project, pipelineId);
  let previousEndPoint: PilePoint | null = null;

  for (const group of groups) {
    const groupPoints = project.points.filter((p) => p.groupId === group.id);
    if (groupPoints.length === 0) {
      if (group.id === targetGroup.id) return { route: [] as PilePoint[], settings: group.numbering };
      continue;
    }

    const { route, settings } = buildOrderWithContinuity(groupPoints, group.numbering, previousEndPoint);
    if (group.id === targetGroup.id) return { route, settings };
    previousEndPoint = route[route.length - 1] ?? previousEndPoint;
  }

  return { route: [] as PilePoint[], settings: targetGroup.numbering };
}

function findFirstNonEmptyGroup(project: PileProject, preferredGroupId?: string | null, preferredPipelineId?: string | null) {
  const preferredGroup = preferredGroupId ? project.groups.find((group) => group.id === preferredGroupId) : null;
  const pipelineId = preferredPipelineId ?? (preferredGroup ? groupPipelineId(preferredGroup, project) : defaultPipelineId(project));
  const groups = sortedGroupsForPipeline(project, pipelineId);
  const preferred = preferredGroupId ? groups.find((group) => group.id === preferredGroupId) : null;
  if (preferred && groupPointCount(project.points, preferred.id) > 0) return preferred;
  return groups.find((group) => groupPointCount(project.points, group.id) > 0) ?? preferred ?? groups[0] ?? firstGroupInPipeline(project, defaultPipelineId(project));
}


function makeOperation(type: string, payload: Record<string, unknown> = {}): OperationRecord {
  return {
    id: crypto.randomUUID(),
    type,
    timestamp: new Date().toISOString(),
    payload
  };
}

function fileBaseName(fileName: string) {
  const clean = (fileName || '').split(/[\\/]/).pop() || 'project';
  return clean
    .replace(/\.pilenum\.json$/i, '')
    .replace(/\.json$/i, '')
    .replace(/\.csv$/i, '')
    .trim() || 'project';
}

function withProjectFileMeta(project: PileProject, patch: Partial<PileProject['project']>): PileProject {
  return {
    ...project,
    project: {
      ...project.project,
      ...patch,
      updatedAt: new Date().toISOString()
    }
  };
}

const USER_CONFIG_KEY = 'pile-numbering:user-config:v2';

type UserConfig = Omit<UserConfigPayload, 'gridSettings' | 'viewSettings' | 'groupManagerDock'> & {
  projectName?: string | null;
  gridSettings?: Partial<GridSettings>;
  viewSettings?: Partial<PileProject['viewSettings']>;
  groupManagerVisible?: boolean | null;
  groupManagerDock?: GroupManagerDock | string | null;
  groupManagerCollapsed?: boolean | null;
  autoAssignSelection?: boolean | null;
  collapsedGroupIds?: string[];
};

function loadUserConfig(): UserConfig {
  // UI-настройки должны приходить из config/user_config.json через backend.
  // LocalStorage остаётся только fallback/cache для браузерного режима.
  return {};
}

function normalizeDock(value: unknown): GroupManagerDock | undefined {
  return value === 'left' || value === 'right' || value === 'floating' ? value : undefined;
}

function applyUserConfigToEmptyProject(project: PileProject, config: UserConfig): PileProject {
  return {
    ...project,
    project: {
      ...project.project
    },
    gridSettings: {
      ...project.gridSettings,
      ...(config.gridSettings ?? {})
    },
    viewSettings: normalizeViewSettingsForCurrentUi({
      ...project.viewSettings,
      ...(config.viewSettings ?? {})
    })
  };
}

function buildUserConfig(state: Pick<ProjectState, 'project' | 'groupManagerVisible' | 'groupManagerDock' | 'groupManagerCollapsed' | 'autoAssignSelection' | 'collapsedGroupIds'>): UserConfig {
  return {
    projectName: null,
    gridSettings: state.project.gridSettings,
    viewSettings: state.project.viewSettings,
    groupManagerVisible: state.groupManagerVisible,
    groupManagerDock: state.groupManagerDock,
    groupManagerCollapsed: state.groupManagerCollapsed,
    autoAssignSelection: state.autoAssignSelection,
    collapsedGroupIds: state.collapsedGroupIds
  };
}

async function mergeAndSaveUserConfig(config: UserConfig) {
  try {
    const existing = await getUserConfig();
    await saveUserConfigFile({
      ...existing,
      ...config,
      gridSettings: { ...(existing.gridSettings ?? {}), ...(config.gridSettings ?? {}) },
      viewSettings: { ...(existing.viewSettings ?? {}), ...(config.viewSettings ?? {}) },
      panels: existing.panels ?? {}
    });
  } catch {
    // Backend config can be unavailable in pure static/browser fallback.
  }
}

function saveUserConfig(state: Pick<ProjectState, 'project' | 'groupManagerVisible' | 'groupManagerDock' | 'groupManagerCollapsed' | 'autoAssignSelection' | 'collapsedGroupIds'>) {
  if (typeof window === 'undefined') return;
  const config = buildUserConfig(state);
  void mergeAndSaveUserConfig(config);
}

function sanitizeGroupsNumbering(groups: PileGroup[], points: PilePoint[]): PileGroup[] {
  const pointGroupById = new Map(points.map((p) => [p.id, p.groupId ?? null]));

  return groups.map((group, index) => {
    const rawMethod = group.numbering?.method === 'manual' ? 'rows' : group.numbering?.method ?? 'rows';
    const numbering = { ...defaultNumberingSettings(rawMethod), ...(group.numbering ?? {}), method: rawMethod };
    const startPointId = numbering.startPointId && pointGroupById.get(numbering.startPointId) === group.id ? numbering.startPointId : null;
    const endPointId = numbering.endPointId && pointGroupById.get(numbering.endPointId) === group.id ? numbering.endPointId : null;
    const manualLinks = (numbering.manualLinks ?? []).filter((link) => (
      link &&
      link.fromId &&
      link.toId &&
      link.fromId !== link.toId &&
      pointGroupById.get(link.fromId) === group.id &&
      pointGroupById.get(link.toId) === group.id
    ));

    return {
      ...group,
      order: group.order ?? index + 1,
      visible: group.visible ?? true,
      locked: group.locked ?? false,
      meta: group.meta ?? {},
      numbering: {
        ...numbering,
        startPointId,
        endPointId,
        manualLinks
      }
    };
  });
}

function withSanitizedNumberingRefs(project: PileProject): PileProject {
  return {
    ...project,
    groups: sanitizeGroupsNumbering(project.groups ?? [], project.points ?? [])
  };
}

function normalizeViewSettingsForCurrentUi(viewSettings: PileProject['viewSettings']): PileProject['viewSettings'] {
  const next = { ...viewSettings };

  // Миграция старых проектов/конфигов: базовый режим — простой Tahoma,
  // без тяжёлых обводок текста и без ядовито-красных служебных выносок.
  if (!next.numberTextFontFamily || next.numberTextFontFamily.includes('Inter')) next.numberTextFontFamily = 'Tahoma, Segoe UI, Arial, sans-serif';
  if (!next.markerTextFontFamily || next.markerTextFontFamily.includes('Inter')) next.markerTextFontFamily = 'Tahoma, Segoe UI, Arial, sans-serif';

  if (next.numberTextStrokeColor === '#020617' && (next.numberTextStrokeWidth ?? 0.8) <= 0.8) {
    next.numberTextStrokeEnabled = false;
    next.numberTextStrokeWidth = 0;
  }
  if (next.markerTextStrokeColor === '#020617' && (next.markerTextStrokeWidth ?? 0.9) <= 0.9) {
    next.markerTextStrokeEnabled = false;
    next.markerTextStrokeWidth = 0;
  }
  if (next.numberTextBubbleColor === '#020617' || next.numberTextBubbleColor === '#000000' || next.numberTextBubbleColor === 'rgba(2,6,23,0.72)') {
    next.numberTextBubbleEnabled = false;
  }
  if ((next.previewPointLabelStrokeWidth ?? 0) <= 1 && next.previewPointLabelStrokeColor === '#020617') {
    next.previewPointLabelStrokeWidth = 0;
  }

  // Старые дефолты были слишком агрессивными на тёмном поле. Если пользователь
  // не выбирал другой цвет, переводим их в спокойную CAD-палитру.
  if (next.groupOutlineStrokeColor === '#ef4444') next.groupOutlineStrokeColor = '#38bdf8';
  if (next.markerCalloutBorderColor === '#ef4444') next.markerCalloutBorderColor = '#64748b';
  if (next.markerLeaderLineColor === '#ef4444') next.markerLeaderLineColor = '#64748b';
  if (next.previewAutoLineColor === '#a78bfa') next.previewAutoLineColor = '#38bdf8';
  if (next.previewAutoArrowColor === '#c4b5fd') next.previewAutoArrowColor = '#67e8f9';

  if (!next.markerTextColor || next.markerTextColor === '#bfdbfe') next.markerTextColor = '#ffffff';
  if (!next.previewPointLabelColor || next.previewPointLabelColor === '#ede9fe') next.previewPointLabelColor = '#ffffff';
  if (next.markerCalloutBackgroundColor === '#020617') next.markerCalloutBackgroundColor = 'rgba(15,23,42,0.82)';
  if (next.numberTextBubbleStrokeColor === '#000000') next.numberTextBubbleStrokeColor = '#334155';
  if (typeof next.groupOutlineVisible !== 'boolean') next.groupOutlineVisible = true;
  if (typeof next.showVectorPath !== 'boolean') next.showVectorPath = true;

  return next;
}

function normalizeProject(project: PileProject, uiSource?: Pick<PileProject, 'gridSettings' | 'viewSettings'>): PileProject {
  const defaults = createEmptyProject();
  const pipelines = normalizePipelines(project.pipelines ?? defaults.pipelines);
  const runtimeGridSettings = uiSource?.gridSettings ?? project.gridSettings ?? defaults.gridSettings;
  const runtimeViewSettings = uiSource?.viewSettings ?? project.viewSettings ?? defaults.viewSettings;
  const normalized: PileProject = {
    ...defaults,
    ...project,
    project: { ...defaults.project, ...project.project },
    // gridSettings/viewSettings are runtime UI config. They may be absent in .pilenum.json
    // and must not be taken from another project when opening a file.
    gridSettings: { ...defaults.gridSettings, ...runtimeGridSettings },
    viewSettings: normalizeViewSettingsForCurrentUi({ ...defaults.viewSettings, ...runtimeViewSettings }),
    points: project.points ?? [],
    pipelines,
    groups: normalizeGroupOrderWithinPipelines(project.groups ?? [], pipelines),
    operations: project.operations ?? []
  };
  return withSanitizedNumberingRefs(normalized);
}


export type NumberingPreviewDisplayMode = 'animated' | 'full' | 'paused';

interface NumberingPreviewState {
  visible: boolean;
  groupId: string | null;
  routePointIds: string[];
  method: string;
  displayMode: NumberingPreviewDisplayMode;
  generatedAt: number;
}

export type NumberingPickMode = 'group_start' | 'group_end' | 'manual_link_target' | null;

const EMPTY_NUMBERING_PREVIEW: NumberingPreviewState = {
  visible: false,
  groupId: null,
  routePointIds: [],
  method: 'rows',
  displayMode: 'animated',
  generatedAt: 0
};

function pointDistance(a: Pick<PilePoint, 'x' | 'y'>, b: Pick<PilePoint, 'x' | 'y'>) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}


function percentileNumber(values: number[], q: number) {
  const finite = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (finite.length === 0) return 0;
  const index = Math.max(0, Math.min(finite.length - 1, Math.round((finite.length - 1) * q)));
  return finite[index] ?? 0;
}

function estimateNearestStepForAuto(points: PilePoint[]) {
  if (points.length < 2) return 1000;
  const nearest: number[] = [];
  for (let i = 0; i < points.length; i += 1) {
    let best = Number.POSITIVE_INFINITY;
    for (let j = 0; j < points.length; j += 1) {
      if (i === j) continue;
      const d = pointDistance(points[i], points[j]);
      if (d > 1e-9 && d < best) best = d;
    }
    if (Number.isFinite(best)) nearest.push(best);
  }
  return Math.max(1, percentileNumber(nearest, 0.5) || 1000);
}

interface AutoBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function autoBounds(points: PilePoint[]): AutoBounds {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys)
  };
}

function autoCenter(points: PilePoint[]) {
  return centroid(points);
}

function autoBandOverlap(aMin: number, aMax: number, bMin: number, bMax: number) {
  return Math.max(0, Math.min(aMax, bMax) - Math.max(aMin, bMin));
}

function denseHorizontalBands(points: PilePoint[], nearestStep: number) {
  const tolerance = Math.max(500, nearestStep * 0.65);
  const minDenseCount = Math.max(6, Math.floor(Math.sqrt(points.length) * 1.25));
  const raw = autoAxisBuckets(points, 'y', tolerance)
    .map((bucket) => ({ points: bucket, bounds: autoBounds(bucket), center: autoCenter(bucket) }))
    .filter((band) => (
      band.points.length >= minDenseCount &&
      band.bounds.maxX - band.bounds.minX >= nearestStep * 6
    ))
    .sort((a, b) => a.center.y - b.center.y);

  const merged: Array<{ points: PilePoint[]; bounds: AutoBounds; center: Point2D }> = [];

  for (const band of raw) {
    const previous = merged[merged.length - 1];
    if (!previous) {
      merged.push(band);
      continue;
    }

    const yGap = band.bounds.minY - previous.bounds.maxY;
    const xOverlap = autoBandOverlap(previous.bounds.minX, previous.bounds.maxX, band.bounds.minX, band.bounds.maxX);
    const xGap = Math.max(0, Math.max(previous.bounds.minX, band.bounds.minX) - Math.min(previous.bounds.maxX, band.bounds.maxX));
    const canMerge =
      yGap <= nearestStep * 1.45 &&
      (xOverlap > nearestStep || xGap <= nearestStep * 2.2);

    if (!canMerge) {
      merged.push(band);
      continue;
    }

    const points = [...previous.points, ...band.points];
    previous.points = points;
    previous.bounds = autoBounds(points);
    previous.center = autoCenter(points);
  }

  return merged;
}

function mergeClustersByHorizontalBands(clusters: PilePoint[][], allPoints: PilePoint[], nearestStep: number) {
  let working = clusters.map((cluster) => [...cluster]);
  const bands = denseHorizontalBands(allPoints, nearestStep);
  if (bands.length === 0) return working;

  for (const band of bands) {
    const bandIds = new Set(band.points.map((point) => point.id));
    const hits = working
      .map((cluster, index) => {
        const inside = cluster.filter((point) => bandIds.has(point.id));
        return {
          index,
          inside,
          insideIds: new Set(inside.map((point) => point.id)),
          share: cluster.length > 0 ? inside.length / cluster.length : 0
        };
      })
      .filter((hit) => hit.inside.length > 0);

    const primary = hits.filter((hit) => hit.inside.length >= 4 && hit.share >= 0.35);
    const donors = hits.filter((hit) => hit.inside.length >= 2 && hit.share < 0.35);

    if (primary.length === 0 || (primary.length === 1 && donors.length === 0)) continue;

    const targetIndex = primary[0].index;
    const targetIds = new Set(working[targetIndex].map((point) => point.id));

    for (const hit of primary.slice(1)) {
      for (const point of working[hit.index]) {
        if (!targetIds.has(point.id)) {
          working[targetIndex].push(point);
          targetIds.add(point.id);
        }
      }
      working[hit.index] = [];
    }

    // Если большой кластер случайно зацепил несколько точек плотного горизонтального
    // пояса, переносим только эти точки, а не весь большой кластер. Именно так
    // лечится ситуация, когда начало следующего поля приклеивается к предыдущему
    // по ближайшему вертикальному соседу.
    for (const hit of donors) {
      for (const point of hit.inside) {
        if (!targetIds.has(point.id)) {
          working[targetIndex].push(point);
          targetIds.add(point.id);
        }
      }
      working[hit.index] = working[hit.index].filter((point) => !hit.insideIds.has(point.id));
    }

    working = working.filter((cluster) => cluster.length > 0);
  }

  return working;
}

function verticalTailBands(points: PilePoint[], nearestStep: number) {
  const tolerance = Math.max(500, nearestStep * 0.65);
  const columnBuckets = autoAxisBuckets(points, 'x', tolerance)
    .map((bucket) => ({ points: bucket, bounds: autoBounds(bucket), center: autoCenter(bucket) }))
    .filter((band) => (
      band.points.length >= 6 &&
      band.bounds.maxY - band.bounds.minY >= nearestStep * 6
    ))
    .sort((a, b) => a.center.x - b.center.x);

  const merged: Array<{ points: PilePoint[]; bounds: AutoBounds; center: Point2D }> = [];
  for (const band of columnBuckets) {
    const previous = merged[merged.length - 1];
    if (!previous) {
      merged.push(band);
      continue;
    }

    const xGap = band.bounds.minX - previous.bounds.maxX;
    const yOverlap = autoBandOverlap(previous.bounds.minY, previous.bounds.maxY, band.bounds.minY, band.bounds.maxY);
    const canMerge = xGap <= nearestStep * 2.05 && yOverlap >= nearestStep * 2.0;

    if (!canMerge) {
      merged.push(band);
      continue;
    }

    const points = [...previous.points, ...band.points];
    previous.points = points;
    previous.bounds = autoBounds(points);
    previous.center = autoCenter(points);
  }

  return merged;
}

function splitRightVerticalTail(cluster: PilePoint[], nearestStep: number) {
  if (cluster.length < 18) return [cluster];

  const bounds = autoBounds(cluster);
  const width = bounds.maxX - bounds.minX;
  const tailCandidates = verticalTailBands(cluster, nearestStep)
    .filter((band) => {
      const b = band.bounds;
      const tailWidth = b.maxX - b.minX;
      const tailHeight = b.maxY - b.minY;
      const nearRightEdge = b.maxX >= bounds.maxX - Math.max(nearestStep * 2.5, width * 0.08);
      const enoughRemainder = cluster.length - band.points.length >= 8;
      return (
        nearRightEdge &&
        band.points.length >= 8 &&
        enoughRemainder &&
        tailHeight >= nearestStep * 6 &&
        tailWidth <= Math.max(nearestStep * 3, width * 0.12)
      );
    })
    .sort((a, b) => (b.center.x - a.center.x) || (b.points.length - a.points.length));

  const tail = tailCandidates[0];
  if (!tail) return [cluster];

  const tailIds = new Set(tail.points.map((point) => point.id));
  const main = cluster.filter((point) => !tailIds.has(point.id));
  if (main.length < 8) return [cluster];

  return [main, tail.points];
}

function refineAutoClusters(points: PilePoint[], clusters: PilePoint[][], nearestStep: number) {
  const mergedByBands = mergeClustersByHorizontalBands(clusters, points, nearestStep);
  const split: PilePoint[][] = [];
  for (const cluster of mergedByBands) {
    split.push(...splitRightVerticalTail(cluster, nearestStep));
  }
  return split.filter((cluster) => cluster.length > 0).sort((a, b) => b.length - a.length);
}

function connectedAutoClusters(points: PilePoint[]) {
  if (points.length <= 1) return points.length ? [points] : [];

  const nearestStep = estimateNearestStepForAuto(points);
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), nearestStep);
  const softLimit = Math.max(nearestStep * 3.2, span * 0.035, 1200);
  const neighborLimit = Math.min(Math.max(softLimit, nearestStep * 2.4), Math.max(nearestStep * 5.5, 2500));
  const neighbors = new Map<string, string[]>();

  for (const point of points) neighbors.set(point.id, []);

  // Строим локальный граф по нескольким ближайшим соседям. Это мягче, чем чистый DBSCAN:
  // разрозненные ряды связываются, но огромные пустые разрывы не склеивают разные поля.
  for (let i = 0; i < points.length; i += 1) {
    const current = points[i];
    const ordered = points
      .filter((candidate) => candidate.id !== current.id)
      .map((candidate) => ({ candidate, d: pointDistance(current, candidate) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 4);

    for (const item of ordered) {
      if (item.d <= neighborLimit) {
        neighbors.get(current.id)?.push(item.candidate.id);
        neighbors.get(item.candidate.id)?.push(current.id);
      }
    }
  }

  const byId = new Map(points.map((point) => [point.id, point]));
  const used = new Set<string>();
  const result: PilePoint[][] = [];

  for (const point of points) {
    if (used.has(point.id)) continue;
    const queue = [point.id];
    const cluster: PilePoint[] = [];
    used.add(point.id);
    while (queue.length) {
      const id = queue.shift()!;
      const item = byId.get(id);
      if (item) cluster.push(item);
      for (const nextId of neighbors.get(id) ?? []) {
        if (used.has(nextId)) continue;
        used.add(nextId);
        queue.push(nextId);
      }
    }
    result.push(cluster);
  }

  return refineAutoClusters(points, result, nearestStep);
}

function centroid(points: PilePoint[]) {
  const count = Math.max(1, points.length);
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / count,
    y: points.reduce((sum, point) => sum + point.y, 0) / count
  };
}

function orderClustersByRoute(clusters: PilePoint[][]) {
  if (clusters.length <= 1) return clusters;
  const items = clusters.map((points, index) => ({ points, index, center: centroid(points) }));
  const startIndex = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (b.item.center.y - a.item.center.y) || (a.item.center.x - b.item.center.x) || (a.item.index - b.item.index))[0]?.index ?? 0;
  const route = [items.splice(startIndex, 1)[0]];

  while (items.length) {
    const current = route[route.length - 1].center;
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < items.length; i += 1) {
      const d = Math.hypot(items[i].center.x - current.x, items[i].center.y - current.y);
      if (d < bestDistance) {
        bestDistance = d;
        bestIndex = i;
      }
    }
    route.push(items.splice(bestIndex, 1)[0]);
  }

  return route.map((item) => item.points);
}

function autoAxisBuckets(points: PilePoint[], axis: 'x' | 'y', tolerance: number) {
  const sorted = [...points].sort((a, b) => (axis === 'x' ? a.x - b.x : a.y - b.y));
  const buckets: PilePoint[][] = [];
  const getValue = (point: PilePoint) => (axis === 'x' ? point.x : point.y);

  for (const point of sorted) {
    const current = buckets[buckets.length - 1];
    if (!current) {
      buckets.push([point]);
      continue;
    }
    const center = current.reduce((sum, item) => sum + getValue(item), 0) / current.length;
    if (Math.abs(getValue(point) - center) <= tolerance) current.push(point);
    else buckets.push([point]);
  }

  return buckets;
}

function scoreAxisMethod(points: PilePoint[], axis: 'x' | 'y', tolerance: number) {
  if (points.length < 3) return 0;
  const buckets = autoAxisBuckets(points, axis, tolerance).filter((bucket) => bucket.length > 0);
  const multiBuckets = buckets.filter((bucket) => bucket.length >= 2);
  const covered = multiBuckets.reduce((sum, bucket) => sum + bucket.length, 0);
  const avg = multiBuckets.length ? covered / multiBuckets.length : 0;
  const coverage = covered / points.length;
  const balancePenalty = buckets.length > 1 ? 1 : 0.55;
  return coverage * avg * balancePenalty;
}

function chooseAutoNumberingForCluster(points: PilePoint[], order: number, pipelineStart: number): NumberingSettings {
  const nearestStep = estimateNearestStepForAuto(points);
  const tolerance = Math.max(120, Math.min(1500, nearestStep * 0.35));
  const rowsScore = scoreAxisMethod(points, 'y', tolerance);
  const columnsScore = scoreAxisMethod(points, 'x', tolerance);
  const method: Exclude<NumberingMethod, 'manual' | 'vector'> = rowsScore >= columnsScore * 1.12 ? 'rows' : columnsScore > rowsScore * 1.12 ? 'columns' : 'route';

  return {
    ...defaultNumberingSettings(method),
    startNumber: order === 1 ? pipelineStart : 1,
    rowTolerance: tolerance,
    columnTolerance: tolerance,
    direction: method === 'columns' ? 'snake_columns_top_left' : points.length >= 8 ? 'snake_rows_left_top' : 'left_to_right_top_to_bottom',
    optimize: true
  };
}

function makeBucketsForNumbering(points: PilePoint[], axis: 'x' | 'y', tolerance: number) {
  if (!points.length) return [] as { center: number; points: PilePoint[] }[];
  const safeTolerance = Math.max(1e-9, Number.isFinite(tolerance) ? tolerance : 250);
  const ordered = [...points].sort((a, b) => (axis === 'x' ? a.x - b.x : a.y - b.y));
  const buckets: PilePoint[][] = [];
  const getValue = (p: PilePoint) => (axis === 'x' ? p.x : p.y);

  for (const point of ordered) {
    const current = buckets[buckets.length - 1];
    if (!current) {
      buckets.push([point]);
      continue;
    }
    const center = current.reduce((sum, p) => sum + getValue(p), 0) / current.length;
    if (Math.abs(getValue(point) - center) <= safeTolerance) current.push(point);
    else buckets.push([point]);
  }

  return buckets.map((points) => ({
    points,
    center: points.reduce((sum, p) => sum + getValue(p), 0) / Math.max(1, points.length)
  }));
}

function applyStartEndPreference(route: PilePoint[], settings: NumberingSettings) {
  if (route.length <= 1) return route;
  const byId = new Map(route.map((p) => [p.id, p]));
  const start = settings.startPointId ? byId.get(settings.startPointId) : null;
  const end = settings.endPointId ? byId.get(settings.endPointId) : null;
  if (!start && !end) return route;

  const endpointScore = (candidate: PilePoint[]) => {
    let value = 0;
    if (start) value += candidate[0]?.id === start.id ? 0 : pointDistance(candidate[0], start) + 100000;
    if (end) value += candidate[candidate.length - 1]?.id === end.id ? 0 : pointDistance(candidate[candidate.length - 1], end) + 100000;
    return value;
  };

  const reversed = [...route].reverse();
  const oriented = endpointScore(reversed) < endpointScore(route) ? reversed : route;

  if (start && end && start.id !== end.id) {
    return [start, ...oriented.filter((p) => p.id !== start.id && p.id !== end.id), end];
  }
  if (start) return [start, ...oriented.filter((p) => p.id !== start.id)];
  if (end) return [...oriented.filter((p) => p.id !== end.id), end];
  return oriented;
}

function applyManualLinksToRoute(route: PilePoint[], links: NumberingManualLink[] | undefined, endPointId?: string | null) {
  const validLinks = (links ?? []).filter((link) => link.fromId && link.toId && link.fromId !== link.toId);
  if (route.length <= 1 || validLinks.length === 0) return route;

  const byId = new Map(route.map((p) => [p.id, p]));
  const naturalIndex = new Map(route.map((p, index) => [p.id, index]));
  const fixedEndId = endPointId && byId.has(endPointId) ? endPointId : null;
  const linkMap = new Map<string, string>();
  for (const link of validLinks) {
    if (byId.has(link.fromId) && byId.has(link.toId)) linkMap.set(link.fromId, link.toId);
  }
  if (linkMap.size === 0) return route;

  const unusedNaturalPoints = (used: Set<string>) => route.filter((p) => !used.has(p.id));

  const nextNaturalAfter = (pointId: string, used: Set<string>) => {
    const index = naturalIndex.get(pointId) ?? -1;
    for (let i = index + 1; i < route.length; i += 1) {
      const candidate = route[i];
      if (fixedEndId && candidate.id === fixedEndId && unusedNaturalPoints(used).some((p) => p.id !== fixedEndId)) continue;
      if (!used.has(candidate.id)) return candidate;
    }
    const rest = unusedNaturalPoints(used);
    return rest.find((p) => !fixedEndId || p.id !== fixedEndId) ?? rest[0] ?? null;
  };

  const nextNearestAfter = (point: PilePoint, used: Set<string>) => {
    const rest = unusedNaturalPoints(used);
    const candidates = fixedEndId && rest.some((p) => p.id !== fixedEndId)
      ? rest.filter((p) => p.id !== fixedEndId)
      : rest;
    if (candidates.length === 0) return null;
    return [...candidates].sort((a, b) => {
      const byDistance = pointDistance(point, a) - pointDistance(point, b);
      if (Math.abs(byDistance) > 1e-9) return byDistance;
      return (naturalIndex.get(a.id) ?? 0) - (naturalIndex.get(b.id) ?? 0);
    })[0] ?? null;
  };

  const result: PilePoint[] = [];
  const used = new Set<string>();
  let current: PilePoint | null = route[0] ?? null;
  let guard = 0;
  let nearestTailMode = false;

  while (current && !used.has(current.id) && guard < route.length + validLinks.length + 20) {
    guard += 1;
    result.push(current);
    used.add(current.id);

    const manualNextId = linkMap.get(current.id);
    if (manualNextId && byId.has(manualNextId) && !used.has(manualNextId)) {
      current = byId.get(manualNextId)!;
      nearestTailMode = true;
      continue;
    }

    current = nearestTailMode ? nextNearestAfter(current, used) : nextNaturalAfter(current.id, used);
  }

  const rest = route.filter((p) => !used.has(p.id));
  if (rest.length === 0) return result;

  // Если ручная связь отправила маршрут в другой конец ветки, остаток лучше
  // добирать от текущей точки ближайшим соседом, а ручной финиш держать последним.
  // Иначе возникает баг: финиш выбран вручную, но фактический конец маршрута уезжает
  // в последнюю точку старого авто-порядка.
  let tail = rest;
  if (nearestTailMode && result.length > 0) {
    const rebuiltTail: PilePoint[] = [];
    const tailUsed = new Set<string>();
    let anchor = result[result.length - 1];
    while (tailUsed.size < tail.length) {
      const candidates = tail.filter((p) => !tailUsed.has(p.id) && (!fixedEndId || p.id !== fixedEndId || tail.some((item) => !tailUsed.has(item.id) && item.id !== fixedEndId)));
      if (candidates.length === 0) break;
      const next = [...candidates].sort((a, b) => {
        const byDistance = pointDistance(anchor, a) - pointDistance(anchor, b);
        if (Math.abs(byDistance) > 1e-9) return byDistance;
        return (naturalIndex.get(a.id) ?? 0) - (naturalIndex.get(b.id) ?? 0);
      })[0];
      rebuiltTail.push(next);
      tailUsed.add(next.id);
      anchor = next;
    }
    tail = [...rebuiltTail, ...tail.filter((p) => !tailUsed.has(p.id))];
  } else {
    tail = [...tail].sort((a, b) => (naturalIndex.get(a.id) ?? 0) - (naturalIndex.get(b.id) ?? 0));
  }

  if (fixedEndId) {
    const fixedEnd = tail.find((p) => p.id === fixedEndId);
    if (fixedEnd) tail = [...tail.filter((p) => p.id !== fixedEndId), fixedEnd];
  }

  return [...result, ...tail];
}

function rotatePointOrderFromStart(points: PilePoint[], startPointId: string | null | undefined) {
  if (!startPointId) return points;
  const index = points.findIndex((p) => p.id === startPointId);
  if (index <= 0) return points;
  return [...points.slice(index), ...points.slice(0, index)];
}

function rotateBucketsFromStart<T extends { points: PilePoint[] }>(buckets: T[], startPointId: string | null | undefined) {
  if (!startPointId) return buckets.map((bucket, originalIndex) => ({ bucket, originalIndex, containsStart: false }));
  const startBucketIndex = buckets.findIndex((bucket) => bucket.points.some((p) => p.id === startPointId));
  const indexed = buckets.map((bucket, originalIndex) => ({ bucket, originalIndex, containsStart: originalIndex === startBucketIndex }));
  if (startBucketIndex <= 0) return indexed;
  return [...indexed.slice(startBucketIndex), ...indexed.slice(startBucketIndex + 1), ...indexed.slice(0, startBucketIndex)];
}

function buildRowsColumnsOrder(points: PilePoint[], settings: NumberingSettings, method: 'rows' | 'columns') {
  if (method === 'columns') {
    const buckets = makeBucketsForNumbering(points, 'x', settings.columnTolerance);
    const direction = settings.direction;
    const leftToRight = !direction.includes('right');
    const topToBottom = !direction.includes('bottom');
    const snake = direction.startsWith('snake_columns');

    buckets.sort((a, b) => leftToRight ? a.center - b.center : b.center - a.center);
    const route: PilePoint[] = [];
    rotateBucketsFromStart(buckets, settings.startPointId).forEach(({ bucket, originalIndex, containsStart }) => {
      let reverse = !topToBottom;
      if (snake && originalIndex % 2 === 1) reverse = !reverse;
      const ordered = [...bucket.points].sort((a, b) => reverse ? a.y - b.y : b.y - a.y);
      route.push(...(containsStart ? rotatePointOrderFromStart(ordered, settings.startPointId) : ordered));
    });
    return route;
  }

  const buckets = makeBucketsForNumbering(points, 'y', settings.rowTolerance);
  const direction = settings.direction;
  const topToBottom = !direction.includes('bottom_to_top') && !direction.endsWith('bottom_left');
  const leftToRight = !direction.includes('right_to_left');
  const snake = direction.startsWith('snake_rows');

  buckets.sort((a, b) => topToBottom ? b.center - a.center : a.center - b.center);
  const route: PilePoint[] = [];
  rotateBucketsFromStart(buckets, settings.startPointId).forEach(({ bucket, originalIndex, containsStart }) => {
    let reverse = !leftToRight;
    if (snake && originalIndex % 2 === 1) reverse = !reverse;
    const ordered = [...bucket.points].sort((a, b) => reverse ? b.x - a.x : a.x - b.x);
    route.push(...(containsStart ? rotatePointOrderFromStart(ordered, settings.startPointId) : ordered));
  });

  return route;
}

function twoOptRoute(route: PilePoint[], keepLast: boolean) {
  if (route.length < 4) return route;
  let result = [...route];
  let improved = true;
  const limit = keepLast ? result.length - 1 : result.length;
  let guard = 0;
  while (improved && guard < 500) {
    improved = false;
    guard += 1;
    for (let i = 1; i < limit - 2; i += 1) {
      for (let j = i + 1; j < limit; j += 1) {
        const a = result[i - 1];
        const b = result[i];
        const c = result[j - 1];
        const d = result[j] ?? result[result.length - 1];
        const before = pointDistance(a, b) + pointDistance(c, d);
        const after = pointDistance(a, c) + pointDistance(b, d);
        if (after + 1e-9 < before) {
          result = result.slice(0, i).concat(result.slice(i, j).reverse(), result.slice(j));
          improved = true;
          break;
        }
      }
      if (improved) break;
    }
  }
  return result;
}

function buildRouteOrder(points: PilePoint[], settings: NumberingSettings) {
  if (points.length <= 1) return points;
  const byId = new Map(points.map((p) => [p.id, p]));
  const start = settings.startPointId ? byId.get(settings.startPointId) : null;
  const end = settings.endPointId ? byId.get(settings.endPointId) : null;
  const first = start ?? [...points].sort((a, b) => (a.x - b.x) || (b.y - a.y))[0];
  const route = [first];
  const remaining = points.filter((p) => p.id !== first.id && p.id !== end?.id);

  while (remaining.length) {
    const current = route[route.length - 1];
    let bestIndex = 0;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < remaining.length; i += 1) {
      const d = pointDistance(current, remaining[i]);
      if (d < best) {
        best = d;
        bestIndex = i;
      }
    }
    route.push(remaining.splice(bestIndex, 1)[0]);
  }

  if (end && end.id !== first.id) route.push(end);
  return settings.optimize ? twoOptRoute(route, Boolean(end)) : route;
}

interface VectorPointScore {
  point: PilePoint;
  originalIndex: number;
  along: number;
  distance: number;
  signedDistance: number;
  segmentIndex: number;
  t: number;
  outsideCorridor: number;
}

function projectPointToSegment(point: Pick<PilePoint, 'x' | 'y'>, a: Point2D, b: Point2D) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  const length = Math.sqrt(length2);
  if (length2 <= 1e-12 || length <= 1e-12) {
    return {
      along: 0,
      distance: Math.hypot(point.x - a.x, point.y - a.y),
      signedDistance: 0,
      t: 0
    };
  }

  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length2));
  const px = a.x + t * dx;
  const py = a.y + t * dy;
  const signedDistance = (dx * (point.y - a.y) - dy * (point.x - a.x)) / length;

  return {
    along: t * length,
    distance: Math.hypot(point.x - px, point.y - py),
    signedDistance,
    t
  };
}

function makeVectorPathMeasures(path: Point2D[]) {
  const lengths = path.slice(0, -1).map((p, i) => Math.hypot(path[i + 1].x - p.x, path[i + 1].y - p.y));
  const prefix = [0];
  for (const length of lengths) prefix.push(prefix[prefix.length - 1] + length);
  return { lengths, prefix };
}

function scorePointOnVectorPath(
  point: PilePoint,
  originalIndex: number,
  path: Point2D[],
  lengths: number[],
  prefix: number[],
  safeMaxDistance: number
): VectorPointScore {
  let bestAlong = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestSignedDistance = 0;
  let bestSegmentIndex = 0;
  let bestT = 0;

  for (let i = 0; i < path.length - 1; i += 1) {
    const projected = projectPointToSegment(point, path[i], path[i + 1]);
    if (
      projected.distance < bestDistance - 1e-9 ||
      (Math.abs(projected.distance - bestDistance) <= 1e-9 && prefix[i] + projected.along < bestAlong)
    ) {
      bestDistance = projected.distance;
      bestSignedDistance = projected.signedDistance;
      bestSegmentIndex = i;
      bestT = projected.t;
      bestAlong = prefix[i] + projected.along;
    }
  }

  return {
    point,
    originalIndex,
    along: bestAlong,
    distance: bestDistance,
    signedDistance: bestSignedDistance,
    segmentIndex: bestSegmentIndex,
    t: bestT,
    outsideCorridor: bestDistance > safeMaxDistance ? 1 : 0
  };
}

function estimateNearestPointStep(points: PilePoint[]) {
  if (points.length < 2) return 1000;
  const nearestDistances: number[] = [];

  for (let i = 0; i < points.length; i += 1) {
    let best = Number.POSITIVE_INFINITY;
    for (let j = 0; j < points.length; j += 1) {
      if (i === j) continue;
      const d = pointDistance(points[i], points[j]);
      if (d < best) best = d;
    }
    if (Number.isFinite(best)) nearestDistances.push(best);
  }

  nearestDistances.sort((a, b) => a - b);
  return nearestDistances[Math.floor(nearestDistances.length / 2)] ?? 1000;
}

function percentile(values: number[], q: number) {
  const finite = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (finite.length === 0) return 0;
  const index = Math.max(0, Math.min(finite.length - 1, Math.floor((finite.length - 1) * q)));
  return finite[index];
}

function effectiveVectorCorridorDistance(scores: VectorPointScore[], settings: NumberingSettings, nearestStep: number) {
  const userDistance = Number.isFinite(settings.maxDistanceToPath)
    ? Math.max(1, settings.maxDistanceToPath)
    : 0;

  // `maxDistanceToPath` остаётся пользовательским допуском/диагностикой, но не должен
  // превращать нормальные точки широкого свайного поля в "забытый хвост". Если большая
  // часть группы лежит дальше нарисованной линии, расширяем внутренний коридор по самой
  // геометрии группы и всё равно ведём маршрут nearest-neighbor.
  const p90Distance = percentile(scores.map((score) => score.distance), 0.9);
  return Math.max(userDistance, nearestStep * 1.2, p90Distance);
}

function buildVectorNearestRoute(points: PilePoint[], settings: NumberingSettings, scores: VectorPointScore[]) {
  if (points.length <= 1) return points;

  const byId = new Map(points.map((p) => [p.id, p]));
  const scoreById = new Map(scores.map((score) => [score.point.id, score]));
  const start = settings.startPointId ? byId.get(settings.startPointId) : null;
  const end = settings.endPointId ? byId.get(settings.endPointId) : null;

  const first = start ?? [...scores]
    .sort((a, b) => (
      (a.outsideCorridor - b.outsideCorridor) ||
      (a.along - b.along) ||
      (a.distance - b.distance) ||
      (a.originalIndex - b.originalIndex)
    ))[0]?.point ?? points[0];

  const route: PilePoint[] = [first];
  const endId = end && end.id !== first.id ? end.id : null;
  const remaining = points.filter((p) => p.id !== first.id && p.id !== endId);

  const nearestStep = estimateNearestPointStep(points);
  const effectiveCorridor = effectiveVectorCorridorDistance(scores, settings, nearestStep);
  const waveWindow = Math.max(nearestStep * 2.8, effectiveCorridor * 1.1, 750);
  const sideSwitchTolerance = Math.max(effectiveCorridor * 0.2, nearestStep * 0.3, 80);

  while (remaining.length > 0) {
    const remainingScores = remaining
      .map((point) => scoreById.get(point.id))
      .filter((score): score is VectorPointScore => Boolean(score));
    const minRemainingAlong = remainingScores.length > 0
      ? Math.min(...remainingScores.map((score) => score.along))
      : Number.NEGATIVE_INFINITY;
    const waveLimit = minRemainingAlong + waveWindow;

    // Главный фикс: выбираем ближайшую точку не из всего остатка, а из текущей
    // "волны" вдоль нарисованной линии. Так метод не забывает близкие точки позади
    // текущего положения и не возвращается к ним через десятки номеров.
    const candidateIndexes = remaining
      .map((point, index) => ({ point, index, score: scoreById.get(point.id) }))
      .filter((item) => !item.score || item.score.along <= waveLimit);

    const candidates = candidateIndexes.length > 0
      ? candidateIndexes
      : remaining.map((point, index) => ({ point, index, score: scoreById.get(point.id) }));

    const current = route[route.length - 1];
    const currentScore = scoreById.get(current.id);
    let bestIndex = candidates[0]?.index ?? 0;
    let bestCost = Number.POSITIVE_INFINITY;
    let bestAlong = Number.POSITIVE_INFINITY;
    let bestOriginalIndex = Number.POSITIVE_INFINITY;

    for (const item of candidates) {
      const candidate = item.point;
      const candidateScore = item.score;
      const euclidean = pointDistance(current, candidate);

      let cost = euclidean;
      let candidateAlong = Number.POSITIVE_INFINITY;
      let candidateOriginalIndex = item.index;

      if (candidateScore) {
        candidateAlong = candidateScore.along;
        candidateOriginalIndex = candidateScore.originalIndex;

        const overCorridor = Math.max(0, candidateScore.distance - effectiveCorridor);
        const pathDistancePenalty = candidateScore.distance * 0.22;
        const corridorPenalty = overCorridor * 0.7;
        const wavefrontPenalty = Math.max(0, candidateScore.along - minRemainingAlong) * 0.05;
        const farAheadPenalty = candidateScore.along > minRemainingAlong + waveWindow * 0.85
          ? (candidateScore.along - (minRemainingAlong + waveWindow * 0.85)) * 0.25
          : 0;

        let sideSwitchPenalty = 0;
        if (currentScore) {
          const sameLocalSegment =
            Math.abs(candidateScore.segmentIndex - currentScore.segmentIndex) <= 2 ||
            Math.abs(candidateScore.along - currentScore.along) < waveWindow * 0.65;

          if (
            sameLocalSegment &&
            Math.abs(currentScore.signedDistance) > sideSwitchTolerance &&
            Math.abs(candidateScore.signedDistance) > sideSwitchTolerance &&
            Math.sign(currentScore.signedDistance) !== Math.sign(candidateScore.signedDistance)
          ) {
            sideSwitchPenalty = Math.min(Math.abs(currentScore.signedDistance), Math.abs(candidateScore.signedDistance)) * 0.8;
          }
        }

        cost +=
          pathDistancePenalty +
          corridorPenalty +
          wavefrontPenalty +
          farAheadPenalty +
          sideSwitchPenalty;
      }

      if (
        cost < bestCost - 1e-9 ||
        (
          Math.abs(cost - bestCost) <= 1e-9 &&
          (candidateAlong < bestAlong - 1e-9 || (Math.abs(candidateAlong - bestAlong) <= 1e-9 && candidateOriginalIndex < bestOriginalIndex))
        )
      ) {
        bestCost = cost;
        bestIndex = item.index;
        bestAlong = candidateAlong;
        bestOriginalIndex = candidateOriginalIndex;
      }
    }

    route.push(remaining.splice(bestIndex, 1)[0]);
  }

  if (endId && end) route.push(end);
  return route;
}
function buildVectorOrder(points: PilePoint[], settings: NumberingSettings) {
  if (points.length <= 1) return points;
  const byId = new Map(points.map((p) => [p.id, p]));
  let path = compactWorldPath(settings.vectorPath ?? [], 10);

  if (path.length < 2) {
    const start = settings.startPointId ? byId.get(settings.startPointId) : null;
    const end = settings.endPointId ? byId.get(settings.endPointId) : null;
    if (start && end && start.id !== end.id) {
      path = [{ x: start.x, y: start.y }, { x: end.x, y: end.y }];
    } else {
      const rowsFallback = buildRowsColumnsOrder(points, settings, 'rows');
      path = [rowsFallback[0], rowsFallback[rowsFallback.length - 1]].filter(Boolean).map((p) => ({ x: p.x, y: p.y }));
    }
  }

  if (path.length < 2) return points;

  const { lengths, prefix } = makeVectorPathMeasures(path);
  const safeMaxDistance = Number.isFinite(settings.maxDistanceToPath)
    ? Math.max(0, settings.maxDistanceToPath)
    : Number.POSITIVE_INFINITY;

  const scores = points.map((point, originalIndex) => scorePointOnVectorPath(point, originalIndex, path, lengths, prefix, safeMaxDistance));

  // Вектор — это не просто сортировка по проекции. Порядок строится как
  // nearest-neighbor внутри движущегося окна вдоль нарисованной линии: линия задаёт
  // общую волну маршрута, а ближайшие локальные точки не остаются забытым хвостом.
  return buildVectorNearestRoute(points, settings, scores);
}

function buildNumberingOrder(points: PilePoint[], settings: NumberingSettings) {
  const method = settings.method;
  let route: PilePoint[];
  if (method === 'columns') route = buildRowsColumnsOrder(points, settings, 'columns');
  else if (method === 'route') route = buildRouteOrder(points, settings);
  else if (method === 'vector') route = buildVectorOrder(points, settings);
  else route = buildRowsColumnsOrder(points, settings, 'rows');

  return applyManualLinksToRoute(applyStartEndPreference(route, settings), settings.manualLinks, settings.endPointId);
}

function numberRouteWithNext(points: PilePoint[], route: PilePoint[], settings: NumberingSettings) {
  let value = settings.startNumber;
  const numberById = new Map<string, number>();
  for (const point of route) {
    if (point.manualNumber) {
      if (typeof point.number === 'number' && Number.isFinite(point.number)) value = point.number + settings.step;
      continue;
    }
    if (point.locked) continue;
    numberById.set(point.id, value);
    value += settings.step;
  }
  return {
    points: points.map((point) => numberById.has(point.id) ? { ...point, number: numberById.get(point.id) ?? point.number } : point),
    nextNumber: value
  };
}

function numberRoute(points: PilePoint[], route: PilePoint[], settings: NumberingSettings) {
  return numberRouteWithNext(points, route, settings).points;
}

function nextNumberAfterLockedGroup(points: PilePoint[], group: PileGroup, currentStart: number) {
  const step = group.numbering.step || 1;
  const groupNumbers = points
    .filter((point) => point.groupId === group.id && typeof point.number === 'number' && Number.isFinite(point.number))
    .map((point) => point.number as number);
  if (groupNumbers.length === 0) return currentStart;
  return Math.max(currentStart, Math.max(...groupNumbers) + step);
}

function clusterPrefixedNumber(prefix: number, localNumber: number) {
  const cleanPrefix = Math.max(1, Math.floor(Math.abs(prefix || 1)));
  const cleanLocal = Math.max(0, Math.floor(Math.abs(localNumber || 0)));
  return Number(`${cleanPrefix}${cleanLocal}`);
}

function isClusterGroup(group: PileGroup) {
  return Boolean(group.meta?.clusterNumbering);
}

function clusterPrefixForGroup(group: PileGroup) {
  const value = Number(group.meta?.clusterPrefix ?? group.order ?? 1);
  return Number.isFinite(value) && value > 0 ? value : group.order || 1;
}

function applyNumberingToGroup(points: PilePoint[], group: PileGroup, startNumber?: number, previousEndPoint?: Pick<PilePoint, 'x' | 'y'> | null) {
  const groupPoints = points.filter((p) => p.groupId === group.id);
  const cluster = isClusterGroup(group);
  const baseSettings = cluster
    ? { ...group.numbering, startNumber: 1 }
    : typeof startNumber === 'number'
      ? { ...group.numbering, startNumber }
      : group.numbering;
  const { route, settings } = buildOrderWithContinuity(groupPoints, baseSettings, previousEndPoint);
  const numbered = numberRouteWithNext(points, route, settings);
  const clusterPrefix = clusterPrefixForGroup(group);
  const finalPoints = cluster
    ? numbered.points.map((point) => (
      point.groupId === group.id && !point.manualNumber && typeof point.number === 'number' && Number.isFinite(point.number)
        ? {
          ...point,
          number: clusterPrefixedNumber(clusterPrefix, point.number),
          meta: { ...(point.meta ?? {}), clusterPrefix, clusterLocalNumber: point.number }
        }
        : point
    ))
    : numbered.points;
  return {
    points: finalPoints,
    numberedCount: route.filter((p) => !p.locked && !p.manualNumber).length,
    nextNumber: cluster ? (typeof startNumber === 'number' ? startNumber : group.numbering.startNumber) : numbered.nextNumber,
    routeIds: route.map((p) => p.id),
    route,
    effectiveSettings: settings
  };
}


function isManualLinkTargetAllowed(project: PileProject, group: PileGroup, fromId: string, toId: string) {
  if (!fromId || !toId || fromId === toId) return false;
  const source = project.points.find((p) => p.id === fromId);
  const target = project.points.find((p) => p.id === toId);
  if (!source || !target || source.groupId !== group.id || target.groupId !== group.id) return false;

  const groupPoints = project.points.filter((p) => p.groupId === group.id);
  const linksWithoutCurrentSource = (group.numbering.manualLinks ?? []).filter((link) => link.fromId !== fromId);
  const route = buildNumberingOrder(groupPoints, { ...group.numbering, manualLinks: linksWithoutCurrentSource });
  const fromIndex = route.findIndex((p) => p.id === fromId);
  const toIndex = route.findIndex((p) => p.id === toId);

  // Ручная связь управляет только конечной точкой текущего ребра.
  // Нельзя цепляться назад по уже построенному маршруту — это быстро создаёт петли
  // и ломает предыдущий участок нумерации.
  return fromIndex >= 0 && toIndex > fromIndex;
}


function getValidManualLinksForGroup(project: PileProject, group: PileGroup | null | undefined) {
  if (!group) return [] as NumberingManualLink[];
  const pointGroupById = new Map(project.points.map((point) => [point.id, point.groupId ?? null]));
  const seen = new Set<string>();
  const links: NumberingManualLink[] = [];
  for (const link of group.numbering.manualLinks ?? []) {
    if (!link.fromId || !link.toId || link.fromId === link.toId) continue;
    if (pointGroupById.get(link.fromId) !== group.id || pointGroupById.get(link.toId) !== group.id) continue;
    const key = `${link.fromId}->${link.toId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(link);
  }
  return links;
}

function manualLinkKey(link: Pick<NumberingManualLink, 'fromId' | 'toId'>) {
  return `${link.fromId}->${link.toId}`;
}

function parseWorldPointList(value: unknown): Point2D[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const raw = item as { x?: unknown; y?: unknown };
      const x = Number(raw.x);
      const y = Number(raw.y);
      return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
    })
    .filter((point): point is Point2D => Boolean(point));
}

function compactWorldPath(points: Point2D[], minDistance = 25) {
  const clean = parseWorldPointList(points);
  if (clean.length <= 2) return clean;
  const result: Point2D[] = [];
  for (const point of clean) {
    const prev = result[result.length - 1];
    if (!prev || pointDistance(prev, point) >= minDistance) {
      result.push({
        x: Math.round(point.x * 100) / 100,
        y: Math.round(point.y * 100) / 100
      });
    }
  }
  const last = clean[clean.length - 1];
  const currentLast = result[result.length - 1];
  if (last && (!currentLast || pointDistance(last, currentLast) > 1e-6)) {
    result.push({
      x: Math.round(last.x * 100) / 100,
      y: Math.round(last.y * 100) / 100
    });
  }
  return result;
}

function pointToSegmentDistance(point: Point2D, a: Point2D, b: Point2D) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 <= 1e-9) return pointDistance(point, a);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / len2));
  return pointDistance(point, { x: a.x + dx * t, y: a.y + dy * t });
}

function simplifyWorldPathForEditing(points: Point2D[], epsilon = 350) {
  const clean = compactWorldPath(points, 40);
  if (clean.length <= 2) return clean;

  const keep = new Set<number>([0, clean.length - 1]);
  const simplifyRange = (start: number, end: number) => {
    if (end <= start + 1) return;
    let maxDistance = -1;
    let maxIndex = -1;
    for (let index = start + 1; index < end; index += 1) {
      const distance = pointToSegmentDistance(clean[index], clean[start], clean[end]);
      if (distance > maxDistance) {
        maxDistance = distance;
        maxIndex = index;
      }
    }
    if (maxIndex >= 0 && maxDistance > epsilon) {
      keep.add(maxIndex);
      simplifyRange(start, maxIndex);
      simplifyRange(maxIndex, end);
    }
  };

  simplifyRange(0, clean.length - 1);
  return Array.from(keep)
    .sort((a, b) => a - b)
    .map((index) => clean[index]);
}

interface Snapshot {
  project: PileProject;
  selectedPointIds: string[];
  selectedGroupId: string | null;
  selectedPipelineId: string | null;
}

export type EditingTool = 'create' | 'move' | 'copy' | 'props' | null;
export type EditPointPickMode = 'copy_base' | 'copy_target' | 'props_source' | 'props_target' | null;

interface ProjectState {
  project: PileProject;
  selectedPointIds: string[];
  selectedGroupId: string | null;
  selectedPipelineId: string | null;
  groupManagerVisible: boolean;
  groupManagerDock: GroupManagerDock;
  groupManagerCollapsed: boolean;
  autoAssignSelection: boolean;
  collapsedGroupIds: string[];
  journalVisible: boolean;
  pointInfoVisible: boolean;
  editingPanelVisible: boolean;
  editingTool: EditingTool;
  editPointPickMode: EditPointPickMode;
  copyBasePoint: Point2D | null;
  copyBasePointId: string | null;
  propertySourcePointId: string | null;
  numberingPreview: NumberingPreviewState;
  numberingPickMode: NumberingPickMode;
  numberingLinkFromId: string | null;
  numberingLinkToId: string | null;
  manualLinkClearMode: boolean;
  manualLinkClearSelection: string[];
  groupOutlineDrawMode: boolean;
  groupOutlineDraft: Point2D[];
  vectorPathDrawMode: boolean;
  vectorPathEditMode: boolean;
  vectorPathDraft: Point2D[];
  history: Snapshot[];
  redoStack: Snapshot[];
  journalSnapshots: Record<string, Snapshot>;
  settingsHoverTarget: string | null;

  pushHistory: () => void;
  recordOperation: (type: string, payload?: Record<string, unknown>) => void;
  undo: () => void;
  redo: () => void;

  hydrateUserConfig: (config: UserConfigPayload) => void;
  setProject: (project: PileProject) => void;
  openProjectFromFile: (project: PileProject, fileName: string) => void;
  startNewProjectFromImport: (fileName: string, points: PilePoint[]) => void;
  createNewProject: (name?: string) => void;
  appendImportedPoints: (fileName: string, points: PilePoint[]) => void;
  setProjectLocalFileName: (fileName: string | null, name?: string) => void;
  setProjectName: (name: string) => void;
  setPoints: (points: PilePoint[]) => void;
  setSelection: (ids: string[]) => void;
  togglePointSelection: (id: string, additive: boolean, subtractive: boolean) => void;
  setSelectedGroup: (groupId: string | null) => void;
  setSelectedPipeline: (pipelineId: string | null) => void;
  createPipeline: () => void;
  updatePipelineName: (pipelineId: string, name: string) => void;
  deletePipeline: (pipelineId: string) => void;
  updateGroupPipeline: (groupId: string, pipelineId: string) => void;
  toggleGroupManager: () => void;
  setGroupManagerDock: (dock: GroupManagerDock) => void;
  toggleGroupManagerCollapsed: () => void;
  toggleAutoAssignSelection: () => void;
  toggleGroupCollapsed: (groupId: string) => void;
  collapseAllGroups: () => void;
  expandAllGroups: () => void;
  toggleJournal: () => void;
  clearJournal: () => void;
  restoreFromJournal: (operationId: string) => void;
  togglePointInfo: () => void;

  openEditingTool: (tool: Exclude<EditingTool, null>) => void;
  closeEditingPanel: () => void;
  setEditPointPickMode: (mode: EditPointPickMode) => void;
  setCopyBasePoint: (point: Point2D | null, pointId?: string | null) => void;
  setPropertySourcePointId: (pointId: string | null) => void;
  handleCanvasEditPoint: (point: Point2D, pointId?: string | null) => void;
  createPointAt: (x: number, y: number, groupId?: string | null) => void;
  deleteSelectedPoints: () => void;
  moveSelectedPoints: (dx: number, dy: number) => void;
  copySelectedPoints: (dx: number, dy: number, keepSourceSelection?: boolean) => void;
  copyGroupProperty: (sourcePointId: string, targetPointId: string) => void;
  copyGroupPropertyToTargets: (sourcePointId: string, targetPointIds: string[]) => void;

  buildNumberingPreview: () => void;
  toggleNumberingPreview: () => void;
  clearNumberingPreview: () => void;
  cancelNumberingPreview: () => void;
  cancelNumberingLinkSelection: () => boolean;
  setNumberingPickMode: (mode: NumberingPickMode) => void;
  setNumberingPreviewMode: (mode: NumberingPreviewDisplayMode) => void;
  startNumberingManualLinkEdit: (fromId: string, toId?: string | null) => void;
  startManualLinkClearMode: () => void;
  cancelManualLinkClearMode: () => void;
  setManualLinkClearSelection: (keys: string[]) => void;
  toggleManualLinkClearSelection: (key: string) => void;
  clearNumberingManualLinks: () => void;
  clearSelectedNumberingManualLinks: () => void;
  deleteSelectedNumberingManualLink: () => boolean;
  handleNumberingPickPoint: (pointId: string) => void;

  startGroupOutlineDrawing: (groupId?: string | null) => void;
  cancelGroupOutlineDrawing: () => void;
  addGroupOutlineDraftPoint: (point: Point2D) => void;
  closeGroupOutlineDrawing: () => void;
  clearGroupManualOutline: (groupId: string) => void;

  startVectorPathDrawing: (groupId?: string | null) => void;
  cancelVectorPathDrawing: () => void;
  addVectorPathDraftPoint: (point: Point2D) => void;
  undoLastVectorPathDraftPoint: () => void;
  finishVectorPathDrawing: () => void;
  startVectorPathEdit: (groupId?: string | null) => void;
  cancelVectorPathEdit: () => void;
  updateVectorPathPoint: (groupId: string, index: number, point: Point2D) => void;
  insertVectorPathPoint: (groupId: string, index: number, point: Point2D) => void;
  deleteVectorPathPoint: (groupId: string, index: number) => void;
  clearVectorPath: (groupId?: string | null) => void;

  createGroup: () => void;
  deleteGroup: (groupId: string) => void;
  updateGroupColor: (groupId: string, color: string) => void;
  updateGroupName: (groupId: string, name: string) => void;
  updateGroupMeta: (groupId: string, patch: Record<string, unknown>) => void;
  toggleGroupLocked: (groupId: string) => void;
  updateGroupNumbering: (groupId: string, patch: Partial<NumberingSettings>) => void;
  moveGroup: (groupId: string, direction: -1 | 1) => void;
  assignSelectionToGroup: () => void;
  assignPointIdsToGroup: (ids: string[], groupId?: string | null) => void;
  autoClusterEditablePoints: () => void;

  toggleGrid: () => void;
  setBackground: (color: string) => void;
  updateViewSettings: (patch: Partial<PileProject['viewSettings']>) => void;
  updateGridSettings: (patch: Partial<GridSettings>) => void;
  updatePointNumberLabelOffset: (pointId: string, offset: Point2D | null) => void;
  setPointManualNumber: (pointId: string, number: number) => void;
  clearPointManualNumber: (pointId: string) => void;
  clearManualNumbersForGroup: (groupId: string) => void;
  setSettingsHoverTarget: (target: string | null) => void;
  updateView: (zoom: number, panX: number, panY: number) => void;
  zoomExtents: (width: number, height: number) => void;

  applyRowsNumbering: () => Promise<void>;
  applyRowsNumberingAll: () => Promise<void>;
}

const startupConfig = loadUserConfig();
const startupProject = applyUserConfigToEmptyProject(createEmptyProject(), startupConfig);

export const useProjectStore = create<ProjectState>((set, get) => ({
  project: startupProject,
  selectedPointIds: [],
  selectedGroupId: null,
  selectedPipelineId: startupProject.pipelines[0]?.id ?? null,
  groupManagerVisible: startupConfig.groupManagerVisible ?? true,
  groupManagerDock: normalizeDock(startupConfig.groupManagerDock) ?? 'floating',
  groupManagerCollapsed: startupConfig.groupManagerCollapsed ?? false,
  autoAssignSelection: startupConfig.autoAssignSelection ?? true,
  collapsedGroupIds: startupConfig.collapsedGroupIds ?? [],
  journalVisible: false,
  pointInfoVisible: false,
  editingPanelVisible: false,
  editingTool: null,
  editPointPickMode: null,
  copyBasePoint: null,
  copyBasePointId: null,
  propertySourcePointId: null,
  numberingPreview: EMPTY_NUMBERING_PREVIEW,
  numberingPickMode: null,
  numberingLinkFromId: null,
  numberingLinkToId: null,
  manualLinkClearMode: false,
  manualLinkClearSelection: [],
  groupOutlineDrawMode: false,
  groupOutlineDraft: [],
  vectorPathDrawMode: false,
  vectorPathEditMode: false,
  vectorPathDraft: [],
  history: [],
  redoStack: [],
  journalSnapshots: {},
  settingsHoverTarget: null,

  hydrateUserConfig: (config) => {
    set((state) => ({
      project: applyUserConfigToEmptyProject(state.project, config as UserConfig),
      groupManagerVisible: typeof config.groupManagerVisible === 'boolean' ? config.groupManagerVisible : state.groupManagerVisible,
      groupManagerDock: normalizeDock(config.groupManagerDock) ?? state.groupManagerDock,
      groupManagerCollapsed: typeof config.groupManagerCollapsed === 'boolean' ? config.groupManagerCollapsed : state.groupManagerCollapsed,
      autoAssignSelection: typeof config.autoAssignSelection === 'boolean' ? config.autoAssignSelection : state.autoAssignSelection,
      collapsedGroupIds: Array.isArray(config.collapsedGroupIds) ? config.collapsedGroupIds : state.collapsedGroupIds
    }));
  },

  pushHistory: () => {
    const { project, selectedPointIds, selectedGroupId, selectedPipelineId } = get();
    set((state) => ({
      history: [...state.history, { project: structuredClone(project), selectedPointIds: [...selectedPointIds], selectedGroupId, selectedPipelineId }].slice(-80),
      redoStack: []
    }));
  },

  recordOperation: (type, payload = {}) => {
    const op = makeOperation(type, payload);
    set((state) => {
      const updatedProject: PileProject = {
        ...state.project,
        operations: [...state.project.operations, op].slice(-300),
        project: { ...state.project.project, updatedAt: new Date().toISOString() }
      };
      return {
        project: updatedProject,
        journalSnapshots: {
          ...state.journalSnapshots,
          [op.id]: {
            project: structuredClone(updatedProject),
            selectedPointIds: [...state.selectedPointIds],
            selectedGroupId: state.selectedGroupId,
            selectedPipelineId: state.selectedPipelineId
          }
        }
      };
    });
  },

  undo: () => {
    const { history, project, selectedPointIds, selectedGroupId, selectedPipelineId } = get();
    const previous = history[history.length - 1];
    if (!previous) return;
    set({
      project: previous.project,
      selectedPointIds: previous.selectedPointIds,
      selectedGroupId: previous.selectedGroupId,
      selectedPipelineId: previous.selectedPipelineId,
      history: history.slice(0, -1),
      redoStack: [...get().redoStack, { project: structuredClone(project), selectedPointIds: [...selectedPointIds], selectedGroupId, selectedPipelineId }]
    });
  },

  redo: () => {
    const { redoStack, project, selectedPointIds, selectedGroupId, selectedPipelineId } = get();
    const next = redoStack[redoStack.length - 1];
    if (!next) return;
    set({
      project: next.project,
      selectedPointIds: next.selectedPointIds,
      selectedGroupId: next.selectedGroupId,
      selectedPipelineId: next.selectedPipelineId,
      redoStack: redoStack.slice(0, -1),
      history: [...get().history, { project: structuredClone(project), selectedPointIds: [...selectedPointIds], selectedGroupId, selectedPipelineId }]
    });
  },

  setProject: (project) => {
    const normalized = normalizeProject(project, get().project);
    const selectedGroup = normalized.groups[0] ?? null;
    set({ project: normalized, selectedPointIds: [], selectedGroupId: selectedGroup?.id ?? null, selectedPipelineId: selectedGroup?.pipelineId ?? normalized.pipelines[0]?.id ?? null });
    get().recordOperation('project_opened', { name: normalized.project.name, points: normalized.points.length, groups: normalized.groups.length, fileName: normalized.project.fileName ?? null });
  },

  openProjectFromFile: (project, fileName) => {
    const normalized = normalizeProject({
      ...project,
      project: {
        ...project.project,
        fileName: project.project.fileName ?? fileName,
        sourceFileName: project.project.sourceFileName ?? fileName,
        name: project.project.name && project.project.name !== 'Untitled project' ? project.project.name : fileBaseName(fileName)
      }
    }, get().project);
    const selectedGroup = normalized.groups[0] ?? null;
    set({ project: normalized, selectedPointIds: [], selectedGroupId: selectedGroup?.id ?? null, selectedPipelineId: selectedGroup?.pipelineId ?? normalized.pipelines[0]?.id ?? null });
    get().recordOperation('project_opened', { name: normalized.project.name, points: normalized.points.length, groups: normalized.groups.length, fileName });
  },

  startNewProjectFromImport: (fileName, points) => {
    get().pushHistory();
    const current = get().project;
    const empty = createEmptyProject();
    const projectName = fileBaseName(fileName);
    const nextProject: PileProject = {
      ...empty,
      project: {
        ...empty.project,
        name: projectName,
        fileName: null,
        sourceFileName: fileName
      },
      points,
      groups: [],
      numberingMode: current.numberingMode,
      gridSettings: current.gridSettings,
      viewSettings: {
        ...current.viewSettings,
        zoom: empty.viewSettings.zoom,
        panX: empty.viewSettings.panX,
        panY: empty.viewSettings.panY
      },
      operations: []
    };
    set({ project: nextProject, selectedPointIds: [], selectedGroupId: null, selectedPipelineId: nextProject.pipelines[0]?.id ?? null, collapsedGroupIds: [] });
    get().recordOperation('csv_imported', { points: points.length, sourceFileName: fileName, name: projectName });
  },


  createNewProject: (name) => {
    get().pushHistory();
    const current = get().project;
    const empty = createEmptyProject();
    const cleanName = (name || 'Новый проект').trim() || 'Новый проект';
    const nextProject: PileProject = {
      ...empty,
      project: {
        ...empty.project,
        name: cleanName,
        fileName: null,
        sourceFileName: null
      },
      numberingMode: current.numberingMode,
      gridSettings: current.gridSettings,
      viewSettings: current.viewSettings,
      operations: []
    };
    set({ project: nextProject, selectedPointIds: [], selectedGroupId: null, selectedPipelineId: nextProject.pipelines[0]?.id ?? null, collapsedGroupIds: [] });
    get().recordOperation('project_created', { name: cleanName });
  },

  appendImportedPoints: (fileName, points) => {
    if (!points.length) return;
    get().pushHistory();
    set((state) => ({
      project: {
        ...state.project,
        points: [...state.project.points, ...points],
        project: {
          ...state.project.project,
          sourceFileName: state.project.project.sourceFileName ?? fileName,
          updatedAt: new Date().toISOString()
        }
      },
      selectedPointIds: points.map((p) => p.id)
    }));
    get().recordOperation('csv_appended', { points: points.length, sourceFileName: fileName });
  },

  setProjectLocalFileName: (fileName, name) => {
    set((state) => ({
      project: withProjectFileMeta(state.project, {
        fileName,
        name: name ?? state.project.project.name
      })
    }));
  },

  setProjectName: (name) => {
    set((state) => ({ project: withProjectFileMeta(state.project, { name }) }));
  },

  setPoints: (points) => {
    get().pushHistory();
    set((state) => ({ project: withSanitizedNumberingRefs({ ...state.project, points }), selectedPointIds: [] }));
    get().recordOperation('csv_imported', { points: points.length });
  },

  setSelection: (ids) => set({ selectedPointIds: ids }),

  togglePointSelection: (id, additive, subtractive) => {
    const current = get().selectedPointIds;
    if (subtractive) {
      set({ selectedPointIds: current.filter((x) => x !== id) });
      return;
    }
    if (additive) {
      set({ selectedPointIds: current.includes(id) ? current : [...current, id] });
      return;
    }
    set({ selectedPointIds: [id] });
  },

  setSelectedGroup: (groupId) => {
    const wasPreviewVisible = get().numberingPreview.visible;
    const group = groupId ? get().project.groups.find((item) => item.id === groupId) : null;
    set({
      selectedGroupId: groupId,
      selectedPipelineId: group ? groupPipelineId(group, get().project) : get().selectedPipelineId,
      numberingPickMode: null,
      numberingLinkFromId: null,
      numberingLinkToId: null
    });
    if (wasPreviewVisible) get().buildNumberingPreview();
  },

  setSelectedPipeline: (pipelineId) => {
    const project = get().project;
    const resolvedPipelineId = pipelineId && project.pipelines.some((pipeline) => pipeline.id === pipelineId)
      ? pipelineId
      : defaultPipelineId(project);
    const currentGroup = project.groups.find((group) => group.id === get().selectedGroupId);
    const currentStillVisible = currentGroup && groupPipelineId(currentGroup, project) === resolvedPipelineId;
    const nextGroup = currentStillVisible ? currentGroup : firstGroupInPipeline(project, resolvedPipelineId);
    set({
      selectedPipelineId: resolvedPipelineId,
      selectedGroupId: nextGroup?.id ?? null,
      numberingPickMode: null,
      numberingLinkFromId: null,
      numberingLinkToId: null,
      manualLinkClearMode: false,
      manualLinkClearSelection: []
    });
    if (get().numberingPreview.visible) get().buildNumberingPreview();
  },

  createPipeline: () => {
    const project = get().project;
    const nextPipeline = makePipeline(project.pipelines.length + 1);
    get().pushHistory();
    set((state) => ({
      project: {
        ...state.project,
        pipelines: [...state.project.pipelines, nextPipeline],
        project: { ...state.project.project, updatedAt: new Date().toISOString() }
      },
      selectedPipelineId: nextPipeline.id,
      selectedGroupId: null
    }));
    get().recordOperation('pipeline_created', { pipelineId: nextPipeline.id, name: nextPipeline.name });
  },

  updatePipelineName: (pipelineId, name) => {
    const cleanName = name.trim() || 'Пайплайн';
    set((state) => ({
      project: {
        ...state.project,
        pipelines: state.project.pipelines.map((pipeline) => pipeline.id === pipelineId ? { ...pipeline, name: cleanName } : pipeline),
        project: { ...state.project.project, updatedAt: new Date().toISOString() }
      }
    }));
  },

  deletePipeline: (pipelineId) => {
    const project = get().project;
    if (project.pipelines.length <= 1) return;
    const deleted = project.pipelines.find((pipeline) => pipeline.id === pipelineId);
    if (!deleted) return;
    const fallback = project.pipelines.filter((pipeline) => pipeline.id !== pipelineId).sort((a, b) => a.order - b.order)[0];
    if (!fallback) return;
    get().pushHistory();
    const pipelines = normalizePipelines(project.pipelines.filter((pipeline) => pipeline.id !== pipelineId));
    const groups = normalizeGroupOrderWithinPipelines(
      project.groups.map((group) => groupPipelineId(group, project) === pipelineId ? { ...group, pipelineId: fallback.id } : group),
      pipelines
    );
    set((state) => ({
      project: { ...state.project, pipelines, groups, project: { ...state.project.project, updatedAt: new Date().toISOString() } },
      selectedPipelineId: fallback.id,
      selectedGroupId: firstGroupInPipeline({ ...state.project, pipelines, groups }, fallback.id)?.id ?? null
    }));
    get().recordOperation('pipeline_deleted', { pipelineId, name: deleted.name, movedToPipelineId: fallback.id });
  },

  updateGroupPipeline: (groupId, pipelineId) => {
    const project = get().project;
    const group = project.groups.find((item) => item.id === groupId);
    if (!group || group.locked || !project.pipelines.some((pipeline) => pipeline.id === pipelineId)) return;
    const nextOrder = sortedGroupsForPipeline(project, pipelineId).length + 1;
    get().pushHistory();
    const groups = normalizeGroupOrderWithinPipelines(
      project.groups.map((item) => item.id === groupId ? { ...item, pipelineId, order: nextOrder } : item),
      project.pipelines
    );
    set((state) => ({
      project: { ...state.project, groups, project: { ...state.project.project, updatedAt: new Date().toISOString() } },
      selectedPipelineId: pipelineId,
      selectedGroupId: groupId
    }));
    get().recordOperation('group_pipeline_changed', { groupId, groupName: group.name, pipelineId });
    if (get().numberingPreview.visible) get().buildNumberingPreview();
  },
  toggleGroupManager: () => set((state) => ({ groupManagerVisible: !state.groupManagerVisible, groupManagerCollapsed: false })),
  setGroupManagerDock: (dock) => set({ groupManagerDock: dock, groupManagerVisible: true }),
  toggleGroupManagerCollapsed: () => set((state) => ({ groupManagerCollapsed: !state.groupManagerCollapsed, groupManagerVisible: true })),
  toggleAutoAssignSelection: () => set((state) => ({ autoAssignSelection: !state.autoAssignSelection })),
  toggleGroupCollapsed: (groupId) => {
    set((state) => ({
      collapsedGroupIds: state.collapsedGroupIds.includes(groupId)
        ? state.collapsedGroupIds.filter((id) => id !== groupId)
        : [...state.collapsedGroupIds, groupId]
    }));
  },
  collapseAllGroups: () => set((state) => ({ collapsedGroupIds: state.project.groups.map((g) => g.id) })),
  expandAllGroups: () => set({ collapsedGroupIds: [] }),
  toggleJournal: () => set((state) => ({ journalVisible: !state.journalVisible })),
  clearJournal: () => {
    set((state) => ({
      project: { ...state.project, operations: [] },
      journalSnapshots: {}
    }));
  },
  restoreFromJournal: (operationId) => {
    const snapshot = get().journalSnapshots[operationId];
    if (!snapshot) return;
    const { project, selectedPointIds, selectedGroupId, selectedPipelineId } = get();
    set((state) => ({
      project: { ...structuredClone(snapshot.project), operations: state.project.operations },
      selectedPointIds: [...snapshot.selectedPointIds],
      selectedGroupId: snapshot.selectedGroupId,
      selectedPipelineId: snapshot.selectedPipelineId,
      history: [...state.history, { project: structuredClone(project), selectedPointIds: [...selectedPointIds], selectedGroupId, selectedPipelineId }].slice(-80),
      redoStack: []
    }));
  },
  togglePointInfo: () => set((state) => ({
    pointInfoVisible: !state.pointInfoVisible,
    editingPanelVisible: false,
    editingTool: null,
    editPointPickMode: null,
    copyBasePoint: null,
    copyBasePointId: null,
    propertySourcePointId: null,
    numberingPickMode: null,
    numberingLinkFromId: null
  })),

  openEditingTool: (tool) => set((state) => ({
    editingPanelVisible: true,
    editingTool: tool,
    pointInfoVisible: tool === 'create' || tool === 'move' || tool === 'copy' || tool === 'props' ? false : state.pointInfoVisible,
    editPointPickMode: tool === 'props' ? 'props_source' : null,
    copyBasePoint: null,
    copyBasePointId: null,
    propertySourcePointId: null,
    selectedPointIds: tool === 'props' ? [] : state.selectedPointIds
  })),

  closeEditingPanel: () => set({
    editingPanelVisible: false,
    editingTool: null,
    editPointPickMode: null,
    copyBasePoint: null,
    copyBasePointId: null,
    propertySourcePointId: null
  }),

  setEditPointPickMode: (mode) => set({ editPointPickMode: mode }),

  setCopyBasePoint: (point, pointId = null) => set({ copyBasePoint: point, copyBasePointId: point ? pointId ?? null : null }),

  setPropertySourcePointId: (pointId) => set({ propertySourcePointId: pointId }),

  handleCanvasEditPoint: (point, pointId) => {
    const { editPointPickMode, copyBasePoint, propertySourcePointId } = get();

    // Для базовой точки / точки вставки принимаем только существующие точки,
    // чтобы случайный клик по пустому полю не запускал копирование.
    if (editPointPickMode === 'copy_base') {
      if (!pointId) return;
      set({ copyBasePoint: point, copyBasePointId: pointId, editPointPickMode: 'copy_target' });
      return;
    }

    if (editPointPickMode === 'copy_target') {
      if (!pointId) return;
      if (!copyBasePoint) {
        set({ copyBasePoint: point, copyBasePointId: pointId, editPointPickMode: 'copy_target' });
        return;
      }
      get().copySelectedPoints(point.x - copyBasePoint.x, point.y - copyBasePoint.y, true);
      set({ editPointPickMode: 'copy_target' });
      return;
    }

    if (editPointPickMode === 'props_source') {
      if (!pointId) return;
      set({ propertySourcePointId: pointId, editPointPickMode: 'props_target', selectedPointIds: [pointId] });
      return;
    }

    if (editPointPickMode === 'props_target') {
      if (!pointId || !propertySourcePointId) return;
      const { selectedPointIds } = get();
      const selectedTargets = selectedPointIds.filter((id) => id !== propertySourcePointId);
      const targetIds = selectedTargets.length > 1 || selectedTargets.includes(pointId)
        ? selectedTargets
        : [pointId];
      get().copyGroupPropertyToTargets(propertySourcePointId, targetIds);
      set({ editPointPickMode: 'props_target' });
    }
  },

  createPointAt: (x, y, groupId) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;

    const { selectedGroupId, project } = get();
    const fallbackActiveGroupId = selectedGroupId ?? project.groups[0]?.id ?? null;
    const requestedGroupId = groupId === undefined ? fallbackActiveGroupId : groupId;
    const targetGroup = requestedGroupId ? project.groups.find((g) => g.id === requestedGroupId) : null;
    const targetGroupId = targetGroup?.locked ? null : requestedGroupId;
    const point: PilePoint = {
      id: crypto.randomUUID(),
      sourceId: null,
      x,
      y,
      sourceNumber: null,
      number: null,
      groupId: targetGroupId ?? null,
      locked: false,
      manualNumber: false,
      syncState: 'added',
      meta: { createdBy: 'manual' }
    };

    get().pushHistory();
    set((state) => ({
      project: {
        ...state.project,
        points: [...state.project.points, point],
        project: { ...state.project.project, updatedAt: new Date().toISOString() }
      },
      selectedPointIds: [point.id],
      selectedGroupId: targetGroupId ?? state.selectedGroupId
    }));
    get().recordOperation('point_created', { pointId: point.id, x, y, groupId: targetGroupId ?? null });
  },

  deleteSelectedPoints: () => {
    const { selectedPointIds, project } = get();
    if (selectedPointIds.length === 0) return;

    const idsSet = new Set(selectedPointIds);
    const lockedGroups = new Set(project.groups.filter((g) => g.locked).map((g) => g.id));
    const deletedPoints = project.points.filter((p) => idsSet.has(p.id) && (!p.groupId || !lockedGroups.has(p.groupId)));
    if (deletedPoints.length === 0) return;
    const deletableIds = new Set(deletedPoints.map((p) => p.id));

    get().pushHistory();
    set((state) => ({
      project: {
        ...state.project,
        ...withSanitizedNumberingRefs({
          ...state.project,
          points: state.project.points.filter((p) => !deletableIds.has(p.id)),
          project: { ...state.project.project, updatedAt: new Date().toISOString() }
        })
      },
      selectedPointIds: []
    }));
    get().recordOperation('points_deleted', { points: deletedPoints.length });
  },

  moveSelectedPoints: (dx, dy) => {
    const { selectedPointIds } = get();
    if (selectedPointIds.length === 0) return;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    if (Math.abs(dx) <= 1e-12 && Math.abs(dy) <= 1e-12) return;

    const lockedGroups = new Set(get().project.groups.filter((g) => g.locked).map((g) => g.id));
    const movableIds = selectedPointIds.filter((id) => {
      const point = get().project.points.find((p) => p.id === id);
      return point && (!point.groupId || !lockedGroups.has(point.groupId));
    });
    if (movableIds.length === 0) return;
    const idsSet = new Set(movableIds);
    get().pushHistory();
    set((state) => ({
      project: {
        ...state.project,
        points: state.project.points.map((p) => (
          idsSet.has(p.id)
            ? { ...p, x: p.x + dx, y: p.y + dy, syncState: p.syncState === 'added' ? 'added' : 'moved' }
            : p
        )),
        project: { ...state.project.project, updatedAt: new Date().toISOString() }
      }
    }));
    get().recordOperation('points_moved', { points: movableIds.length, dx, dy });
  },

  copySelectedPoints: (dx, dy, keepSourceSelection = false) => {
    const { selectedPointIds, project } = get();
    if (selectedPointIds.length === 0) return;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    if (Math.abs(dx) <= 1e-12 && Math.abs(dy) <= 1e-12) return;

    const lockedGroups = new Set(project.groups.filter((g) => g.locked).map((g) => g.id));
    const sourceSelectedIds = selectedPointIds.filter((id) => {
      const point = project.points.find((p) => p.id === id);
      return point && (!point.groupId || !lockedGroups.has(point.groupId));
    });
    const idsSet = new Set(sourceSelectedIds);
    const sourcePoints = project.points.filter((p) => idsSet.has(p.id));
    if (sourcePoints.length === 0) return;

    const copiedPoints: PilePoint[] = sourcePoints.map((p) => ({
      ...p,
      id: crypto.randomUUID(),
      sourceId: null,
      sourceNumber: null,
      number: null,
      groupId: p.groupId ?? null,
      x: p.x + dx,
      y: p.y + dy,
      locked: false,
      manualNumber: false,
      syncState: 'added',
      meta: { ...(p.meta ?? {}), copiedFrom: p.id }
    }));

    get().pushHistory();
    set((state) => ({
      project: {
        ...state.project,
        points: [...state.project.points, ...copiedPoints],
        project: { ...state.project.project, updatedAt: new Date().toISOString() }
      },
      selectedPointIds: keepSourceSelection ? sourceSelectedIds : copiedPoints.map((p) => p.id),
      selectedGroupId: keepSourceSelection ? state.selectedGroupId : copiedPoints[0]?.groupId ?? state.selectedGroupId
    }));
    get().recordOperation('points_copied', { points: copiedPoints.length, dx, dy });
  },

  copyGroupProperty: (sourcePointId, targetPointId) => {
    get().copyGroupPropertyToTargets(sourcePointId, [targetPointId]);
  },

  copyGroupPropertyToTargets: (sourcePointId, targetPointIds) => {
    if (!sourcePointId || targetPointIds.length === 0) return;

    const { project } = get();
    const sourcePoint = project.points.find((p) => p.id === sourcePointId);
    if (!sourcePoint) return;

    const uniqueTargetIds = Array.from(new Set(targetPointIds)).filter((id) => id && id !== sourcePointId);
    if (uniqueTargetIds.length === 0) return;

    const existingTargetIds = new Set(project.points.map((p) => p.id));
    const targetIds = uniqueTargetIds.filter((id) => existingTargetIds.has(id));
    if (targetIds.length === 0) return;

    const nextGroupId = sourcePoint.groupId ?? null;
    const targetSet = new Set(targetIds);

    get().pushHistory();
    set((state) => ({
      project: {
        ...state.project,
        ...withSanitizedNumberingRefs({
          ...state.project,
          points: state.project.points.map((p) => (
            targetSet.has(p.id) ? { ...p, groupId: nextGroupId } : p
          )),
          project: { ...state.project.project, updatedAt: new Date().toISOString() }
        })
      },
      selectedPointIds: targetIds,
      selectedGroupId: nextGroupId ?? state.selectedGroupId
    }));
    get().recordOperation('point_group_properties_copied', {
      sourcePointId,
      targetPointIds: targetIds,
      targets: targetIds.length,
      groupId: nextGroupId
    });
  },

  buildNumberingPreview: () => {
    const { project, selectedGroupId, selectedPipelineId } = get();
    const group = findFirstNonEmptyGroup(project, selectedGroupId, selectedPipelineId);
    if (!group) {
      set({ numberingPreview: EMPTY_NUMBERING_PREVIEW });
      return;
    }

    const groupPoints = project.points.filter((p) => p.groupId === group.id);
    if (groupPoints.length === 0) {
      set({ numberingPreview: EMPTY_NUMBERING_PREVIEW });
      return;
    }

    const { route } = buildPreviewOrderForGroup(project, group);
    if (route.length === 0) {
      set({ numberingPreview: EMPTY_NUMBERING_PREVIEW });
      return;
    }

    set({
      selectedGroupId: group.id,
      selectedPipelineId: groupPipelineId(group, project),
      numberingPreview: {
        visible: true,
        groupId: group.id,
        routePointIds: route.map((p) => p.id),
        method: group.numbering.method,
        displayMode: get().numberingPreview.displayMode ?? 'animated',
        generatedAt: Date.now()
      }
    });
  },

  toggleNumberingPreview: () => {
    const preview = get().numberingPreview;
    if (preview.visible) {
      set({ numberingPreview: { ...preview, visible: false } });
      return;
    }
    get().buildNumberingPreview();
  },

  clearNumberingPreview: () => set({ numberingPreview: EMPTY_NUMBERING_PREVIEW }),

  cancelNumberingPreview: () => set({ numberingPreview: EMPTY_NUMBERING_PREVIEW, numberingPickMode: null, numberingLinkFromId: null, numberingLinkToId: null, manualLinkClearMode: false, manualLinkClearSelection: [] }),

  cancelNumberingLinkSelection: () => {
    const { numberingPickMode, numberingLinkFromId, numberingLinkToId, manualLinkClearMode } = get();
    if (!numberingPickMode && !numberingLinkFromId && !numberingLinkToId && !manualLinkClearMode) return false;
    set({
      numberingPickMode: null,
      numberingLinkFromId: null,
      numberingLinkToId: null,
      manualLinkClearMode: false,
      manualLinkClearSelection: [],
      selectedPointIds: []
    });
    return true;
  },

  setNumberingPickMode: (mode) => set({
    numberingPickMode: mode,
    numberingLinkFromId: null,
    numberingLinkToId: null,
    manualLinkClearMode: false,
    manualLinkClearSelection: [],
    selectedPointIds: []
  }),

  handleNumberingPickPoint: (pointId) => {
    const { numberingPickMode, numberingLinkFromId, selectedGroupId, project } = get();
    if (!numberingPickMode || !pointId) return;
    const point = project.points.find((p) => p.id === pointId);

    if (numberingPickMode === 'manual_link_target') {
      if (!numberingLinkFromId || !point || point.id === numberingLinkFromId) return;
      const sourcePoint = project.points.find((p) => p.id === numberingLinkFromId);
      const groupId = selectedGroupId ?? sourcePoint?.groupId ?? point.groupId ?? project.groups[0]?.id ?? null;
      if (!groupId || sourcePoint?.groupId !== groupId || point.groupId !== groupId) return;

      const group = project.groups.find((g) => g.id === groupId);
      if (group?.locked) return;
      if (!group || !isManualLinkTargetAllowed(project, group, numberingLinkFromId, point.id)) {
        set({ selectedPointIds: numberingLinkFromId ? [numberingLinkFromId] : [] });
        return;
      }

      const existingLinks = group.numbering.manualLinks ?? [];
      const previous = existingLinks.find((link) => link.fromId === numberingLinkFromId);
      const manualLinks = [
        ...existingLinks.filter((link) => link.fromId !== numberingLinkFromId && link.toId !== point.id),
        { fromId: numberingLinkFromId, toId: point.id }
      ];
      get().pushHistory();
      get().updateGroupNumbering(groupId, { manualLinks });
      set({
        selectedPointIds: [numberingLinkFromId, point.id],
        selectedGroupId: groupId,
        numberingPickMode: null,
        numberingLinkFromId: null,
        numberingLinkToId: null,
        manualLinkClearMode: false,
        manualLinkClearSelection: [],
        vectorPathDrawMode: false,
        vectorPathDraft: []
      });
      get().recordOperation('numbering_manual_link_set', { groupId, fromId: numberingLinkFromId, toId: point.id, previousToId: previous?.toId ?? null });
      get().buildNumberingPreview();
      set({
        selectedPointIds: [numberingLinkFromId, point.id],
        selectedGroupId: groupId,
        numberingPickMode: null,
        numberingLinkFromId: null,
        numberingLinkToId: null,
        manualLinkClearMode: false,
        manualLinkClearSelection: []
      });
      return;
    }

    if (!point) return;
    const groupId = selectedGroupId ?? point.groupId ?? project.groups[0]?.id ?? null;
    const group = groupId ? project.groups.find((g) => g.id === groupId) : null;
    if (!groupId || point.groupId !== groupId || group?.locked) return;
    const patch = numberingPickMode === 'group_start' ? { startPointId: pointId } : { endPointId: pointId };
    get().updateGroupNumbering(groupId, patch);
    set({ selectedPointIds: [pointId], selectedGroupId: groupId, numberingPickMode: null, numberingLinkFromId: null, numberingLinkToId: null });
    get().buildNumberingPreview();
  },

  setNumberingPreviewMode: (mode) => {
    const preview = get().numberingPreview;
    const selectedGroupId = get().selectedGroupId;
    if (preview.visible && preview.displayMode === mode && (!selectedGroupId || preview.groupId === selectedGroupId)) {
      // v50: скрываем траекторию, но сохраняем routePointIds.
      // Маркеры «Старт авто/Финиш авто» должны продолжать опираться на
      // фактический последний рассчитанный маршрут, а не на грубую сортировку
      // по координатам после выключения показа пути.
      set({ numberingPreview: { ...preview, visible: false } });
      return;
    }
    if (preview.routePointIds.length === 0 || (selectedGroupId && preview.groupId !== selectedGroupId)) {
      get().buildNumberingPreview();
      const builtPreview = get().numberingPreview;
      if (!builtPreview.visible || builtPreview.routePointIds.length === 0) {
        set({ numberingPreview: EMPTY_NUMBERING_PREVIEW });
        return;
      }
      set({ numberingPreview: { ...builtPreview, visible: true, displayMode: mode, generatedAt: Date.now() } });
      return;
    }
    const shouldRestartAnimation = mode === 'animated' && preview.displayMode !== 'paused';
    set({ numberingPreview: { ...preview, visible: true, displayMode: mode, generatedAt: shouldRestartAnimation ? Date.now() : preview.generatedAt } });
  },

  startNumberingManualLinkEdit: (fromId, toId = null) => {
    const { project, selectedGroupId, numberingPreview } = get();
    const point = project.points.find((p) => p.id === fromId);
    const groupId = selectedGroupId ?? point?.groupId ?? null;
    if (!point || !groupId || point.groupId !== groupId) return;

    const group = project.groups.find((g) => g.id === groupId);
    if (group?.locked) return;

    let resolvedToId = toId;
    if (!resolvedToId) {
      const manualTo = project.groups.find((g) => g.id === groupId)?.numbering.manualLinks?.find((link) => link.fromId === fromId)?.toId ?? null;
      const route = numberingPreview.groupId === groupId ? numberingPreview.routePointIds : [];
      const index = route.findIndex((id) => id === fromId);
      resolvedToId = manualTo ?? (index >= 0 ? route[index + 1] ?? null : null);
    }

    set({
      numberingPickMode: 'manual_link_target',
      numberingLinkFromId: fromId,
      numberingLinkToId: resolvedToId,
      selectedPointIds: resolvedToId ? [fromId, resolvedToId] : [fromId],
      selectedGroupId: groupId
    });
  },

  startManualLinkClearMode: () => {
    const { project, selectedGroupId } = get();
    const group = project.groups.find((g) => g.id === selectedGroupId) ?? project.groups[0] ?? null;
    const links = getValidManualLinksForGroup(project, group);
    const keys = links.map(manualLinkKey);
    set({
      manualLinkClearMode: true,
      manualLinkClearSelection: keys,
      numberingPickMode: null,
      numberingLinkFromId: null,
      numberingLinkToId: null,
      selectedGroupId: group?.id ?? selectedGroupId
    });
    if (group && links.length > 0) {
      get().buildNumberingPreview();
      const preview = get().numberingPreview;
      if (preview.visible) {
        set({ numberingPreview: { ...preview, visible: true, displayMode: 'full', generatedAt: Date.now() } });
      }
    }
  },

  cancelManualLinkClearMode: () => set({ manualLinkClearMode: false, manualLinkClearSelection: [] }),

  setManualLinkClearSelection: (keys) => {
    const unique = Array.from(new Set(keys));
    set({ manualLinkClearSelection: unique });
  },

  toggleManualLinkClearSelection: (key) => {
    set((state) => ({
      manualLinkClearSelection: state.manualLinkClearSelection.includes(key)
        ? state.manualLinkClearSelection.filter((item) => item !== key)
        : [...state.manualLinkClearSelection, key]
    }));
  },

  clearSelectedNumberingManualLinks: () => {
    const { project, selectedGroupId, manualLinkClearSelection, manualLinkClearMode } = get();
    const group = project.groups.find((g) => g.id === selectedGroupId) ?? project.groups[0];
    if (!group) return;
    const validLinks = getValidManualLinksForGroup(project, group);
    const selected = manualLinkClearMode
      ? new Set(manualLinkClearSelection)
      : new Set(validLinks.map(manualLinkKey));
    const removeKeys = validLinks.map(manualLinkKey).filter((key) => selected.has(key));
    if (removeKeys.length === 0) {
      set({ manualLinkClearMode: false, manualLinkClearSelection: [], numberingPickMode: null, numberingLinkFromId: null, numberingLinkToId: null });
      return;
    }
    const removeSet = new Set(removeKeys);
    const existing = group.numbering.manualLinks ?? [];
    get().pushHistory();
    get().updateGroupNumbering(group.id, { manualLinks: existing.filter((link) => !removeSet.has(manualLinkKey(link))) });
    set({ manualLinkClearMode: false, manualLinkClearSelection: [], numberingPickMode: null, numberingLinkFromId: null, numberingLinkToId: null });
    get().recordOperation('numbering_manual_links_cleared', { groupId: group.id, groupName: group.name, removed: removeKeys.length, selectedOnly: manualLinkClearMode });
    get().buildNumberingPreview();
  },

  clearNumberingManualLinks: () => {
    get().clearSelectedNumberingManualLinks();
  },

  startGroupOutlineDrawing: (groupId) => {
    const resolvedGroupId = groupId ?? get().selectedGroupId ?? get().project.groups[0]?.id ?? null;
    if (!resolvedGroupId) return;
    const group = get().project.groups.find((g) => g.id === resolvedGroupId);
    if (!group || group.locked) return;
    set({
      selectedGroupId: resolvedGroupId,
      groupOutlineDrawMode: true,
      groupOutlineDraft: [],
      vectorPathDrawMode: false,
      vectorPathDraft: [],
      numberingPickMode: null,
      numberingLinkFromId: null,
      numberingLinkToId: null,
      manualLinkClearMode: false,
      manualLinkClearSelection: []
    });
  },

  cancelGroupOutlineDrawing: () => set({ groupOutlineDrawMode: false, groupOutlineDraft: [] }),

  addGroupOutlineDraftPoint: (point) => {
    if (!get().groupOutlineDrawMode) return;
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    set((state) => ({ groupOutlineDraft: [...state.groupOutlineDraft, { x: Math.round(point.x * 100) / 100, y: Math.round(point.y * 100) / 100 }] }));
  },

  closeGroupOutlineDrawing: () => {
    const { project, selectedGroupId, groupOutlineDraft } = get();
    const group = selectedGroupId ? project.groups.find((g) => g.id === selectedGroupId) : null;
    if (!group || group.locked || groupOutlineDraft.length < 3) {
      set({ groupOutlineDrawMode: false, groupOutlineDraft: [] });
      return;
    }
    get().pushHistory();
    set((state) => ({
      project: {
        ...state.project,
        groups: state.project.groups.map((g) => g.id === group.id ? { ...g, meta: { ...(g.meta ?? {}), manualOutline: groupOutlineDraft } } : g),
        project: { ...state.project.project, updatedAt: new Date().toISOString() }
      },
      groupOutlineDrawMode: false,
      groupOutlineDraft: []
    }));
    get().recordOperation('group_manual_outline_set', { groupId: group.id, groupName: group.name, vertices: groupOutlineDraft.length });
  },

  clearGroupManualOutline: (groupId) => {
    const group = get().project.groups.find((g) => g.id === groupId);
    if (!group || group.locked) return;
    const meta = { ...(group.meta ?? {}) };
    if (!('manualOutline' in meta)) return;
    delete meta.manualOutline;
    get().pushHistory();
    set((state) => ({
      project: {
        ...state.project,
        groups: state.project.groups.map((g) => g.id === groupId ? { ...g, meta } : g),
        project: { ...state.project.project, updatedAt: new Date().toISOString() }
      }
    }));
    get().recordOperation('group_manual_outline_cleared', { groupId, groupName: group.name });
  },

  startVectorPathDrawing: (groupId) => {
    const resolvedGroupId = groupId ?? get().selectedGroupId ?? get().project.groups[0]?.id ?? null;
    if (!resolvedGroupId) return;
    const group = get().project.groups.find((g) => g.id === resolvedGroupId);
    if (!group || group.locked) return;
    set({
      selectedGroupId: resolvedGroupId,
      vectorPathDrawMode: true,
      vectorPathEditMode: false,
      vectorPathDraft: [],
      groupOutlineDrawMode: false,
      groupOutlineDraft: [],
      numberingPickMode: null,
      numberingLinkFromId: null,
      numberingLinkToId: null,
      manualLinkClearMode: false,
      manualLinkClearSelection: []
    });
  },

  cancelVectorPathDrawing: () => set({ vectorPathDrawMode: false, vectorPathDraft: [] }),

  addVectorPathDraftPoint: (point) => {
    if (!get().vectorPathDrawMode) return;
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    const nextPoint = { x: Math.round(point.x * 100) / 100, y: Math.round(point.y * 100) / 100 };
    set((state) => {
      const prev = state.vectorPathDraft[state.vectorPathDraft.length - 1];
      // v61: вектор больше не кисть с сотнями промежуточных точек.
      // Это CAD-полилиния из характерных вершин/сегментов.
      if (prev && pointDistance(prev, nextPoint) < 1) return state;
      return { vectorPathDraft: [...state.vectorPathDraft, nextPoint] };
    });
  },

  undoLastVectorPathDraftPoint: () => {
    if (!get().vectorPathDrawMode) return;
    set((state) => ({ vectorPathDraft: state.vectorPathDraft.slice(0, -1) }));
  },

  finishVectorPathDrawing: () => {
    const { project, selectedGroupId, vectorPathDraft } = get();
    const group = selectedGroupId ? project.groups.find((g) => g.id === selectedGroupId) : null;
    const vectorPath = compactWorldPath(vectorPathDraft, 1);
    if (!group || group.locked || vectorPath.length < 2) {
      set({ vectorPathDrawMode: false, vectorPathDraft: [] });
      return;
    }

    get().pushHistory();
    set((state) => ({
      project: {
        ...state.project,
        groups: state.project.groups.map((g) => g.id === group.id
          ? { ...g, numbering: { ...g.numbering, method: 'vector', vectorPath } }
          : g
        ),
        project: { ...state.project.project, updatedAt: new Date().toISOString() }
      },
      vectorPathDrawMode: false,
      vectorPathEditMode: true,
      vectorPathDraft: [],
      selectedGroupId: group.id
    }));
    get().recordOperation('group_vector_path_set', { groupId: group.id, groupName: group.name, points: vectorPath.length });
    if (get().numberingPreview.visible && get().numberingPreview.groupId === group.id) get().buildNumberingPreview();
  },

  startVectorPathEdit: (groupId) => {
    const resolvedGroupId = groupId ?? get().selectedGroupId ?? null;
    if (!resolvedGroupId) return;
    const group = get().project.groups.find((g) => g.id === resolvedGroupId);
    if (!group || group.locked || (group.numbering.vectorPath ?? []).length < 2) return;
    const sourcePath = group.numbering.vectorPath ?? [];
    if (sourcePath.length > 24) {
      // v62: старые кисточные векторы из v60/v61 могли содержать сотни точек.
      // Перед редактированием превращаем их в CAD-полилинию из характерных вершин,
      // иначе на поле появляется облако маркеров и всё становится нечитаемым.
      const xs = sourcePath.map((point) => point.x);
      const ys = sourcePath.map((point) => point.y);
      const diagonal = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
      const epsilon = Math.max(250, Math.min(1200, diagonal * 0.006));
      const simplified = simplifyWorldPathForEditing(sourcePath, epsilon);
      if (simplified.length >= 2 && simplified.length < sourcePath.length) {
        get().pushHistory();
        set((state) => ({
          project: {
            ...state.project,
            groups: state.project.groups.map((g) => g.id === resolvedGroupId ? { ...g, numbering: { ...g.numbering, vectorPath: simplified } } : g),
            project: { ...state.project.project, updatedAt: new Date().toISOString() }
          }
        }));
      }
    }
    set({
      selectedGroupId: resolvedGroupId,
      vectorPathEditMode: true,
      vectorPathDrawMode: false,
      vectorPathDraft: [],
      groupOutlineDrawMode: false,
      groupOutlineDraft: [],
      numberingPickMode: null,
      numberingLinkFromId: null,
      numberingLinkToId: null,
      manualLinkClearMode: false,
      manualLinkClearSelection: [],
      selectedPointIds: []
    });
  },

  cancelVectorPathEdit: () => set({ vectorPathEditMode: false }),

  updateVectorPathPoint: (groupId, index, point) => {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    set((state) => ({
      project: {
        ...state.project,
        groups: state.project.groups.map((g) => {
          if (g.id !== groupId || g.locked) return g;
          const vectorPath = [...(g.numbering.vectorPath ?? [])];
          if (index < 0 || index >= vectorPath.length) return g;
          vectorPath[index] = { x: Math.round(point.x * 100) / 100, y: Math.round(point.y * 100) / 100 };
          return { ...g, numbering: { ...g.numbering, vectorPath } };
        }),
        project: { ...state.project.project, updatedAt: new Date().toISOString() }
      }
    }));
  },

  insertVectorPathPoint: (groupId, index, point) => {
    const group = get().project.groups.find((g) => g.id === groupId);
    if (!group || group.locked || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    const source = [...(group.numbering.vectorPath ?? [])];
    const safeIndex = Math.max(0, Math.min(index, source.length));
    const nextPoint = { x: Math.round(point.x * 100) / 100, y: Math.round(point.y * 100) / 100 };
    get().pushHistory();
    set((state) => ({
      project: {
        ...state.project,
        groups: state.project.groups.map((g) => g.id === groupId
          ? { ...g, numbering: { ...g.numbering, vectorPath: [...source.slice(0, safeIndex), nextPoint, ...source.slice(safeIndex)] } }
          : g
        ),
        project: { ...state.project.project, updatedAt: new Date().toISOString() }
      },
      vectorPathEditMode: true,
      selectedGroupId: groupId
    }));
    get().recordOperation('group_vector_path_point_inserted', { groupId, groupName: group.name, index: safeIndex + 1 });
    if (get().numberingPreview.visible && get().numberingPreview.groupId === groupId) get().buildNumberingPreview();
  },

  deleteVectorPathPoint: (groupId, index) => {
    const group = get().project.groups.find((g) => g.id === groupId);
    if (!group || group.locked) return;
    const source = [...(group.numbering.vectorPath ?? [])];
    if (source.length <= 2 || index < 0 || index >= source.length) return;
    get().pushHistory();
    source.splice(index, 1);
    set((state) => ({
      project: {
        ...state.project,
        groups: state.project.groups.map((g) => g.id === groupId ? { ...g, numbering: { ...g.numbering, vectorPath: source } } : g),
        project: { ...state.project.project, updatedAt: new Date().toISOString() }
      },
      vectorPathEditMode: true,
      selectedGroupId: groupId
    }));
    get().recordOperation('group_vector_path_point_deleted', { groupId, groupName: group.name, index: index + 1 });
    if (get().numberingPreview.visible && get().numberingPreview.groupId === groupId) get().buildNumberingPreview();
  },

  clearVectorPath: (groupId) => {
    const resolvedGroupId = groupId ?? get().selectedGroupId ?? null;
    if (!resolvedGroupId) return;
    const group = get().project.groups.find((g) => g.id === resolvedGroupId);
    if (!group || group.locked) return;
    if ((group.numbering.vectorPath ?? []).length === 0) {
      set({ vectorPathDrawMode: false, vectorPathDraft: [] });
      return;
    }

    get().pushHistory();
    set((state) => ({
      project: {
        ...state.project,
        groups: state.project.groups.map((g) => g.id === group.id ? { ...g, numbering: { ...g.numbering, vectorPath: [] } } : g),
        project: { ...state.project.project, updatedAt: new Date().toISOString() }
      },
      vectorPathDrawMode: false,
      vectorPathEditMode: false,
      vectorPathDraft: [],
      selectedGroupId: group.id
    }));
    get().recordOperation('group_vector_path_cleared', { groupId: group.id, groupName: group.name });
    if (get().numberingPreview.visible && get().numberingPreview.groupId === group.id) get().buildNumberingPreview();
  },

  deleteSelectedNumberingManualLink: () => {
    const { project, selectedGroupId, numberingLinkFromId, numberingLinkToId } = get();
    if (!numberingLinkFromId) return false;
    const groupId = selectedGroupId ?? project.points.find((p) => p.id === numberingLinkFromId)?.groupId ?? null;
    const group = groupId ? project.groups.find((g) => g.id === groupId) : null;
    if (!group) {
      set({ numberingPickMode: null, numberingLinkFromId: null, numberingLinkToId: null, selectedPointIds: [] });
      return true;
    }

    const existing = group.numbering.manualLinks ?? [];
    const link = existing.find((item) => item.fromId === numberingLinkFromId && (!numberingLinkToId || item.toId === numberingLinkToId))
      ?? existing.find((item) => item.fromId === numberingLinkFromId);

    // Если выбрана автоматическая стрелка, Delete не должен удалять точки.
    // Просто снимаем выбор стрелки и оставляем предпросмотр как есть.
    if (!link) {
      set({ numberingPickMode: null, numberingLinkFromId: null, numberingLinkToId: null, selectedPointIds: [] });
      return true;
    }

    get().pushHistory();
    get().updateGroupNumbering(group.id, { manualLinks: existing.filter((item) => !(item.fromId === link.fromId && item.toId === link.toId)) });
    set({ selectedPointIds: [link.fromId], selectedGroupId: group.id, numberingPickMode: null, numberingLinkFromId: null, numberingLinkToId: null });
    get().recordOperation('numbering_manual_link_deleted', { groupId: group.id, groupName: group.name, fromId: link.fromId, toId: link.toId });
    get().buildNumberingPreview();
    return true;
  },

  createGroup: () => {
    get().pushHistory();
    const project = get().project;
    const pipelineId = get().selectedPipelineId ?? defaultPipelineId(project);
    const currentGroups = project.groups;
    const orderInPipeline = sortedGroupsForPipeline(project, pipelineId).length + 1;
    const group = makeGroup(orderInPipeline, currentGroups, pipelineId);
    set((state) => ({
      project: {
        ...state.project,
        groups: normalizeGroupOrderWithinPipelines([...state.project.groups, group], state.project.pipelines),
        project: { ...state.project.project, updatedAt: new Date().toISOString() }
      },
      selectedPipelineId: pipelineId,
      selectedGroupId: group.id,
      groupManagerVisible: true,
      groupManagerCollapsed: false
    }));
    get().recordOperation('group_created', { groupId: group.id, name: group.name, pipelineId });
  },

  deleteGroup: (groupId) => {
    const deleted = get().project.groups.find((g) => g.id === groupId);
    if (!deleted || deleted.locked) return;
    const pipelineId = groupPipelineId(deleted, get().project);
    get().pushHistory();
    set((state) => {
      const groups = normalizeGroupOrderWithinPipelines(state.project.groups.filter((g) => g.id !== groupId), state.project.pipelines);
      const points = state.project.points.map((p) => (p.groupId === groupId ? { ...p, groupId: null } : p));
      const nextGroup = sortedGroupsForPipeline({ ...state.project, groups }, pipelineId)[0] ?? state.project.groups.find((g) => g.id !== groupId) ?? null;
      return {
        project: withSanitizedNumberingRefs({ ...state.project, groups, points }),
        selectedPipelineId: nextGroup ? groupPipelineId(nextGroup, state.project) : state.selectedPipelineId,
        selectedGroupId: nextGroup?.id ?? null,
        collapsedGroupIds: state.collapsedGroupIds.filter((id) => id !== groupId)
      };
    });
    get().recordOperation('group_deleted', { groupId, name: deleted?.name, pipelineId });
  },

  updateGroupColor: (groupId, color) => {
    set((state) => ({
      project: { ...state.project, groups: state.project.groups.map((g) => (g.id === groupId ? { ...g, color } : g)) }
    }));
  },

  updateGroupName: (groupId, name) => {
    set((state) => ({
      project: { ...state.project, groups: state.project.groups.map((g) => (g.id === groupId ? { ...g, name } : g)) }
    }));
  },

  updateGroupMeta: (groupId, patch) => {
    set((state) => ({
      project: {
        ...state.project,
        groups: state.project.groups.map((g) => (g.id === groupId ? { ...g, meta: { ...(g.meta ?? {}), ...patch } } : g)),
        project: { ...state.project.project, updatedAt: new Date().toISOString() }
      }
    }));
  },

  toggleGroupLocked: (groupId) => {
    const group = get().project.groups.find((g) => g.id === groupId);
    if (!group) return;
    get().pushHistory();
    set((state) => ({
      project: {
        ...state.project,
        groups: state.project.groups.map((g) => (g.id === groupId ? { ...g, locked: !g.locked } : g)),
        project: { ...state.project.project, updatedAt: new Date().toISOString() }
      }
    }));
    get().recordOperation(group.locked ? 'group_unlocked' : 'group_locked', { groupId, groupName: group.name });
  },

  updateGroupNumbering: (groupId, patch) => {
    if (get().project.groups.find((g) => g.id === groupId)?.locked) return;
    set((state) => ({
      project: {
        ...state.project,
        groups: state.project.groups.map((g) => (g.id === groupId ? { ...g, numbering: { ...g.numbering, ...patch } } : g))
      }
    }));
    if (get().numberingPreview.visible && get().numberingPreview.groupId === groupId) get().buildNumberingPreview();
  },

  moveGroup: (groupId, direction) => {
    const project = get().project;
    const group = project.groups.find((g) => g.id === groupId);
    if (!group) return;
    const pipelineId = groupPipelineId(group, project);
    const groupsByOrder = sortedGroupsForPipeline(project, pipelineId);
    const index = groupsByOrder.findIndex((g) => g.id === groupId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= groupsByOrder.length) return;

    get().pushHistory();
    [groupsByOrder[index], groupsByOrder[target]] = [groupsByOrder[target], groupsByOrder[index]];
    const reorderedInPipeline = reindexGroupOrderAndNames(groupsByOrder);
    const patchedById = new Map(reorderedInPipeline.map((item) => [item.id, item]));
    const groups = normalizeGroupOrderWithinPipelines(project.groups.map((item) => patchedById.get(item.id) ?? item), project.pipelines);
    set((state) => ({
      project: { ...state.project, groups, project: { ...state.project.project, updatedAt: new Date().toISOString() } },
      selectedPipelineId: pipelineId,
      selectedGroupId: groupId
    }));
    get().recordOperation('group_order_changed', { groupId, direction, order: target + 1, pipelineId });
    if (get().numberingPreview.visible) get().buildNumberingPreview();
  },

  assignPointIdsToGroup: (ids, groupId) => {
    const targetGroupId = groupId ?? get().selectedGroupId;
    if (!targetGroupId || ids.length === 0) return;
    const state = get();
    const targetGroup = state.project.groups.find((g) => g.id === targetGroupId);
    if (targetGroup?.locked) return;
    const lockedGroups = new Set(state.project.groups.filter((g) => g.locked).map((g) => g.id));
    const allowedIds = ids.filter((id) => {
      const point = state.project.points.find((p) => p.id === id);
      return point && (!point.groupId || !lockedGroups.has(point.groupId));
    });
    if (allowedIds.length === 0) return;
    const idsSet = new Set(allowedIds);
    get().pushHistory();
    set((state) => ({
      project: {
        ...state.project,
        ...withSanitizedNumberingRefs({
          ...state.project,
          points: state.project.points.map((p) => (idsSet.has(p.id) ? { ...p, groupId: targetGroupId } : p)),
          project: { ...state.project.project, updatedAt: new Date().toISOString() }
        })
      },
      selectedPipelineId: targetGroup ? groupPipelineId(targetGroup, state.project) : state.selectedPipelineId
    }));
    get().recordOperation('points_assigned_to_group', { groupId: targetGroupId, points: allowedIds.length, pipelineId: targetGroup ? groupPipelineId(targetGroup, state.project) : null });
  },

  assignSelectionToGroup: () => {
    const { selectedGroupId, selectedPointIds } = get();
    get().assignPointIdsToGroup(selectedPointIds, selectedGroupId);
  },

  autoClusterEditablePoints: () => {
    const { project, selectedPointIds, selectedPipelineId } = get();
    if (project.points.length < 2) return;

    const lockedGroupIds = new Set(project.groups.filter((group) => group.locked).map((group) => group.id));
    const isEditablePoint = (point: PilePoint) => !point.groupId || !lockedGroupIds.has(point.groupId);
    const selectedSet = new Set(selectedPointIds);
    const selectedCandidates = project.points.filter((point) => selectedSet.has(point.id) && isEditablePoint(point));
    const candidates = selectedCandidates.length >= 2 ? selectedCandidates : project.points.filter(isEditablePoint);
    if (candidates.length < 2) return;

    const pipelineId = selectedPipelineId && project.pipelines.some((pipeline) => pipeline.id === selectedPipelineId)
      ? selectedPipelineId
      : defaultPipelineId(project);
    const pipelineStart = pipelineStartNumber(project, pipelineId);
    const candidateIds = new Set(candidates.map((point) => point.id));
    const clusters = orderClustersByRoute(connectedAutoClusters(candidates));
    if (clusters.length === 0) return;

    const keepGroupIds = new Set<string>();
    for (const group of project.groups) {
      if (group.locked) keepGroupIds.add(group.id);
    }
    for (const point of project.points) {
      if (!candidateIds.has(point.id) && point.groupId) keepGroupIds.add(point.groupId);
    }

    const keptGroups = project.groups.filter((group) => keepGroupIds.has(group.id));
    const newGroups: PileGroup[] = [];
    const pointToGroupId = new Map<string, string>();

    clusters.forEach((cluster, index) => {
      const order = index + 1;
      const group: PileGroup = {
        id: crypto.randomUUID(),
        name: `Авто ${order}`,
        order: keptGroups.filter((item) => groupPipelineId(item, project) === pipelineId).length + order,
        pipelineId,
        color: makeGroupColor(order, [...keptGroups, ...newGroups]),
        visible: true,
        locked: false,
        numbering: chooseAutoNumberingForCluster(cluster, order, pipelineStart),
        meta: {
          autoClustered: true,
          autoClusterSize: cluster.length,
          autoClusterCreatedAt: new Date().toISOString()
        }
      };
      newGroups.push(group);
      cluster.forEach((point) => pointToGroupId.set(point.id, group.id));
    });

    get().pushHistory();
    const nextPoints = project.points.map((point) => (
      pointToGroupId.has(point.id)
        ? { ...point, groupId: pointToGroupId.get(point.id) ?? point.groupId, number: null, manualNumber: false, locked: false }
        : point
    ));
    const groups = normalizeGroupOrderWithinPipelines([...keptGroups, ...newGroups], project.pipelines);
    const normalizedProject = withSanitizedNumberingRefs({
      ...project,
      points: nextPoints,
      groups,
      project: { ...project.project, updatedAt: new Date().toISOString() }
    });
    const firstNewGroup = newGroups[0] ? normalizedProject.groups.find((group) => group.id === newGroups[0].id) ?? newGroups[0] : null;

    set((state) => ({
      project: normalizedProject,
      selectedPipelineId: pipelineId,
      selectedGroupId: firstNewGroup?.id ?? state.selectedGroupId,
      selectedPointIds: [],
      collapsedGroupIds: state.collapsedGroupIds.filter((id) => normalizedProject.groups.some((group) => group.id === id)),
      numberingPreview: EMPTY_NUMBERING_PREVIEW
    }));
    get().recordOperation('groups_auto_clustered', {
      pipelineId,
      clusters: newGroups.length,
      points: candidates.length,
      scope: selectedCandidates.length >= 2 ? 'selection' : 'editable_project',
      methods: newGroups.reduce<Record<string, number>>((acc, group) => {
        const method = group.numbering.method;
        acc[method] = (acc[method] ?? 0) + 1;
        return acc;
      }, {}),
      strategy: 'nearest_graph_with_dense_band_refinement'
    });
  },

  toggleGrid: () => {
    set((state) => ({ project: { ...state.project, gridSettings: { ...state.project.gridSettings, enabled: !state.project.gridSettings.enabled } } }));
    get().recordOperation('grid_toggled', { enabled: get().project.gridSettings.enabled });
  },
  setBackground: (color) => {
    set((state) => ({ project: { ...state.project, viewSettings: { ...state.project.viewSettings, backgroundColor: color } } }));
  },
  updateViewSettings: (patch) => {
    set((state) => ({ project: { ...state.project, viewSettings: { ...state.project.viewSettings, ...patch } } }));
  },
  updateGridSettings: (patch) => {
    set((state) => ({ project: { ...state.project, gridSettings: { ...state.project.gridSettings, ...patch } } }));
  },
  updatePointNumberLabelOffset: (pointId, offset) => {
    const point = get().project.points.find((p) => p.id === pointId);
    if (!point) return;
    get().pushHistory();
    set((state) => ({
      project: {
        ...state.project,
        points: state.project.points.map((p) => {
          if (p.id !== pointId) return p;
          const meta = { ...(p.meta ?? {}) };
          if (offset && Number.isFinite(offset.x) && Number.isFinite(offset.y) && (Math.abs(offset.x) > 0.5 || Math.abs(offset.y) > 0.5)) {
            meta.numberLabelOffset = { x: Math.round(offset.x * 10) / 10, y: Math.round(offset.y * 10) / 10 };
          } else {
            delete meta.numberLabelOffset;
          }
          return { ...p, meta };
        }),
        project: { ...state.project.project, updatedAt: new Date().toISOString() }
      }
    }));
    get().recordOperation('number_label_moved', { pointId, offset });
  },
  setPointManualNumber: (pointId, number) => {
    if (!Number.isFinite(number)) return;
    const point = get().project.points.find((p) => p.id === pointId);
    if (!point) return;
    const group = point.groupId ? get().project.groups.find((g) => g.id === point.groupId) : null;
    if (group?.locked) return;
    get().pushHistory();
    set((state) => ({
      project: {
        ...state.project,
        points: state.project.points.map((p) => (p.id === pointId ? { ...p, number, manualNumber: true } : p)),
        project: { ...state.project.project, updatedAt: new Date().toISOString() }
      },
      selectedPointIds: [pointId],
      selectedGroupId: point.groupId ?? state.selectedGroupId
    }));
    get().recordOperation('point_manual_number_set', { pointId, number, groupId: point.groupId ?? null });
    if (get().numberingPreview.visible && point.groupId === get().numberingPreview.groupId) get().buildNumberingPreview();
  },

  clearPointManualNumber: (pointId) => {
    const point = get().project.points.find((p) => p.id === pointId);
    if (!point || !point.manualNumber) return;
    const group = point.groupId ? get().project.groups.find((g) => g.id === point.groupId) : null;
    if (group?.locked) return;
    get().pushHistory();
    set((state) => ({
      project: {
        ...state.project,
        points: state.project.points.map((p) => (p.id === pointId ? { ...p, manualNumber: false } : p)),
        project: { ...state.project.project, updatedAt: new Date().toISOString() }
      },
      selectedPointIds: [pointId]
    }));
    get().recordOperation('point_manual_number_cleared', { pointId, groupId: point.groupId ?? null });
    if (get().numberingPreview.visible && point.groupId === get().numberingPreview.groupId) get().buildNumberingPreview();
  },

  clearManualNumbersForGroup: (groupId) => {
    const group = get().project.groups.find((g) => g.id === groupId);
    if (!group || group.locked) return;
    const points = get().project.points.filter((p) => p.groupId === groupId && p.manualNumber);
    if (points.length === 0) return;
    if (typeof window !== 'undefined' && !window.confirm(`Снять ручную фиксацию номеров в группе «${group.name}»?\n\nТочек: ${points.length}.`)) return;
    const ids = new Set(points.map((p) => p.id));
    get().pushHistory();
    set((state) => ({
      project: {
        ...state.project,
        points: state.project.points.map((p) => (ids.has(p.id) ? { ...p, manualNumber: false } : p)),
        project: { ...state.project.project, updatedAt: new Date().toISOString() }
      }
    }));
    get().recordOperation('group_manual_numbers_cleared', { groupId, groupName: group.name, points: points.length });
    if (get().numberingPreview.visible && get().numberingPreview.groupId === groupId) get().buildNumberingPreview();
  },

  setSettingsHoverTarget: (target) => set({ settingsHoverTarget: target }),
  updateView: (zoom, panX, panY) => set((state) => ({ project: { ...state.project, viewSettings: { ...state.project.viewSettings, zoom, panX, panY } } })),

  zoomExtents: (width, height) => {
    const { project } = get();
    if (!project.points.length) return;
    const xs = project.points.map((p) => p.x);
    const ys = project.points.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const contentW = Math.max(maxX - minX, 1);
    const contentH = Math.max(maxY - minY, 1);
    const zoom = Math.min((width * 0.85) / contentW, (height * 0.85) / contentH);
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    get().updateView(zoom, width / 2 - centerX * zoom, height / 2 + centerY * zoom);
  },

  applyRowsNumbering: async () => {
    const { project, selectedGroupId, selectedPipelineId } = get();
    const group = findFirstNonEmptyGroup(project, selectedGroupId, selectedPipelineId);
    if (!group || group.locked || groupPointCount(project.points, group.id) === 0) {
      set({ numberingPreview: EMPTY_NUMBERING_PREVIEW });
      return;
    }

    get().pushHistory();
    const context = resolveEffectiveGroupNumberingContext(project, group);
    const result = applyNumberingToGroup(project.points, group, context.startNumber, context.previousEndPoint);
    if (result.routeIds.length === 0) {
      set({ numberingPreview: EMPTY_NUMBERING_PREVIEW });
      return;
    }

    set((state) => ({
      project: {
        ...state.project,
        points: result.points,
        project: { ...state.project.project, updatedAt: new Date().toISOString() }
      },
      selectedGroupId: group.id,
      selectedPipelineId: groupPipelineId(group, project),
      numberingPreview: {
        visible: true,
        groupId: group.id,
        routePointIds: result.routeIds,
        method: group.numbering.method,
        displayMode: get().numberingPreview.displayMode ?? 'animated',
        generatedAt: Date.now()
      }
    }));
    get().recordOperation('group_numbered', { groupId: group.id, groupName: group.name, method: group.numbering.method });
  },

  applyRowsNumberingAll: async () => {
    const { project } = get();
    const pipelines = sortedPipelines(project);
    const allGroups = pipelines.flatMap((pipeline) => sortedGroupsForPipeline(project, pipeline.id));
    const nonEmptyUnlockedGroups = allGroups.filter((group) => !group.locked && groupPointCount(project.points, group.id) > 0);
    if (!nonEmptyUnlockedGroups.length) {
      set({ numberingPreview: EMPTY_NUMBERING_PREVIEW });
      return;
    }

    get().pushHistory();
    const originalSelectedGroupId = get().selectedGroupId;
    const originalSelectedPipelineId = get().selectedPipelineId;
    let points = project.points;
    let previewRouteIds: string[] = [];
    let previewGroup: PileGroup | null = null;
    let fallbackPreviewRouteIds: string[] = [];
    let fallbackPreviewGroup: PileGroup | null = null;

    for (const pipeline of pipelines) {
      const pipelineGroups = sortedGroupsForPipeline(project, pipeline.id);
      let currentStart = pipelineStartNumber(project, pipeline.id);
      let previousEndPoint: PilePoint | null = null;

      for (const group of pipelineGroups) {
        const groupPoints = points.filter((point) => point.groupId === group.id);
        if (groupPoints.length === 0) continue;

        const continuityAnchor = previousEndPoint;
        const routePreview = buildOrderWithContinuity(groupPoints, group.numbering, continuityAnchor);
        previousEndPoint = routePreview.route[routePreview.route.length - 1] ?? previousEndPoint;

        if (group.locked) {
          if (project.numberingMode === 'global_sequential') {
            currentStart = nextNumberAfterLockedGroup(points, group, currentStart);
          }
          continue;
        }

        const groupStart = project.numberingMode === 'global_sequential' ? currentStart : group.numbering.startNumber;
        const result = applyNumberingToGroup(points, group, groupStart, continuityAnchor);
        points = result.points;
        if (!fallbackPreviewRouteIds.length && result.routeIds.length > 0) {
          fallbackPreviewRouteIds = result.routeIds;
          fallbackPreviewGroup = group;
        }
        if (group.id === originalSelectedGroupId && result.routeIds.length > 0) {
          previewRouteIds = result.routeIds;
          previewGroup = group;
        }
        previousEndPoint = result.route[result.route.length - 1] ?? previousEndPoint;
        if (project.numberingMode === 'global_sequential') currentStart = result.nextNumber;
      }
    }

    if (!previewGroup || previewRouteIds.length === 0) {
      previewGroup = fallbackPreviewGroup;
      previewRouteIds = fallbackPreviewRouteIds;
    }

    set((state) => ({
      project: {
        ...state.project,
        points,
        project: { ...state.project.project, updatedAt: new Date().toISOString() }
      },
      // v50: команда «Нумеровать всё» не должна перескакивать на первую группу.
      // Пользователь остаётся в текущей активной группе/пайплайне, а preview
      // строится по текущей группе, если она участвовала в расчёте.
      selectedPipelineId: originalSelectedPipelineId ?? state.selectedPipelineId,
      selectedGroupId: originalSelectedGroupId ?? state.selectedGroupId,
      numberingPreview: previewGroup && previewRouteIds.length > 0 ? {
        visible: true,
        groupId: previewGroup.id,
        routePointIds: previewRouteIds,
        method: previewGroup.numbering.method,
        displayMode: get().numberingPreview.displayMode ?? 'animated',
        generatedAt: Date.now()
      } : EMPTY_NUMBERING_PREVIEW
    }));
    get().recordOperation('all_groups_numbered', { groups: nonEmptyUnlockedGroups.length, skippedEmptyGroups: allGroups.length - nonEmptyUnlockedGroups.length, pipelines: pipelines.length, mode: project.numberingMode });
  }
}));

let configSaveTimer: ReturnType<typeof setTimeout> | null = null;

useProjectStore.subscribe((state) => {
  if (configSaveTimer) clearTimeout(configSaveTimer);
  configSaveTimer = setTimeout(() => saveUserConfig(state), 250);
});