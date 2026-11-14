import type { PileGroup, PileProject } from '../types/project';

export function canEditStartNumber(project: Pick<PileProject, 'numberingMode'>, group: PileGroup, firstGroupId?: string | null) {
  return project.numberingMode === 'per_group' ? !group.meta?.clusterNumbering : group.id === firstGroupId;
}

export function numberingSpace(project: PileProject, group?: PileGroup | null): string {
  if (!group) return 'ungrouped';
  if (project.numberingMode === 'per_group') return `group:${group.id}`;
  const pipelineId = project.pipelines.some(p => p.id === group.pipelineId)
    ? group.pipelineId : project.pipelines[0]?.id ?? 'pipeline-default';
  return `pipeline:${pipelineId}`;
}
