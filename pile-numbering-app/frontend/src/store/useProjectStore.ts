import { create } from 'zustand';
import { PileGroup, PilePoint, PileProject } from '../types/project';

interface ProjectState {
  project: PileProject;
  selectedGroupId: string | null;
  selectedPointIds: string[];
  setPoints: (points: PilePoint[]) => void;
  setProject: (project: PileProject) => void;
  toggleGrid: () => void;
  setBackground: (color: string) => void;
  setSelectedGroup: (id: string | null) => void;
  createGroup: () => void;
  deleteGroup: (id: string) => void;
  updateGroupColor: (id: string, color: string) => void;
  setSelection: (ids: string[]) => void;
  assignSelectionToGroup: () => void;
  updateView: (zoom: number, panX: number, panY: number) => void;
  applyRowsNumbering: () => Promise<void>;
}

const emptyProject: PileProject = {
  name: 'Untitled project',
  points: [],
  groups: [],
  numberingSettings: { start: 1, prefix: '', suffix: '', step: 1 },
  gridSettings: { enabled: true, spacing: 5, color: '#2f2f2f' },
  viewSettings: { backgroundColor: '#1e1e1e', zoom: 1, panX: 0, panY: 0 },
  operations: []
};

const uid = () => crypto.randomUUID();

export const useProjectStore = create<ProjectState>((set, get) => ({
  project: emptyProject,
  selectedGroupId: null,
  selectedPointIds: [],
  setPoints: (points) => set((state) => ({ project: { ...state.project, points } })),
  setProject: (project) => set({ project, selectedPointIds: [], selectedGroupId: null }),
  toggleGrid: () =>
    set((state) => ({
      project: {
        ...state.project,
        gridSettings: {
          ...state.project.gridSettings,
          enabled: !state.project.gridSettings.enabled
        }
      }
    })),
  setBackground: (color) =>
    set((state) => ({ project: { ...state.project, viewSettings: { ...state.project.viewSettings, backgroundColor: color } } })),
  setSelectedGroup: (id) => set({ selectedGroupId: id }),
  createGroup: () =>
    set((state) => {
      const index = state.project.groups.length + 1;
      const group: PileGroup = { id: uid(), name: `Group ${index}`, color: '#2F80ED' };
      return { project: { ...state.project, groups: [...state.project.groups, group] }, selectedGroupId: group.id };
    }),
  deleteGroup: (id) =>
    set((state) => ({
      project: {
        ...state.project,
        groups: state.project.groups.filter((g) => g.id !== id),
        points: state.project.points.map((p) => (p.groupId === id ? { ...p, groupId: null } : p))
      },
      selectedGroupId: state.selectedGroupId === id ? null : state.selectedGroupId
    })),
  updateGroupColor: (id, color) =>
    set((state) => ({
      project: {
        ...state.project,
        groups: state.project.groups.map((g) => (g.id === id ? { ...g, color } : g))
      }
    })),
  setSelection: (ids) => set({ selectedPointIds: ids }),
  assignSelectionToGroup: () =>
    set((state) => ({
      project: {
        ...state.project,
        points: state.project.points.map((p) =>
          state.selectedPointIds.includes(p.id) ? { ...p, groupId: state.selectedGroupId } : p
        )
      }
    })),
  updateView: (zoom, panX, panY) =>
    set((state) => ({ project: { ...state.project, viewSettings: { ...state.project.viewSettings, zoom, panX, panY } } })),
  applyRowsNumbering: async () => {
    const state = get();
    if (!state.selectedGroupId) return;

    const response = await fetch('http://localhost:8000/api/numbering/rows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        points: state.project.points,
        groupId: state.selectedGroupId,
        settings: state.project.numberingSettings,
        rowTolerance: 1
      })
    });

    const data = await response.json();
    set((current) => ({ project: { ...current.project, points: data.points } }));
  }
}));
