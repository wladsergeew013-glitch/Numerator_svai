import type { PilePoint } from '../types/project';

export function cadPointIdentity(point: PilePoint): string | null {
  const handle = String(point.meta?.cadHandle ?? '').trim().toUpperCase();
  const document = String(point.meta?.cadDocument ?? '').trim().replace(/\\/g, '/').toLowerCase();
  return handle && document ? `${document}:${handle}` : null;
}

export interface CadImportReconciliation {
  added: PilePoint[];
  moved: PilePoint[];
  linked: PilePoint[];
  renumbered: PilePoint[];
  unchanged: number;
}

interface CadImportOptions {
  tolerance?: number;
  overwriteNumbers?: boolean;
  lockedGroupIds?: ReadonlySet<string>;
}

/** Match by drawing + handle, or by unchanged coordinates when no handle is available. */
export function reconcileCadImport(existing: PilePoint[], incoming: PilePoint[], options: CadImportOptions = {}): CadImportReconciliation {
  const { tolerance = 1e-6, overwriteNumbers = false, lockedGroupIds = new Set<string>() } = options;
  const byHandle = new Map(existing.flatMap(point => {
    const key = cadPointIdentity(point);
    return key ? [[key, point] as const] : [];
  }));
  const withoutHandle = existing.filter(point => !cadPointIdentity(point));
  const added: PilePoint[] = [];
  const moved: PilePoint[] = [];
  const linked: PilePoint[] = [];
  const renumbered: PilePoint[] = [];
  let unchanged = 0;
  const seen = new Set<string>();
  const claimedWithoutHandle = new Set<string>();
  const withImportedNumber = (current: PilePoint, imported: PilePoint): PilePoint => {
    if (!overwriteNumbers || current.locked || (current.groupId && lockedGroupIds.has(current.groupId)) ||
      typeof imported.number !== 'number' || !Number.isSafeInteger(imported.number)) return current;
    const sourceNumber = imported.sourceNumber ?? imported.number;
    if (current.number === imported.number && current.sourceNumber === sourceNumber) return current;
    const updated = { ...current, number: imported.number, sourceNumber, manualNumber: true };
    renumbered.push(updated);
    return updated;
  };
  for (const point of incoming) {
    const key = cadPointIdentity(point);
    if (key) {
      if (seen.has(key)) { unchanged++; continue; }
      seen.add(key);
      const current = byHandle.get(key);
      if (current) {
        if (Math.hypot(current.x - point.x, current.y - point.y) > tolerance) {
          moved.push(withImportedNumber({ ...current, x: point.x, y: point.y, syncState: 'moved',
            meta: { ...current.meta, ...point.meta } }, point));
        } else if (point.meta?.numberParameter && current.meta?.numberParameter !== point.meta.numberParameter) {
          linked.push(withImportedNumber({ ...current, meta: { ...current.meta, ...point.meta } }, point));
        } else if (withImportedNumber(current, point) === current) unchanged++;
        continue;
      }
      const coordinateMatch = withoutHandle.find(candidate =>
        !claimedWithoutHandle.has(candidate.id) &&
        Math.hypot(candidate.x - point.x, candidate.y - point.y) <= tolerance);
      if (coordinateMatch) {
        const updated = withImportedNumber({ ...coordinateMatch, meta: { ...coordinateMatch.meta, ...point.meta } }, point);
        claimedWithoutHandle.add(coordinateMatch.id);
        byHandle.set(key, updated);
        linked.push(updated);
        continue;
      }
    }
    const comparable = key ? withoutHandle : [...existing, ...added];
    const duplicates = comparable.filter(current => {
      const other = cadPointIdentity(current);
      return (!key || !other) && Math.hypot(current.x - point.x, current.y - point.y) <= tolerance;
    });
    if (duplicates.length) {
      if (!key && duplicates.length === 1 && existing.includes(duplicates[0])) {
        if (withImportedNumber(duplicates[0], point) === duplicates[0]) unchanged++;
      } else unchanged++;
      continue;
    }
    added.push(point);
    if (key) byHandle.set(key, point);
    else withoutHandle.push(point);
  }
  return { added, moved, linked, renumbered, unchanged };
}

// Import is additive: existing points, numbers, groups and locks stay untouched.
// Distinct CAD handles are distinct objects, even when their XY coordinates coincide.
export function newImportPoints(existing: PilePoint[], incoming: PilePoint[], tolerance = 1e-6): PilePoint[] {
  const accepted: PilePoint[] = [];
  const identity = cadPointIdentity;
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
