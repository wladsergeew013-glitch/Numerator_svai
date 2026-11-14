import type { PileGroup, PilePoint } from '../types/project';
/** Shared by rendering and every ordinary hit-test. Locks govern edits, not visibility. */
export function pointVisibility(groups: PileGroup[]) {
  const hidden = new Set(groups.filter(group => group.visible === false).map(group => group.id));
  return (point: Pick<PilePoint, 'groupId'>) => !point.groupId || !hidden.has(point.groupId);
}
