export type SyncState = 'unchanged' | 'added' | 'moved' | 'deleted' | 'conflict';
export type NumberingMode = 'global_sequential' | 'per_group';
export type NumberingMethod = 'rows' | 'columns' | 'route' | 'vector' | 'manual';
export type GroupManagerDock = 'left' | 'right' | 'floating';
export type NumberTextMode = 'auto' | 'manual';
export type SelectionDragMode = 'left_add_right_subtract' | 'left_subtract_right_add';
export type NumberingDirection =
  | 'left_to_right_top_to_bottom'
  | 'right_to_left_top_to_bottom'
  | 'left_to_right_bottom_to_top'
  | 'right_to_left_bottom_to_top'
  | 'snake_rows_left_top'
  | 'snake_rows_right_top'
  | 'snake_columns_top_left'
  | 'snake_columns_bottom_left';

export const CAD_BASE_COLORS = [
  { name: 'Красный', value: '#ff0000' },
  { name: 'Жёлтый', value: '#ffff00' },
  { name: 'Зелёный', value: '#00ff00' },
  { name: 'Голубой', value: '#00ffff' },
  { name: 'Синий', value: '#0000ff' },
  { name: 'Фиолетовый', value: '#ff00ff' },
  { name: 'Белый', value: '#ffffff' },
  { name: 'Серый', value: '#808080' },
  { name: 'Оранжевый', value: '#ff9900' },
  { name: 'Розовый', value: '#ff66aa' },
  { name: 'Коричневый', value: '#8b5a2b' },
  { name: 'Чёрный', value: '#000000' }
] as const;

export const SELECTION_DRAG_MODE_LABELS: Record<SelectionDragMode, string> = {
  left_add_right_subtract: 'Слева направо — добавить, справа налево — убрать',
  left_subtract_right_add: 'Слева направо — убрать, справа налево — добавить'
};

export const SELECTION_DRAG_MODE_DESCRIPTIONS: Record<SelectionDragMode, string> = {
  left_add_right_subtract: 'Классический режим: зелёная рамка при движении слева направо добавляет точки к выбору; синяя справа налево убирает из выбора.',
  left_subtract_right_add: 'Обратный режим: слева направо убирает точки из выбора; справа налево добавляет точки к выбору.'
};

export const WORKSPACE_BACKGROUND_COLORS = [
  { name: 'AutoCAD тёмный', value: '#111827' },
  { name: 'Почти чёрный', value: '#000000' },
  { name: 'Тёмно-синий', value: '#0f172a' },
  { name: 'Графит', value: '#1f2937' },
  { name: 'Серый', value: '#808080' },
  { name: 'Белый', value: '#ffffff' },
  { name: 'Светлый чертёж', value: '#f8fafc' },
  { name: 'Тёплый светлый', value: '#f5f0e6' },
  { name: 'Тёмно-зелёный', value: '#052e16' },
  { name: 'Тёмно-коричневый', value: '#2a1a0a' },
  { name: 'Тёмно-фиолетовый', value: '#2e1065' },
  { name: 'Тёмно-красный', value: '#450a0a' }
] as const;

export const NUMBERING_METHOD_LABELS: Record<NumberingMethod, string> = {
  rows: 'Ряды',
  columns: 'Столбцы',
  route: 'Маршрут',
  vector: 'Вектор',
  manual: 'Ручной'
};

export const NUMBERING_METHOD_DESCRIPTIONS: Record<NumberingMethod, string> = {
  rows: 'Ряды: точки сначала объединяются в горизонтальные ряды по допуску Y, затем сортируются внутри каждого ряда.',
  columns: 'Столбцы: точки сначала объединяются в вертикальные колонки по допуску X, затем сортируются внутри каждой колонки.',
  route: 'Маршрут: обход ближайших точек с опциональной оптимизацией.',
  vector: 'Вектор: CAD-полилиния из сегментов; нумерация идёт ближайшим соседом вдоль нарисованного маршрута.',
  manual: 'Ручной номер: фиксация номера отдельной точки поверх выбранного метода нумерации.'
};

export const DIRECTION_LABELS: Record<NumberingDirection, string> = {
  left_to_right_top_to_bottom: 'Ряды: слева направо, сверху вниз',
  right_to_left_top_to_bottom: 'Ряды: справа налево, сверху вниз',
  left_to_right_bottom_to_top: 'Ряды: слева направо, снизу вверх',
  right_to_left_bottom_to_top: 'Ряды: справа налево, снизу вверх',
  snake_rows_left_top: 'Ряды: змейка от левого верхнего угла',
  snake_rows_right_top: 'Ряды: змейка от правого верхнего угла',
  snake_columns_top_left: 'Столбцы: сверху вниз, слева направо',
  snake_columns_bottom_left: 'Столбцы: снизу вверх, слева направо'
};

export const DIRECTION_DESCRIPTIONS: Record<NumberingDirection, string> = {
  left_to_right_top_to_bottom: 'Начинает с верхнего ряда. В каждом ряду идёт слева направо. Затем переходит к ряду ниже.',
  right_to_left_top_to_bottom: 'Начинает с верхнего ряда. В каждом ряду идёт справа налево. Затем переходит к ряду ниже.',
  left_to_right_bottom_to_top: 'Начинает с нижнего ряда. В каждом ряду идёт слева направо. Затем поднимается выше.',
  right_to_left_bottom_to_top: 'Начинает с нижнего ряда. В каждом ряду идёт справа налево. Затем поднимается выше.',
  snake_rows_left_top: 'Начинает с верхнего левого угла: первый ряд слева направо, следующий справа налево, дальше чередует.',
  snake_rows_right_top: 'Начинает с верхнего правого угла: первый ряд справа налево, следующий слева направо, дальше чередует.',
  snake_columns_top_left: 'Начинает с левой колонки. В колонке идёт сверху вниз, следующая колонка идёт снизу вверх, дальше чередует.',
  snake_columns_bottom_left: 'Начинает с левой колонки. В колонке идёт снизу вверх, следующая колонка идёт сверху вниз, дальше чередует.'
};

export interface Point2D {
  x: number;
  y: number;
}

export interface PilePoint {
  id: string;
  sourceId?: string | null;
  x: number;
  y: number;
  sourceNumber?: string | number | null;
  number?: number | null;
  groupId?: string | null;
  locked: boolean;
  manualNumber: boolean;
  syncState: SyncState;
  meta?: Record<string, unknown>;
}

export interface NumberingManualLink {
  fromId: string;
  toId: string;
}

export interface NumberingSettings {
  method: NumberingMethod;
  startNumber: number;
  step: number;
  rowTolerance: number;
  columnTolerance: number;
  direction: NumberingDirection;
  startPointId?: string | null;
  endPointId?: string | null;
  optimize: boolean;
  vectorPath: Point2D[];
  manualLinks: NumberingManualLink[];
  maxDistanceToPath: number;
  preserveManual: boolean;
  freezeAfterManualEdit: boolean;
}

export interface PileGroup {
  id: string;
  name: string;
  order: number;
  /** Пайплайн нумерации. Старые проекты могут не иметь поля — тогда группа попадает в первый пайплайн. */
  pipelineId?: string | null;
  color: string;
  visible: boolean;
  locked: boolean;
  numbering: NumberingSettings;
  meta?: Record<string, unknown>;
}

export interface NumberingPipeline {
  id: string;
  name: string;
  order: number;
}

export interface GridSettings {
  enabled: boolean;
  axesEnabled: boolean;
  majorStep: number;
  minorStep: number;
  color: string;
  minorColor: string;
  axisColor: string;
  snap: boolean;
}

export interface ViewSettings {
  backgroundColor: string;
  zoom: number;
  panX: number;
  panY: number;
  numberTextMode: NumberTextMode;
  numberTextColor: string;
  numberTextStrokeColor: string;
  numberTextStrokeEnabled: boolean;
  numberTextStrokeWidth: number;
  numberTextFontSize: number;
  numberTextFontFamily: string;
  numberTextBrightness: number;
  numberTextBubbleEnabled: boolean;
  showPointNumbers: boolean;
  highlightUnnumbered: boolean;
  showNumberingPreview: boolean;
  showVectorPath: boolean;
  markerTextColor: string;
  markerTextStrokeColor: string;
  markerTextStrokeEnabled: boolean;
  markerTextStrokeWidth: number;
  markerTextFontSize: number;
  markerTextFontFamily: string;
  markerTextBrightness: number;
  markerTextBubbleEnabled: boolean;
  showMarkerLabels: boolean;
  groupOutlineStrokeColor: string;
  groupOutlineFillColor: string;
  groupOutlineVisible: boolean;
  groupOutlineStrokeWidth: number;
  groupOutlineDashSize: number;
  groupOutlinePadding: number;
  groupOutlineSnapPx: number;
  groupOutlineSimplifyPx: number;
  previewAutoLineColor: string;
  previewAutoArrowColor: string;
  previewManualLineColor: string;
  previewManualArrowColor: string;
  previewSelectedLineColor: string;
  previewSelectedArrowColor: string;
  previewInvalidLinkColor: string;
  previewLineWidth: number;
  previewManualLineWidth: number;
  previewSelectedLineWidth: number;
  previewPointLabelColor: string;
  previewPointLabelStrokeColor: string;
  previewPointLabelFontSize: number;
  previewPointLabelStrokeWidth: number;
  previewPointLabelBrightness: number;
  previewPointLabelBubbleEnabled: boolean;
  previewPointLabelBubbleColor: string;
  numberTextBubbleColor: string;
  numberTextBubbleStrokeColor: string;
  markerCalloutBackgroundColor: string;
  markerCalloutBorderColor: string;
  markerLeaderLineColor: string;
  selectionDragMode: SelectionDragMode;
}

export interface OperationRecord {
  id: string;
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface ProjectInfo {
  id: string;
  name: string;
  units: string;
  createdAt: string;
  updatedAt: string;
  /** Имя локального .pilenum.json в папке projects. null = проект ещё не сохранён в папку projects. */
  fileName?: string | null;
  /** Имя исходного файла, из которого создан новый проект: CSV или открытый JSON. */
  sourceFileName?: string | null;
}

export interface PileProject {
  schemaVersion: number;
  project: ProjectInfo;
  points: PilePoint[];
  groups: PileGroup[];
  pipelines: NumberingPipeline[];
  numberingMode: NumberingMode;
  gridSettings: GridSettings;
  viewSettings: ViewSettings;
  operations: OperationRecord[];
}

export interface LocalProjectInfo {
  fileName: string;
  name: string;
  updatedAt?: string | null;
  pointsCount: number;
  groupsCount: number;
}

export function defaultNumberingPipeline(order = 1): NumberingPipeline {
  return {
    id: `pipeline-${crypto.randomUUID()}`,
    name: `Пайплайн ${order}`,
    order
  };
}

export function defaultNumberingSettings(method: NumberingMethod = 'rows'): NumberingSettings {
  return {
    method,
    startNumber: 1,
    step: 1,
    rowTolerance: 250,
    columnTolerance: 250,
    direction: 'left_to_right_top_to_bottom',
    startPointId: null,
    endPointId: null,
    optimize: true,
    vectorPath: [],
    manualLinks: [],
    maxDistanceToPath: 1000,
    preserveManual: true,
    freezeAfterManualEdit: true
  };
}

export function createEmptyProject(): PileProject {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    project: {
      id: crypto.randomUUID(),
      name: 'Untitled project',
      units: 'mm',
      createdAt: now,
      updatedAt: now,
      fileName: null,
      sourceFileName: null
    },
    points: [],
    groups: [],
    pipelines: [defaultNumberingPipeline(1)],
    numberingMode: 'global_sequential',
    gridSettings: {
      enabled: true,
      axesEnabled: true,
      majorStep: 1000,
      minorStep: 250,
      color: '#334155',
      minorColor: '#1f2937',
      axisColor: '#94a3b8',
      snap: false
    },
    viewSettings: {
      backgroundColor: '#111827',
      zoom: 0.05,
      panX: 80,
      panY: 80,
      numberTextMode: 'auto',
      numberTextColor: '#ffffff',
      numberTextStrokeColor: '#020617',
      numberTextStrokeEnabled: false,
      numberTextStrokeWidth: 0,
      numberTextFontSize: 13,
      numberTextFontFamily: 'Tahoma, Segoe UI, Arial, sans-serif',
      numberTextBrightness: 1,
      numberTextBubbleEnabled: false,
      showPointNumbers: true,
      highlightUnnumbered: true,
      showNumberingPreview: true,
      showVectorPath: true,
      markerTextColor: '#ffffff',
      markerTextStrokeColor: '#020617',
      markerTextStrokeEnabled: false,
      markerTextStrokeWidth: 0,
      markerTextFontSize: 12,
      markerTextFontFamily: 'Tahoma, Segoe UI, Arial, sans-serif',
      markerTextBrightness: 1,
      markerTextBubbleEnabled: false,
      showMarkerLabels: true,
      groupOutlineStrokeColor: '#64748b',
      groupOutlineFillColor: 'rgba(96,165,250,0.035)',
      groupOutlineVisible: true,
      groupOutlineStrokeWidth: 1.7,
      groupOutlineDashSize: 10,
      groupOutlinePadding: 28,
      groupOutlineSnapPx: 54,
      groupOutlineSimplifyPx: 16,
      previewAutoLineColor: '#38bdf8',
      previewAutoArrowColor: '#67e8f9',
      previewManualLineColor: '#f59e0b',
      previewManualArrowColor: '#facc15',
      previewSelectedLineColor: '#22d3ee',
      previewSelectedArrowColor: '#67e8f9',
      previewInvalidLinkColor: '#ef4444',
      previewLineWidth: 2,
      previewManualLineWidth: 4,
      previewSelectedLineWidth: 4.5,
      previewPointLabelColor: '#ffffff',
      previewPointLabelStrokeColor: '#020617',
      previewPointLabelFontSize: 12,
      previewPointLabelStrokeWidth: 0,
      previewPointLabelBrightness: 1,
      previewPointLabelBubbleEnabled: false,
      previewPointLabelBubbleColor: '#020617',
      numberTextBubbleColor: '#020617',
      numberTextBubbleStrokeColor: '#334155',
      markerCalloutBackgroundColor: 'rgba(15,23,42,0.82)',
      markerCalloutBorderColor: '#64748b',
      markerLeaderLineColor: '#64748b',
      selectionDragMode: 'left_add_right_subtract'
    },
    operations: []
  };
}
