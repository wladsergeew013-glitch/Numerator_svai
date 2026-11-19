import { createEmptyProject, defaultNumberingSettings, DIRECTION_LABELS, type PileProject, type NumberingSettings } from '../types/project';
import { assertProjectCapacity } from './projectLimits';

export function parseSafeInteger(text: string): number {
  if (!/^[+-]?\d+$/.test(text.trim())) throw new Error('Введите непустое целое число.');
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new Error('Номер выходит за безопасный целый диапазон.');
  return value;
}

function object(value: unknown, field: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field}: ожидается объект.`);
  return value as Record<string, any>;
}

function finiteJson(value: unknown, field = 'JSON', depth = 0): void {
  if (depth > 64) throw new Error(`${field}: слишком глубокая структура.`);
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`${field}: число должно быть конечным.`);
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error(`${field}: недопустимый ключ.`);
      finiteJson(child, `${field}.${key}`, depth + 1);
    }
  }
}

/** Validate provided settings before merging defaults; never coerce strings into geometry. */
export function validateSettings(value: unknown, defaults: Record<string, unknown>, field: string): void {
  const settings = object(value, field);
  for (const [key, item] of Object.entries(settings)) {
    const sample = defaults[key];
    if (sample !== undefined && sample !== null && typeof item !== typeof sample) throw new Error(`${field}.${key}: неверный тип.`);
    if (typeof item === 'number' && !Number.isFinite(item)) throw new Error(`${field}.${key}: число должно быть конечным.`);
  }
  for (const key of ['majorStep', 'minorStep', 'zoom']) {
    if (key in settings && settings[key] <= 0) throw new Error(`${field}.${key}: значение должно быть положительным.`);
  }
  if (settings.numberTextMode !== undefined && !['auto','manual'].includes(settings.numberTextMode)) throw new Error('Неверный режим текста.');
  if (settings.selectionDragMode !== undefined && !['left_add_right_subtract','left_subtract_right_add'].includes(settings.selectionDragMode)) throw new Error('Неверный режим выделения.');
  finiteJson(settings, field);
}

export function validateNumbering(settings: NumberingSettings): void {
  for (const key of ['startNumber', 'step'] as const) {
    if (!Number.isSafeInteger(settings[key]) || (key === 'step' && settings[key] === 0)) throw new Error('Начальный номер и шаг должны быть безопасными целыми; шаг не равен нулю.');
  }
  for (const key of ['rowTolerance', 'columnTolerance', 'maxDistanceToPath'] as const) {
    if (!Number.isFinite(settings[key]) || settings[key] <= 0) throw new Error('Допуски должны быть конечными положительными числами.');
  }
}

export function validateProjectPayload(payload: unknown): asserts payload is PileProject {
  const p = object(payload, 'Проект'); finiteJson(p);
  if (p.schemaVersion !== undefined && p.schemaVersion !== 1) throw new Error('Неподдерживаемая версия проекта.');
  const info = object(p.project, 'project');
  for (const key of ['id', 'name', 'units', 'createdAt', 'updatedAt']) {
    if (info[key] !== undefined && typeof info[key] !== 'string') throw new Error(`project.${key}: ожидается строка.`);
  }
  if (!info.id || typeof info.id !== 'string') throw new Error('Отсутствует project.id.');
  for (const key of ['fileName', 'sourceFileName']) if (info[key] != null && typeof info[key] !== 'string') throw new Error(`project.${key}: ожидается строка.`);
  const arrays = ['points', 'groups', 'pipelines', 'operations'];
  for (const key of arrays) if (p[key] !== undefined && !Array.isArray(p[key])) throw new Error(`${key}: ожидается массив.`);
  assertProjectCapacity(p);
  const ids = (list: any[], label: string) => {
    const result = new Set<string>();
    for (const item of list) {
      object(item, label);
      if (typeof item.id !== 'string' || !item.id || result.has(item.id)) throw new Error(`${label}: отсутствующий или повторный ID.`);
      result.add(item.id);
    }
    return result;
  };
  const points = p.points ?? [], groups = p.groups ?? [], pipelines = p.pipelines ?? [];
  const pointIds = ids(points, 'points'), groupIds = ids(groups, 'groups'), pipelineIds = ids(pipelines, 'pipelines');
  const pointGroups = new Map(points.map((pt: any) => [pt.id, pt.groupId]));
  for (const point of points) {
    if (typeof point.x !== 'number' || typeof point.y !== 'number') throw new Error(`Точка ${point.id}: X/Y должны быть числами.`);
    if (point.number != null && !Number.isSafeInteger(point.number)) throw new Error(`Точка ${point.id}: неверный номер.`);
    if (point.sourceNumber != null && !['string', 'number'].includes(typeof point.sourceNumber)) throw new Error('Неверный исходный номер.');
    if (typeof point.sourceNumber === 'number' && !Number.isSafeInteger(point.sourceNumber)) throw new Error('Небезопасный исходный номер: сохраните его строкой.');
    if (point.sourceId != null && typeof point.sourceId !== 'string') throw new Error('Неверный sourceId.');
    for (const k of ['locked', 'manualNumber']) if (point[k] !== undefined && typeof point[k] !== 'boolean') throw new Error(`Точка: неверный ${k}.`);
    if (point.syncState !== undefined && !['added', 'moved', 'deleted', 'conflict', 'unchanged'].includes(point.syncState)) throw new Error('Неверный syncState.');
    if (point.groupId != null && !groupIds.has(point.groupId)) throw new Error(`Точка ${point.id}: неизвестная группа.`);
    if (point.meta != null) object(point.meta, 'point.meta');
  }
  for (const group of groups) {
    if (typeof group.name !== 'string') throw new Error('Группа: ожидается имя.');
    for (const k of ['visible', 'locked']) if (group[k] !== undefined && typeof group[k] !== 'boolean') throw new Error(`Группа: неверный ${k}.`);
    if (group.color !== undefined && typeof group.color !== 'string') throw new Error('Группа: неверный цвет.');
    if (group.order !== undefined && !Number.isSafeInteger(group.order)) throw new Error('Группа: неверный порядок.');
    if (group.pipelineId != null && pipelines.length && !pipelineIds.has(group.pipelineId)) throw new Error('Группа: неизвестный пайплайн.');
    if (group.meta != null) object(group.meta, 'group.meta');
    if (group.meta?.manualOutline !== undefined && (!Array.isArray(group.meta.manualOutline) || group.meta.manualOutline.some((v: any) => !v || typeof v.x !== 'number' || typeof v.y !== 'number'))) throw new Error('Неверный контур группы.');
    if (group.meta?.clusterNumbering !== undefined && typeof group.meta.clusterNumbering !== 'boolean') throw new Error('Неверный режим кластера.');
    if (group.meta?.clusterPrefix !== undefined && (!Number.isSafeInteger(group.meta.clusterPrefix) || group.meta.clusterPrefix <= 0)) throw new Error('Индекс кластера должен быть положительным безопасным целым.');
    if (group.numbering !== undefined) {
      const n = object(group.numbering, 'numbering');
      validateSettings(n, defaultNumberingSettings() as unknown as Record<string, unknown>, 'numbering');
      if (n.method !== undefined && !['rows', 'columns', 'route', 'vector', 'manual'].includes(n.method)) throw new Error('Неизвестный метод нумерации.');
      if (n.direction !== undefined && !Object.prototype.hasOwnProperty.call(DIRECTION_LABELS,n.direction)) throw new Error('Неизвестное направление нумерации.');
      validateNumbering({ ...defaultNumberingSettings(), ...n });
      for (const k of ['startPointId', 'endPointId']) if (n[k] != null && (!pointIds.has(n[k]) || pointGroups.get(n[k]) !== group.id)) throw new Error(`numbering.${k}: точка другой группы.`);
      if (n.vectorPath !== undefined && (!Array.isArray(n.vectorPath) || n.vectorPath.some((v: any) => !v || typeof v.x !== 'number' || typeof v.y !== 'number'))) throw new Error('Неверный вектор.');
      if (n.manualLinks !== undefined && (!Array.isArray(n.manualLinks) || n.manualLinks.some((l: any) => !l || !pointIds.has(l.fromId) || !pointIds.has(l.toId) || pointGroups.get(l.fromId) !== group.id || pointGroups.get(l.toId) !== group.id))) throw new Error('Неверные ручные связи.');
    }
  }
  for (const pipeline of pipelines) if (typeof pipeline.name !== 'string' || !Number.isSafeInteger(pipeline.order)) throw new Error('Неверный пайплайн.');
  if (p.numberingMode !== undefined && !['global_sequential', 'per_group'].includes(p.numberingMode)) throw new Error('Неизвестный режим нумерации.');
  ids(p.operations ?? [], 'operations');
  for (const op of p.operations ?? []) {
    if (!op || typeof op.id !== 'string' || typeof op.type !== 'string' || typeof op.timestamp !== 'string') throw new Error('Неверная запись журнала.');
    if (op.payload !== undefined) object(op.payload, 'operation.payload');
  }
  const defaults = createEmptyProject();
  if (p.gridSettings !== undefined) validateSettings(p.gridSettings, { ...defaults.gridSettings }, 'gridSettings');
  if (p.viewSettings !== undefined) validateSettings(p.viewSettings, { ...defaults.viewSettings }, 'viewSettings');
}
