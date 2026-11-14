from __future__ import annotations

from math import hypot
from uuid import uuid4

from app.schemas import PilePoint, SyncState


def sync_points_with_source(old_points: list[PilePoint], new_points: list[PilePoint], tolerance: float = 100.0) -> list[PilePoint]:
    """Simple sync preview: match by sourceId, then nearest coordinate."""
    result: list[PilePoint] = []
    used_old: set[str] = set()
    reserved_ids = {p.id for p in old_points} | {p.id for p in new_points}
    emitted_ids = set()
    old_by_source = {p.sourceId: p for p in old_points if p.sourceId}

    for new_point in new_points:
        matched = old_by_source.get(new_point.sourceId or "")
        if matched is not None and matched.id in used_old:
            matched = None
        if matched is None:
            candidates = [p for p in old_points if p.id not in used_old]
            matched = min(candidates, key=lambda p: hypot(p.x - new_point.x, p.y - new_point.y), default=None)
            if matched and hypot(matched.x - new_point.x, matched.y - new_point.y) > tolerance:
                matched = None

        if matched is None:
            added = new_point.model_copy(deep=True)
            if added.id in used_old or any(p.id == added.id for p in old_points) or added.id in emitted_ids:
                added.id = 'p-' + uuid4().hex
                while added.id in reserved_ids: added.id = 'p-' + uuid4().hex
            added.syncState = SyncState.added
            emitted_ids.add(added.id); reserved_ids.add(added.id)
            result.append(added)
            continue

        used_old.add(matched.id)
        emitted_ids.add(matched.id)
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
