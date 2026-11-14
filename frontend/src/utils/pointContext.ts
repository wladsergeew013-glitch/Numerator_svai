import type { PilePoint, PileProject } from '../types/project';

export interface PointContext { sessionId: string; pointId: string; signature: string }
export function capturePointContext(sessionId: string, point: PilePoint): PointContext {
  return { sessionId, pointId: point.id, signature: JSON.stringify(point) };
}
export function isPointContextCurrent(context: PointContext, state: { projectSessionId: string; project: PileProject }) {
  const point = state.project.points.find(item => item.id === context.pointId);
  return state.projectSessionId === context.sessionId && Boolean(point) && JSON.stringify(point) === context.signature;
}
