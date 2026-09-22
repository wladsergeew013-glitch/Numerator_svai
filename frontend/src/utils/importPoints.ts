import type { PilePoint } from '../types/project';

// Import is additive: existing points, numbers, groups and locks stay untouched.
// Distinct CAD handles are distinct objects, even when their XY coordinates coincide.
export function newImportPoints(existing: PilePoint[], incoming: PilePoint[], tolerance = 1e-6): PilePoint[] {
  const accepted: PilePoint[] = [];
  const identity = (p: PilePoint) => p.meta?.cadHandle && p.meta?.cadDocument
    ? `${String(p.meta.cadDocument).replace(/\\/g, '/').toLowerCase()}:${String(p.meta.cadHandle).toUpperCase()}` : null;
  const known = [...existing];
  for (const point of incoming) {
    const key = identity(point);
    const duplicate = known.some((candidate) => {
      const other = identity(candidate);
      if (key && other) return key === other;
      return Math.hypot(candidate.x - point.x, candidate.y - point.y) <= tolerance;
    });
    if (!duplicate) {
      accepted.push(point);
      known.push(point);
    }
  }
  return accepted;
}
