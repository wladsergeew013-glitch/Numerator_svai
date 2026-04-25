export type SyncState = 'untouched' | 'imported' | 'changed';

export interface PilePoint {
  id: string;
  sourceId?: string | null;
  x: number;
  y: number;
  sourceNumber?: string | null;
  number?: string | null;
  groupId?: string | null;
  locked: boolean;
  manualNumber?: string | null;
  syncState: SyncState;
}

export interface PileGroup {
  id: string;
  name: string;
  color: string;
}

export interface NumberingSettings {
  start: number;
  prefix: string;
  suffix: string;
  step: number;
}

export interface GridSettings {
  enabled: boolean;
  spacing: number;
  color: string;
}

export interface ViewSettings {
  backgroundColor: string;
  zoom: number;
  panX: number;
  panY: number;
}

export interface OperationRecord {
  type: string;
  timestamp: string;
  details: Record<string, unknown>;
}

export interface PileProject {
  name: string;
  points: PilePoint[];
  groups: PileGroup[];
  numberingSettings: NumberingSettings;
  gridSettings: GridSettings;
  viewSettings: ViewSettings;
  operations: OperationRecord[];
}
