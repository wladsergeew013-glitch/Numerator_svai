from __future__ import annotations

from math import hypot

from app.schemas import NumberingSettings, PilePoint


def _dist(a: PilePoint, b: PilePoint) -> float:
    return hypot(a.x - b.x, a.y - b.y)


def _nearest_neighbor(points: list[PilePoint], start: PilePoint) -> list[PilePoint]:
    remaining = points.copy()
    route = [start]
    remaining.remove(start)
    while remaining:
        current = route[-1]
        nxt = min(remaining, key=lambda p: _dist(current, p))
        route.append(nxt)
        remaining.remove(nxt)
    return route


def _two_opt(route: list[PilePoint], keep_last: bool) -> list[PilePoint]:
    if len(route) < 4:
        return route
    improved = True
    limit = len(route) - 1 if keep_last else len(route)
    while improved:
        improved = False
        for i in range(1, limit - 2):
            for j in range(i + 1, limit):
                a, b = route[i - 1], route[i]
                c, d = route[j - 1], route[j] if j < len(route) else route[-1]
                before = _dist(a, b) + _dist(c, d)
                after = _dist(a, c) + _dist(b, d)
                if after + 1e-9 < before:
                    route = route[:i] + list(reversed(route[i:j])) + route[j:]
                    improved = True
                    break
            if improved:
                break
    return route


def build_route_order(points: list[PilePoint], settings: NumberingSettings) -> list[PilePoint]:
    if len(points) <= 1:
        return points
    by_id = {p.id: p for p in points}
    start = by_id.get(settings.startPointId or "")
    if start is None:
        # Default: upper-left in engineering coordinates.
        start = min(points, key=lambda p: (p.x, -p.y))

    route = _nearest_neighbor(points, start)

    end = by_id.get(settings.endPointId or "")
    if end is not None and end in route and route[-1] != end:
        # Rebuild the middle so the explicit end remains the last point.
        middle = [p for p in points if p not in (start, end)]
        route = _nearest_neighbor([start] + middle, start) + [end]

    if settings.optimize:
        route = _two_opt(route, keep_last=end is not None)
    return route


def apply_numbering_route(points: list[PilePoint], settings: NumberingSettings) -> list[PilePoint]:
    result = [p.model_copy(deep=True) for p in points]
    route = build_route_order(result, settings)
    value = settings.startNumber
    for point in route:
        if point.locked or point.manualNumber:
            continue
        point.number = value
        value += settings.step
    return result
