from __future__ import annotations

from math import hypot

from app.schemas import PilePoint, SyncState


def sync_points_with_source(old_points: list[PilePoint], new_points: list[PilePoint], tolerance: float = 100.0) -> list[PilePoint]:
    """Simple sync preview: match by sourceId, then nearest coordinate."""
    result: list[PilePoint] = []
    used_old: set[str] = set()
    old_by_source = {p.sourceId: p for p in old_points if p.sourceId}

    for new_point in new_points:
        matched = old_by_source.get(new_point.sourceId or "")
        if matched is None:
            candidates = [p for p in old_points if p.id not in used_old]
            matched = min(candidates, key=lambda p: hypot(p.x - new_point.x, p.y - new_point.y), default=None)
            if matched and hypot(matched.x - new_point.x, matched.y - new_point.y) > tolerance:
                matched = None

        if matched is None:
            new_point.syncState = SyncState.added
            result.append(new_point)
            continue

        used_old.add(matched.id)
        updated = matched.model_copy(deep=True)
        moved = hypot(updated.x - new_point.x, updated.y - new_point.y) > 1e-9
        updated.x = new_point.x
        updated.y = new_point.y
        updated.sourceNumber = new_point.sourceNumber
        updated.syncState = SyncState.moved if moved else SyncState.unchanged
        result.append(updated)

    for old in old_points:
        if old.id not in used_old:
            deleted = old.model_copy(deep=True)
            deleted.syncState = SyncState.deleted
            result.append(deleted)
    return result
