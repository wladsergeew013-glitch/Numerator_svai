from __future__ import annotations

from dataclasses import dataclass
from math import hypot

from app.schemas import NumberingRowsRequest, NumberingSettings, PileGroup, PilePoint


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
    buckets: list[list[PilePoint]] = []

    for point in ordered:
        if not buckets:
            buckets.append([point])
            continue
        current = buckets[-1]
        center = sum(get_value(p) for p in current) / len(current)
        if abs(get_value(point) - center) <= tolerance:
            current.append(point)
        else:
            buckets.append([point])

    return [_Bucket(center=sum(get_value(p) for p in b) / len(b), points=b) for b in buckets]


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

    return min(candidates, key=score)


def build_rows_order(points: list[PilePoint], settings: NumberingSettings) -> list[PilePoint]:
    method = settings.method.value if hasattr(settings.method, "value") else str(settings.method)

    if method == "columns":
        buckets = _make_buckets(points, "x", settings.columnTolerance)
        direction = settings.direction
        left_to_right = "right" not in direction
        top_to_bottom = "bottom" not in direction
        snake = direction.startswith("snake_columns")
        buckets = sorted(buckets, key=lambda b: b.center, reverse=not left_to_right)
        route: list[PilePoint] = []
        for idx, bucket in enumerate(buckets):
            reverse = not top_to_bottom
            if snake and idx % 2 == 1:
                reverse = not reverse
            route.extend(sorted(bucket.points, key=lambda p: p.y, reverse=reverse))
        return _apply_start_end_preference(route, settings)

    buckets = _make_buckets(points, "y", settings.rowTolerance)
    direction = settings.direction
    top_to_bottom = "bottom_to_top" not in direction and not direction.endswith("bottom_left")
    left_to_right = "right_to_left" not in direction
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


def _number_route(route: list[PilePoint], settings: NumberingSettings) -> int:
    value = settings.startNumber
    for point in route:
        if point.manualNumber:
            if point.number is not None:
                value = point.number + settings.step
            continue
        if point.locked:
            continue
        point.number = value
        value += settings.step
    return value


def _next_after_existing_numbers(points: list[PilePoint], group_id: str, start: int, step: int) -> int:
    values = [p.number for p in points if p.groupId == group_id and p.number is not None]
    if not values:
        return start
    return max(start, max(values) + step)


def _pipeline_id(group: PileGroup) -> str:
    return group.pipelineId or "pipeline-main"


def _pipeline_start_number(pipeline_groups: list[PileGroup], fallback: NumberingSettings) -> int:
    # Старт пайплайна задаёт первая группа по порядку, даже если она пока пустая.
    return pipeline_groups[0].numbering.startNumber if pipeline_groups else fallback.startNumber


def _effective_group_settings(points: list[PilePoint], request: NumberingRowsRequest, target_group: PileGroup) -> NumberingSettings:
    if request.numberingMode != "global_sequential":
        return target_group.numbering

    groups = sorted(request.groups, key=lambda g: (_pipeline_id(g), g.order))
    pipeline_groups = [g for g in groups if _pipeline_id(g) == _pipeline_id(target_group)]
    current_start = _pipeline_start_number(pipeline_groups, request.settings)

    for group in pipeline_groups:
        if group.id == target_group.id:
            return group.numbering.model_copy(update={"startNumber": current_start})

        group_points = [p for p in points if p.groupId == group.id]
        if not group_points:
            continue
        group_settings = group.numbering
        if group.locked:
            current_start = _next_after_existing_numbers(points, group.id, current_start, group_settings.step)
            continue

        simulated_settings = group_settings.model_copy(update={"startNumber": current_start})
        current_start = _number_route(build_rows_order(group_points, simulated_settings), simulated_settings)

    return target_group.numbering.model_copy(update={"startNumber": current_start})


def apply_numbering_rows(request: NumberingRowsRequest) -> list[PilePoint]:
    points = [p.model_copy(deep=True) for p in request.points]
    settings = request.settings

    if request.groupId:
        target_group = next((g for g in request.groups if g.id == request.groupId), None)
        group_settings = _effective_group_settings(points, request, target_group) if target_group else settings
        target_points = [p for p in points if p.groupId == request.groupId]
        route = build_rows_order(target_points, group_settings)
        _number_route(route, group_settings)
        return points

    # Number groups by independent pipelines. Old projects have pipelineId=None and
    # therefore become one default pipeline. Locked groups keep their numbers but,
    # in global mode, their existing max number advances the next group start.
    groups = sorted(request.groups, key=lambda g: (_pipeline_id(g), g.order))
    pipeline_ids = []
    for group in groups:
        pipeline_id = _pipeline_id(group)
        if pipeline_id not in pipeline_ids:
            pipeline_ids.append(pipeline_id)

    last_current_start = settings.startNumber
    for pipeline_id in pipeline_ids:
        pipeline_groups = [g for g in groups if _pipeline_id(g) == pipeline_id]
        current_start = _pipeline_start_number(pipeline_groups, settings)
        for group in pipeline_groups:
            group_settings = group.numbering or settings
            group_points = [p for p in points if p.groupId == group.id]
            if not group_points:
                continue
            if group.locked:
                if request.numberingMode == "global_sequential":
                    current_start = _next_after_existing_numbers(points, group.id, current_start, group_settings.step)
                continue
            if request.numberingMode == "global_sequential":
                group_settings = group_settings.model_copy(update={"startNumber": current_start})
            route = build_rows_order(group_points, group_settings)
            next_number = _number_route(route, group_settings)
            if request.numberingMode == "global_sequential":
                current_start = next_number
        last_current_start = max(last_current_start, current_start)

    ungrouped = [p for p in points if not p.groupId]
    if ungrouped:
        ungrouped_settings = settings.model_copy(update={"startNumber": last_current_start})
        _number_route(build_rows_order(ungrouped, ungrouped_settings), ungrouped_settings)

    return points
