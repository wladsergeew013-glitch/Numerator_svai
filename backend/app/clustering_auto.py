from __future__ import annotations

from collections import deque
from math import hypot, isfinite
from statistics import median
from uuid import uuid4

from app.schemas import NumberingMethod, NumberingSettings, PileGroup, PilePoint


def _dist(a: PilePoint, b: PilePoint) -> float:
    return hypot(a.x - b.x, a.y - b.y)


def _percentile(values: list[float], q: float) -> float:
    finite = sorted(v for v in values if isfinite(v))
    if not finite:
        return 0.0
    idx = max(0, min(len(finite) - 1, round((len(finite) - 1) * q)))
    return finite[idx]


def _nearest_step(points: list[PilePoint]) -> float:
    if len(points) < 2:
        return 1000.0
    nearest: list[float] = []
    for i, point in enumerate(points):
        best = float("inf")
        for j, candidate in enumerate(points):
            if i == j:
                continue
            d = _dist(point, candidate)
            if 1e-9 < d < best:
                best = d
        if isfinite(best):
            nearest.append(best)
    return max(1.0, median(nearest) if nearest else 1000.0)


def _bounds(points: list[PilePoint]) -> tuple[float, float, float, float]:
    xs = [p.x for p in points]
    ys = [p.y for p in points]
    return min(xs), max(xs), min(ys), max(ys)


def _center(points: list[PilePoint]) -> tuple[float, float]:
    return _centroid(points)


def _overlap(a_min: float, a_max: float, b_min: float, b_max: float) -> float:
    return max(0.0, min(a_max, b_max) - max(a_min, b_min))


def _connected_clusters_raw(points: list[PilePoint], nearest_step: float) -> list[list[PilePoint]]:
    if len(points) <= 1:
        return [points] if points else []

    xs = [p.x for p in points]
    ys = [p.y for p in points]
    span = max(max(xs) - min(xs), max(ys) - min(ys), nearest_step)
    soft_limit = max(nearest_step * 3.2, span * 0.035, 1200.0)
    neighbor_limit = min(max(soft_limit, nearest_step * 2.4), max(nearest_step * 5.5, 2500.0))

    neighbors: dict[str, set[str]] = {p.id: set() for p in points}
    for point in points:
        ordered = sorted(((_dist(point, candidate), candidate) for candidate in points if candidate.id != point.id), key=lambda item: item[0])[:4]
        for d, candidate in ordered:
            if d <= neighbor_limit:
                neighbors[point.id].add(candidate.id)
                neighbors[candidate.id].add(point.id)

    by_id = {p.id: p for p in points}
    used: set[str] = set()
    clusters: list[list[PilePoint]] = []
    for point in points:
        if point.id in used:
            continue
        queue: deque[str] = deque([point.id])
        used.add(point.id)
        cluster: list[PilePoint] = []
        while queue:
            item_id = queue.popleft()
            item = by_id.get(item_id)
            if item:
                cluster.append(item)
            for next_id in neighbors.get(item_id, set()):
                if next_id not in used:
                    used.add(next_id)
                    queue.append(next_id)
        clusters.append(cluster)
    return sorted(clusters, key=len, reverse=True)


def _axis_buckets(points: list[PilePoint], axis: str, tolerance: float) -> list[list[PilePoint]]:
    getter = (lambda p: p.x) if axis == "x" else (lambda p: p.y)
    buckets: list[list[PilePoint]] = []
    for point in sorted(points, key=getter):
        if not buckets:
            buckets.append([point])
            continue
        current = buckets[-1]
        center = sum(getter(p) for p in current) / len(current)
        if abs(getter(point) - center) <= tolerance:
            current.append(point)
        else:
            buckets.append([point])
    return buckets


def _dense_horizontal_bands(points: list[PilePoint], nearest_step: float) -> list[list[PilePoint]]:
    tolerance = max(500.0, nearest_step * 0.65)
    min_dense_count = max(6, int((len(points) ** 0.5) * 1.25))
    raw: list[list[PilePoint]] = []
    for bucket in _axis_buckets(points, "y", tolerance):
        min_x, max_x, _min_y, _max_y = _bounds(bucket)
        if len(bucket) >= min_dense_count and max_x - min_x >= nearest_step * 6:
            raw.append(bucket)

    raw.sort(key=lambda bucket: _center(bucket)[1])
    merged: list[list[PilePoint]] = []
    for band in raw:
        if not merged:
            merged.append(list(band))
            continue
        previous = merged[-1]
        prev_min_x, prev_max_x, _prev_min_y, prev_max_y = _bounds(previous)
        band_min_x, band_max_x, band_min_y, _band_max_y = _bounds(band)
        y_gap = band_min_y - prev_max_y
        x_overlap = _overlap(prev_min_x, prev_max_x, band_min_x, band_max_x)
        x_gap = max(0.0, max(prev_min_x, band_min_x) - min(prev_max_x, band_max_x))
        can_merge = y_gap <= nearest_step * 1.45 and (x_overlap > nearest_step or x_gap <= nearest_step * 2.2)
        if can_merge:
            previous.extend(band)
        else:
            merged.append(list(band))
    return merged


def _merge_clusters_by_horizontal_bands(clusters: list[list[PilePoint]], all_points: list[PilePoint], nearest_step: float) -> list[list[PilePoint]]:
    working = [list(cluster) for cluster in clusters]
    for band in _dense_horizontal_bands(all_points, nearest_step):
        band_ids = {p.id for p in band}
        hits: list[dict[str, object]] = []
        for index, cluster in enumerate(working):
            inside = [p for p in cluster if p.id in band_ids]
            if not inside:
                continue
            hits.append(
                {
                    "index": index,
                    "inside": inside,
                    "inside_ids": {p.id for p in inside},
                    "share": len(inside) / max(1, len(cluster)),
                }
            )

        primary = [hit for hit in hits if len(hit["inside"]) >= 4 and float(hit["share"]) >= 0.35]  # type: ignore[arg-type]
        donors = [hit for hit in hits if len(hit["inside"]) >= 2 and float(hit["share"]) < 0.35]  # type: ignore[arg-type]
        if not primary or (len(primary) == 1 and not donors):
            continue

        target_index = int(primary[0]["index"])
        target_ids = {p.id for p in working[target_index]}

        for hit in primary[1:]:
            index = int(hit["index"])
            for point in working[index]:
                if point.id not in target_ids:
                    working[target_index].append(point)
                    target_ids.add(point.id)
            working[index] = []

        # Если большой кластер случайно зацепил несколько точек плотного
        # горизонтального пояса, переносим только эти точки. Так начало следующего
        # поля не приклеивается к предыдущему по ближайшему вертикальному соседу.
        for hit in donors:
            index = int(hit["index"])
            inside = hit["inside"]  # type: ignore[assignment]
            inside_ids = hit["inside_ids"]  # type: ignore[assignment]
            for point in inside:
                if point.id not in target_ids:
                    working[target_index].append(point)
                    target_ids.add(point.id)
            working[index] = [point for point in working[index] if point.id not in inside_ids]

        working = [cluster for cluster in working if cluster]

    return working


def _vertical_tail_bands(points: list[PilePoint], nearest_step: float) -> list[list[PilePoint]]:
    tolerance = max(500.0, nearest_step * 0.65)
    raw: list[list[PilePoint]] = []
    for bucket in _axis_buckets(points, "x", tolerance):
        _min_x, _max_x, min_y, max_y = _bounds(bucket)
        if len(bucket) >= 6 and max_y - min_y >= nearest_step * 6:
            raw.append(bucket)

    raw.sort(key=lambda bucket: _center(bucket)[0])
    merged: list[list[PilePoint]] = []
    for band in raw:
        if not merged:
            merged.append(list(band))
            continue
        previous = merged[-1]
        _prev_min_x, prev_max_x, prev_min_y, prev_max_y = _bounds(previous)
        band_min_x, _band_max_x, band_min_y, band_max_y = _bounds(band)
        x_gap = band_min_x - prev_max_x
        y_overlap = _overlap(prev_min_y, prev_max_y, band_min_y, band_max_y)
        if x_gap <= nearest_step * 2.05 and y_overlap >= nearest_step * 2.0:
            previous.extend(band)
        else:
            merged.append(list(band))
    return merged


def _split_right_vertical_tail(cluster: list[PilePoint], nearest_step: float) -> list[list[PilePoint]]:
    if len(cluster) < 18:
        return [cluster]

    min_x, max_x, _min_y, _max_y = _bounds(cluster)
    width = max_x - min_x
    candidates: list[list[PilePoint]] = []
    for band in _vertical_tail_bands(cluster, nearest_step):
        b_min_x, b_max_x, b_min_y, b_max_y = _bounds(band)
        tail_width = b_max_x - b_min_x
        tail_height = b_max_y - b_min_y
        near_right_edge = b_max_x >= max_x - max(nearest_step * 2.5, width * 0.08)
        enough_remainder = len(cluster) - len(band) >= 8
        if (
            near_right_edge
            and len(band) >= 8
            and enough_remainder
            and tail_height >= nearest_step * 6
            and tail_width <= max(nearest_step * 3, width * 0.12)
        ):
            candidates.append(band)

    if not candidates:
        return [cluster]

    candidates.sort(key=lambda band: (_center(band)[0], len(band)), reverse=True)
    tail = candidates[0]
    tail_ids = {p.id for p in tail}
    main = [p for p in cluster if p.id not in tail_ids]
    if len(main) < 8:
        return [cluster]
    return [main, tail]


def _connected_clusters(points: list[PilePoint]) -> list[list[PilePoint]]:
    nearest_step = _nearest_step(points)
    clusters = _connected_clusters_raw(points, nearest_step)
    clusters = _merge_clusters_by_horizontal_bands(clusters, points, nearest_step)

    refined: list[list[PilePoint]] = []
    for cluster in clusters:
        refined.extend(_split_right_vertical_tail(cluster, nearest_step))
    return sorted([cluster for cluster in refined if cluster], key=len, reverse=True)

def _centroid(points: list[PilePoint]) -> tuple[float, float]:
    count = max(1, len(points))
    return sum(p.x for p in points) / count, sum(p.y for p in points) / count


def _order_clusters_by_route(clusters: list[list[PilePoint]]) -> list[list[PilePoint]]:
    if len(clusters) <= 1:
        return clusters
    items = [{"points": c, "center": _centroid(c), "index": i} for i, c in enumerate(clusters)]
    start_index = min(range(len(items)), key=lambda i: (-items[i]["center"][1], items[i]["center"][0], items[i]["index"]))
    route = [items.pop(start_index)]
    while items:
        cx, cy = route[-1]["center"]
        best_index = min(range(len(items)), key=lambda i: hypot(items[i]["center"][0] - cx, items[i]["center"][1] - cy))
        route.append(items.pop(best_index))
    return [item["points"] for item in route]


def _axis_buckets(points: list[PilePoint], axis: str, tolerance: float) -> list[list[PilePoint]]:
    getter = (lambda p: p.x) if axis == "x" else (lambda p: p.y)
    buckets: list[list[PilePoint]] = []
    for point in sorted(points, key=getter):
        if not buckets:
            buckets.append([point])
            continue
        current = buckets[-1]
        center = sum(getter(p) for p in current) / len(current)
        if abs(getter(point) - center) <= tolerance:
            current.append(point)
        else:
            buckets.append([point])
    return buckets


def _axis_score(points: list[PilePoint], axis: str, tolerance: float) -> float:
    if len(points) < 3:
        return 0.0
    buckets = [b for b in _axis_buckets(points, axis, tolerance) if b]
    multi = [b for b in buckets if len(b) >= 2]
    covered = sum(len(b) for b in multi)
    avg = covered / len(multi) if multi else 0.0
    coverage = covered / len(points)
    balance = 1.0 if len(buckets) > 1 else 0.55
    return coverage * avg * balance


def _choose_settings(points: list[PilePoint], order: int, pipeline_start: int) -> NumberingSettings:
    step = _nearest_step(points)
    tolerance = max(120.0, min(1500.0, step * 0.35))
    rows_score = _axis_score(points, "y", tolerance)
    columns_score = _axis_score(points, "x", tolerance)
    if rows_score >= columns_score * 1.12:
        method = NumberingMethod.rows
    elif columns_score > rows_score * 1.12:
        method = NumberingMethod.columns
    else:
        method = NumberingMethod.route

    direction = "snake_columns_top_left" if method == NumberingMethod.columns else "snake_rows_left_top" if len(points) >= 8 else "left_to_right_top_to_bottom"
    return NumberingSettings(
        method=method,
        startNumber=pipeline_start if order == 1 else 1,
        rowTolerance=tolerance,
        columnTolerance=tolerance,
        direction=direction,  # type: ignore[arg-type]
        optimize=True,
    )


def build_auto_clusters(points: list[PilePoint], pipeline_id: str | None = None, pipeline_start: int = 1) -> list[PileGroup]:
    clusters = _order_clusters_by_route(_connected_clusters(points))
    groups: list[PileGroup] = []
    base_colors = ["#ff0000", "#ffff00", "#00ff00", "#00ffff", "#0000ff", "#ff00ff", "#ffffff", "#808080", "#ff9900"]
    for index, cluster in enumerate(clusters, start=1):
        groups.append(
            PileGroup(
                id=f"g-{uuid4().hex[:8]}",
                name=f"Авто {index}",
                order=index,
                pipelineId=pipeline_id,
                color=base_colors[(index - 1) % len(base_colors)],
                numbering=_choose_settings(cluster, index, pipeline_start),
                meta={"autoClustered": True, "autoClusterSize": len(cluster)},
            )
        )
    return groups


def cluster_points_auto(points: list[PilePoint]) -> tuple[list[PilePoint], list[PileGroup]]:
    """Build a safe clustering preview without mutating the input points.

    UI still applies the result explicitly. Locked/manual project semantics are handled
    by the caller; this helper only detects clusters and suggested group methods.
    """
    cloned = [p.model_copy(deep=True) for p in points]
    groups = build_auto_clusters(cloned)
    for group, cluster in zip(groups, _order_clusters_by_route(_connected_clusters(cloned)), strict=False):
        for point in cluster:
            point.groupId = group.id
    return cloned, groups
