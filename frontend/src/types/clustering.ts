import type { PilePoint } from './project';

export type ClusterMethod = 'connected' | 'branches' | 'bands' | 'hdbscan' | 'dbscan' | 'optics' | 'count';
export interface ClusterOptions {
  method: ClusterMethod;
  radiusFactor: number;
  turnAngle: number;
  angle: number;
  autoAngle: boolean;
  compactSites: boolean;
  bandTolerance: number;
  minClusterSize: number;
  minSamples: number;
  xi: number;
  clusterCount: number;
}
export const CLUSTER_METHODS: { value: ClusterMethod; label: string; description: string }[] = [
  { value: 'connected', label: 'Связанные участки', description: 'Базовый метод: близкие соседи и плотные полосы. Подходит для общего разделения поля.' },
  { value: 'branches', label: 'Ветви и разрывы', description: 'Разделяет длинные связи, повороты и ответвления. Проверьте границы на пересечениях.' },
  { value: 'bands', label: 'Ряды и полосы', description: 'Группирует точки вдоль выбранного направления и разделяет пустые промежутки.' },
  { value: 'hdbscan', label: 'Плотность · HDBSCAN', description: 'Ищет скопления разной плотности. Редкие точки могут остаться без группы.' },
  { value: 'dbscan', label: 'Радиус · DBSCAN', description: 'Объединяет плотные скопления в заданном радиусе. Удобен при близком шаге свай.' },
  { value: 'optics', label: 'Плотность · OPTICS', description: 'Выделяет изменения плотности. Для выделений до 5000 точек; может потребовать больше времени.' },
  { value: 'count', label: 'Заданное число групп', description: 'Разрезает самые длинные связи дерева соседей до заданного числа групп. Число групп не гарантирует равные размеры.' }
];
export const DEFAULT_CLUSTER_OPTIONS: ClusterOptions = {
  method: 'connected', radiusFactor: 1, turnAngle: 45, angle: 0, autoAngle: true, compactSites: true,
  bandTolerance: .4, minClusterSize: 8, minSamples: 3, xi: .05, clusterCount: 7
};
export interface ClusterPreview {
  method: ClusterMethod;
  clusters: string[][];
  unassignedIds: string[];
  warnings: string[];
  step?: number;
  angle?: number | null;
  pointCount: number;
  options: ClusterOptions;
}
export interface ClusterApplication {
  result: ClusterPreview;
  sourcePoints: PilePoint[];
  pipelineId: string | null;
}
