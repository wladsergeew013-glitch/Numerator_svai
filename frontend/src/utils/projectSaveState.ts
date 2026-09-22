import type { PileProject } from '../types/project';

// Camera, selection and operation timestamps do not change the saved field.
export function projectSaveSignature(project: PileProject): string {
  return JSON.stringify({
    schemaVersion: project.schemaVersion,
    id: project.project.id, name: project.project.name, units: project.project.units,
    points: project.points, groups: project.groups, pipelines: project.pipelines,
    numberingMode: project.numberingMode
  });
}
