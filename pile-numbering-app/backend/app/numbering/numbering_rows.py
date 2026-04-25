from __future__ import annotations

from collections import defaultdict

from app.schemas import NumberingRowsRequest, PilePoint


def apply_numbering_rows(request: NumberingRowsRequest) -> list[PilePoint]:
    target_points = [p for p in request.points if p.groupId == request.groupId]
    locked_map = {p.id: p for p in target_points if p.locked and p.number}

    rows: dict[int, list[PilePoint]] = defaultdict(list)
    tol = max(request.rowTolerance, 1e-6)

    for p in target_points:
        row_key = int(round(p.y / tol))
        rows[row_key].append(p)

    start = request.settings.start
    step = request.settings.step
    counter = 0

    for row_key in sorted(rows.keys(), reverse=True):
        row_points = sorted(rows[row_key], key=lambda x: x.x)
        for point in row_points:
            if point.id in locked_map:
                continue
            value = start + counter * step
            point.number = f"{request.settings.prefix}{value}{request.settings.suffix}"
            counter += 1

    return request.points
