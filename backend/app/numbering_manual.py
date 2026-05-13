from __future__ import annotations

from app.schemas import PilePoint


def apply_manual_number(points: list[PilePoint], point_id: str, number: int, freeze_after: bool = True) -> list[PilePoint]:
    """Set a manual number and optionally freeze all points after it by current numbering order."""
    result = [p.model_copy(deep=True) for p in points]
    target = next((p for p in result if p.id == point_id), None)
    if target is None:
        return result

    target.number = number
    target.manualNumber = True

    if freeze_after and target.groupId:
        ordered = sorted(
            [p for p in result if p.groupId == target.groupId and p.number is not None],
            key=lambda p: p.number or 0,
        )
        found = False
        for point in ordered:
            if point.id == point_id:
                found = True
                continue
            if found:
                point.locked = True
    return result
