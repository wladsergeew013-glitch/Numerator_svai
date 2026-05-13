from __future__ import annotations

from dataclasses import dataclass
from math import hypot, isfinite

from app.schemas import NumberingSettings, PilePoint, Point2D


@dataclass(frozen=True)
class _Projection:
    along: float
    distance: float
    signed_distance: float
    t: float


@dataclass(frozen=True)
class _Score:
    point: PilePoint
    original_index: int
    along: float
    distance: float
    signed_distance: float
    segment_index: int
    t: float
    outside_corridor: int


def _dist(a: PilePoint | Point2D, b: PilePoint | Point2D) -> float:
    return hypot(a.x - b.x, a.y - b.y)


def _project_to_segment(point: PilePoint, a: Point2D, b: Point2D) -> _Projection:
    dx = b.x - a.x
    dy = b.y - a.y
    length2 = dx * dx + dy * dy
    length = hypot(dx, dy)
    if length2 <= 1e-12 or length <= 1e-12:
        return _Projection(
            along=0.0,
            distance=hypot(point.x - a.x, point.y - a.y),
            signed_distance=0.0,
            t=0.0,
        )

    t = max(0.0, min(1.0, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length2))
    px = a.x + t * dx
    py = a.y + t * dy
    signed_distance = (dx * (point.y - a.y) - dy * (point.x - a.x)) / length

    return _Projection(
        along=t * length,
        distance=hypot(point.x - px, point.y - py),
        signed_distance=signed_distance,
        t=t,
    )


def _compact_path(path: list[Point2D], min_distance: float = 25.0) -> list[Point2D]:
    if len(path) <= 2:
        return path

    result: list[Point2D] = []
    for point in path:
        if not result or hypot(point.x - result[-1].x, point.y - result[-1].y) >= min_distance:
            result.append(point)

    if path and result and result[-1] != path[-1]:
        result.append(path[-1])
    return result


def _path_measures(path: list[Point2D]) -> tuple[list[float], list[float]]:
    segment_lengths = [hypot(path[i + 1].x - path[i].x, path[i + 1].y - path[i].y) for i in range(len(path) - 1)]
    prefix = [0.0]
    for length in segment_lengths:
        prefix.append(prefix[-1] + length)
    return segment_lengths, prefix


def _score_point(point: PilePoint, original_index: int, path: list[Point2D], lengths: list[float], prefix: list[float], max_distance: float) -> _Score:
    best_along = 0.0
    best_dist = float("inf")
    best_signed = 0.0
    best_seg = 0
    best_t = 0.0

    for i in range(len(path) - 1):
        projected = _project_to_segment(point, path[i], path[i + 1])
        candidate_along = prefix[i] + projected.along
        if projected.distance < best_dist - 1e-9 or (abs(projected.distance - best_dist) <= 1e-9 and candidate_along < best_along):
            best_dist = projected.distance
            best_signed = projected.signed_distance
            best_seg = i
            best_t = projected.t
            best_along = candidate_along

    if point.meta is None:
        point.meta = {}
    point.meta["vectorDistance"] = best_dist
    point.meta["vectorSegment"] = best_seg

    outside = 1 if best_dist > max_distance else 0
    if outside:
        point.meta["vectorWarning"] = "out_of_vector_path"
    else:
        point.meta.pop("vectorWarning", None)

    return _Score(
        point=point,
        original_index=original_index,
        along=best_along,
        distance=best_dist,
        signed_distance=best_signed,
        segment_index=best_seg,
        t=best_t,
        outside_corridor=outside,
    )


def _estimate_nearest_step(points: list[PilePoint]) -> float:
    if len(points) < 2:
        return 1000.0

    nearest: list[float] = []
    for i, point in enumerate(points):
        best = float("inf")
        for j, other in enumerate(points):
            if i == j:
                continue
            best = min(best, _dist(point, other))
        if isfinite(best):
            nearest.append(best)

    if not nearest:
        return 1000.0

    nearest.sort()
    return nearest[len(nearest) // 2]


def _percentile(values: list[float], q: float) -> float:
    finite = sorted(value for value in values if isfinite(value))
    if not finite:
        return 0.0
    index = int(max(0, min(len(finite) - 1, (len(finite) - 1) * q)))
    return finite[index]


def _effective_corridor_distance(scores: list[_Score], settings: NumberingSettings, nearest_step: float) -> float:
    user_distance = max(1.0, float(settings.maxDistanceToPath or 0.0))
    p90_distance = _percentile([score.distance for score in scores], 0.9)

    # Пользовательский допуск остаётся диагностикой, но если нарисованная линия
    # идёт как ось маршрута между рядами, нормальные точки группы могут оказаться
    # дальше этого допуска. Внутренний коридор расширяем по геометрии группы,
    # чтобы алгоритм не оставлял такие точки "позади" до конца маршрута.
    return max(user_distance, nearest_step * 1.2, p90_distance)


def _build_guided_nearest_route(points: list[PilePoint], settings: NumberingSettings, scores: list[_Score]) -> list[PilePoint]:
    if len(points) <= 1:
        return points

    by_id = {p.id: p for p in points}
    score_by_id = {score.point.id: score for score in scores}

    start = by_id.get(settings.startPointId or "")
    end = by_id.get(settings.endPointId or "")

    if start is None:
        first_score = sorted(scores, key=lambda s: (s.outside_corridor, s.along, s.distance, s.original_index))[0]
        start = first_score.point

    end_id = end.id if end is not None and end.id != start.id else None
    route = [start]
    remaining = [p for p in points if p.id != start.id and p.id != end_id]

    nearest_step = _estimate_nearest_step(points)
    effective_corridor = _effective_corridor_distance(scores, settings, nearest_step)
    wave_window = max(nearest_step * 2.8, effective_corridor * 1.1, 750.0)
    side_switch_tolerance = max(effective_corridor * 0.2, nearest_step * 0.3, 80.0)

    while remaining:
        remaining_scores = [score_by_id[p.id] for p in remaining if p.id in score_by_id]
        min_remaining_along = min((score.along for score in remaining_scores), default=float("-inf"))
        wave_limit = min_remaining_along + wave_window

        # Выбираем ближайшего соседа только из текущей "волны" вдоль линии.
        # Это не даёт маршруту убежать далеко вперёд и затем возвращаться
        # к близким точкам, которые остались за текущим положением.
        candidate_indexes = [
            i for i, candidate in enumerate(remaining)
            if candidate.id not in score_by_id or score_by_id[candidate.id].along <= wave_limit
        ]
        if not candidate_indexes:
            candidate_indexes = list(range(len(remaining)))

        current = route[-1]
        current_score = score_by_id.get(current.id)
        best_index = candidate_indexes[0]
        best_cost = float("inf")
        best_along = float("inf")
        best_original_index = float("inf")

        for i in candidate_indexes:
            candidate = remaining[i]
            candidate_score = score_by_id.get(candidate.id)
            euclidean = _dist(current, candidate)
            cost = euclidean
            candidate_along = float("inf")
            candidate_original_index = i

            if candidate_score is not None:
                candidate_along = candidate_score.along
                candidate_original_index = candidate_score.original_index

                over_corridor = max(0.0, candidate_score.distance - effective_corridor)
                path_distance_penalty = candidate_score.distance * 0.22
                corridor_penalty = over_corridor * 0.7
                wavefront_penalty = max(0.0, candidate_score.along - min_remaining_along) * 0.05
                far_ahead_penalty = (
                    (candidate_score.along - (min_remaining_along + wave_window * 0.85)) * 0.25
                    if candidate_score.along > min_remaining_along + wave_window * 0.85
                    else 0.0
                )

                side_switch_penalty = 0.0
                if current_score is not None:
                    same_local_segment = (
                        abs(candidate_score.segment_index - current_score.segment_index) <= 2
                        or abs(candidate_score.along - current_score.along) < wave_window * 0.65
                    )
                    if (
                        same_local_segment
                        and abs(current_score.signed_distance) > side_switch_tolerance
                        and abs(candidate_score.signed_distance) > side_switch_tolerance
                        and (current_score.signed_distance > 0) != (candidate_score.signed_distance > 0)
                    ):
                        side_switch_penalty = min(abs(current_score.signed_distance), abs(candidate_score.signed_distance)) * 0.8

                cost += (
                    path_distance_penalty
                    + corridor_penalty
                    + wavefront_penalty
                    + far_ahead_penalty
                    + side_switch_penalty
                )

            if (
                cost < best_cost - 1e-9
                or (
                    abs(cost - best_cost) <= 1e-9
                    and (
                        candidate_along < best_along - 1e-9
                        or (abs(candidate_along - best_along) <= 1e-9 and candidate_original_index < best_original_index)
                    )
                )
            ):
                best_cost = cost
                best_index = i
                best_along = candidate_along
                best_original_index = candidate_original_index

        route.append(remaining.pop(best_index))

    if end_id and end is not None:
        route.append(end)

    return route

def build_vector_order(points: list[PilePoint], settings: NumberingSettings) -> list[PilePoint]:
    """Order points by a user-drawn vector path and local nearest-neighbor logic.

    The path is a guide, not a blind sort key. A pure projection sort breaks on
    parallel rows because points with almost the same station on different sides
    of the line can alternate. Here the route advances by a moving wave along the
    path, and every next point is chosen by a nearest-neighbor cost inside the
    current local window so nearby points do not remain forgotten behind the
    current position.
    """
    path = _compact_path(list(settings.vectorPath or []), min_distance=25.0)

    if len(path) < 2:
        by_id = {p.id: p for p in points}
        start = by_id.get(settings.startPointId or "")
        end = by_id.get(settings.endPointId or "")
        if start is not None and end is not None and start.id != end.id:
            path = [Point2D(x=start.x, y=start.y), Point2D(x=end.x, y=end.y)]

    if len(path) < 2:
        return points

    segment_lengths, prefix = _path_measures(path)
    max_distance = max(0.0, float(settings.maxDistanceToPath or 0.0))
    scores = [_score_point(point, original_index, path, segment_lengths, prefix, max_distance) for original_index, point in enumerate(points)]

    return _build_guided_nearest_route(points, settings, scores)


def apply_numbering_vector(points: list[PilePoint], settings: NumberingSettings) -> list[PilePoint]:
    result = [p.model_copy(deep=True) for p in points]
    route = build_vector_order(result, settings)
    value = settings.startNumber
    for point in route:
        if point.locked or point.manualNumber:
            continue
        point.number = value
        value += settings.step
    return result
