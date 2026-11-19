from __future__ import annotations

from dataclasses import dataclass
from math import hypot, isfinite

from app.schemas import NumberingRowsRequest, NumberingSettings, PileGroup, PilePoint
from app.numbering_counter import number_route


@dataclass(frozen=True)
class _Bucket:
    center: float
    points: list[PilePoint]


def _distance(a: PilePoint, b: PilePoint) -> float:
    return hypot(a.x - b.x, a.y - b.y)


def _make_buckets(points: list[PilePoint], axis: str, tolerance: float) -> list[_Bucket]:
    """Group points into rows/columns by coordinate proximity.

    This is not `round(coord/tolerance)`, because that breaks rows close to a
    bucket border. Instead we sort points and grow buckets by actual distance
    from the current bucket center.
    """
    if not points:
        return []
    get_value = (lambda p: p.y) if axis == "y" else (lambda p: p.x)
    ordered = sorted(points, key=get_value)
    buckets: list[_Bucket] = []
    current: list[PilePoint] = []
    total = correction = center = 0.0
    for point in ordered:
        coordinate = get_value(point)
        if current and not (abs(coordinate - center) <= tolerance):
            buckets.append(_Bucket(center, current))
            current = []
            total = correction = 0.0
        current.append(point)
        # Preserve the compensated sum used by Python 3.12+ at the tolerance boundary.
        updated = total + coordinate
        if abs(total) >= abs(coordinate):
            correction += (total - updated) + coordinate
        else:
            correction += (coordinate - updated) + total
        total = updated
        center = (total + correction if isfinite(correction) else total) / len(current)
    buckets.append(_Bucket(center, current))
    return buckets


def _apply_start_end_preference(route: list[PilePoint], settings: NumberingSettings) -> list[PilePoint]:
    if len(route) <= 1:
        return route

    by_id = {p.id: p for p in route}
    candidates = [route, list(reversed(route))]

    def score(candidate: list[PilePoint]) -> float:
        result = 0.0
        if settings.startPointId and settings.startPointId in by_id:
            result += _distance(candidate[0], by_id[settings.startPointId]) * 10
        if settings.endPointId and settings.endPointId in by_id:
            result += _distance(candidate[-1], by_id[settings.endPointId]) * 10
        return result

    route = min(candidates, key=score)
    start = by_id.get(settings.startPointId or '')
    end = by_id.get(settings.endPointId or '')
    if start:
        route = [start] + [p for p in route if p.id != start.id]
    if end and (not start or end.id != start.id):
        route = [p for p in route if p.id != end.id] + [end]
    return route


def build_rows_order(points: list[PilePoint], settings: NumberingSettings) -> list[PilePoint]:
    method = settings.method.value if hasattr(settings.method, "value") else str(settings.method)

    if method == "columns":
        buckets = _make_buckets(points, "x", settings.columnTolerance)
        direction = settings.direction
        left_to_right = "right_to_left" not in direction
        top_to_bottom = "bottom_to_top" not in direction and direction != "snake_columns_bottom_left"
        snake = direction.startswith("snake_columns")
        buckets = sorted(buckets, key=lambda b: b.center, reverse=not left_to_right)
        route: list[PilePoint] = []
        for idx, bucket in enumerate(buckets):
            reverse = top_to_bottom
            if snake and idx % 2 == 1:
                reverse = not reverse
            route.extend(sorted(bucket.points, key=lambda p: p.y, reverse=reverse))
        return _apply_start_end_preference(route, settings)

    buckets = _make_buckets(points, "y", settings.rowTolerance)
    direction = settings.direction
    top_to_bottom = "bottom_to_top" not in direction and not direction.endswith("bottom_left")
    left_to_right = "right_to_left" not in direction and direction != "snake_rows_right_top"
    snake = direction.startswith("snake_rows")

    # В инженерных координатах Y вверх, значит верхние ряды имеют больший Y.
    buckets = sorted(buckets, key=lambda b: b.center, reverse=top_to_bottom)
    route = []
    for idx, bucket in enumerate(buckets):
        reverse = not left_to_right
        if snake and idx % 2 == 1:
            reverse = not reverse
        route.extend(sorted(bucket.points, key=lambda p: p.x, reverse=reverse))

    return _apply_start_end_preference(route, settings)


def _next_after_existing_numbers(points: list[PilePoint], start: int, step: int) -> int:
    values = [p.number for p in points if p.number is not None]
    if not values:
        return start
    return max(start, max(values) + step) if step > 0 else min(start, min(values) + step)


def _pipeline_id(group: PileGroup) -> str:
    return group.pipelineId or "pipeline-main"


def apply_numbering_rows(request: NumberingRowsRequest) -> list[PilePoint]:
    # Compute the whole plan on a copy; a failure never exposes partial numbering.
    points = [p.model_copy(deep=True) for p in request.points]
    groups = sorted(request.groups, key=lambda g: (_pipeline_id(g), g.order))
    by_group = {g.id: g for g in groups}
    target = by_group.get(request.groupId) if request.groupId else None
    if target and target.locked:
        return points
    members_by_group: dict[str | None, list[PilePoint]] = {}
    for point in points:
        members_by_group.setdefault(point.groupId, []).append(point)
    if request.groupId and target is None:
        selected = members_by_group.get(request.groupId, [])
        number_route(build_rows_order(selected, request.settings), request.settings)
        return points
    def namespace(point):
        group = by_group.get(point.groupId)
        return point.groupId if request.numberingMode == 'per_group' else (_pipeline_id(group) if group else 'ungrouped')
    occupied = {}
    target_occupied = set()
    for point in points:
        group = by_group.get(point.groupId)
        space = namespace(point)
        if target and space != (target.id if request.numberingMode == 'per_group' else _pipeline_id(target)):
            continue
        if point.number is None:
            continue
        fixed = point.locked or point.manualNumber or (group is not None and group.locked)
        if fixed:
            reserve = occupied.setdefault(space, set())
            if point.number in reserve:
                raise ValueError('Conflicting fixed numbers in the same namespace')
            reserve.add(point.number)
        if target and (fixed or point.groupId != target.id):
            if point.number in target_occupied:
                raise ValueError('Conflicting fixed numbers in the same namespace')
            target_occupied.add(point.number)
    if target:
        if request.numberingMode == 'per_group':
            groups = [target]
        else:
            pipeline_groups = [g for g in groups if _pipeline_id(g) == _pipeline_id(target)]
            groups = pipeline_groups[:pipeline_groups.index(target)+1]
    starts = {}
    for group in groups:
        key = _pipeline_id(group)
        current = starts.setdefault(key, group.numbering.startNumber)
        members = members_by_group.get(group.id, [])
        if group.locked:
            if request.numberingMode == 'global_sequential' and not group.meta.get('clusterNumbering'):
                starts[key] = _next_after_existing_numbers(members, current, group.numbering.step)
            continue
        settings = group.numbering.model_copy(update={'startNumber': current}) if request.numberingMode == 'global_sequential' else group.numbering
        reserve_key = group.id if request.numberingMode == 'per_group' else key
        # Prior groups use the same virtual reservations as full numbering.
        # Only the target must avoid the actual numbers in untouched groups.
        reserve = target_occupied if target and group.id == target.id else occupied.setdefault(reserve_key, set())
        starts[key] = number_route(build_rows_order(members, settings), settings, reserve)
    ungrouped = [p for p in points if not p.groupId or p.groupId not in by_group]
    if ungrouped and not request.groupId:
        settings = request.settings.model_copy(update={'startNumber': max(starts.values(), default=request.settings.startNumber)})
        number_route(build_rows_order(ungrouped, settings), settings, occupied.setdefault('ungrouped', set()))
    if request.groupId:
        # Prior groups participate only in the simulation of the effective counter.
        return [point if point.groupId == request.groupId else original.model_copy(deep=True)
                for point, original in zip(points, request.points)]
    return points
