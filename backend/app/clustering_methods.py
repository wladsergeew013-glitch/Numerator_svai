"""Geometry-only clustering previews. Input points and project state are never mutated."""
from math import atan2, degrees
from typing import Literal
import warnings

import numpy as np
from pydantic import BaseModel, Field
from scipy.spatial import Delaunay, QhullError, cKDTree
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import minimum_spanning_tree
from sklearn.cluster import DBSCAN, HDBSCAN, OPTICS

from app.schemas import PilePoint


class ClusterOptions(BaseModel):
    method: Literal['branches', 'bands', 'hdbscan', 'dbscan', 'optics', 'count'] = 'branches'
    radiusFactor: float = Field(default=2.5, ge=0.1, le=20, allow_inf_nan=False)
    turnAngle: float = Field(default=45, ge=5, le=85, allow_inf_nan=False)
    angle: float = Field(default=0, ge=-180, le=180, allow_inf_nan=False)
    autoAngle: bool = True
    compactSites: bool = True
    bandTolerance: float = Field(default=0.4, ge=0.01, le=5, allow_inf_nan=False)
    minClusterSize: int = Field(default=8, ge=2, le=10000)
    minSamples: int = Field(default=3, ge=2, le=1000)
    xi: float = Field(default=0.05, gt=0, lt=1, allow_inf_nan=False)
    clusterCount: int = Field(default=7, ge=1, le=500)


class ClusterPreviewRequest(BaseModel):
    points: list[PilePoint] = Field(min_length=2, max_length=30000)
    options: ClusterOptions = Field(default_factory=ClusterOptions)


def _components(count, edges):
    parent = list(range(count))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for a, b, *_ in edges:
        a, b = find(int(a)), find(int(b))
        if a != b:
            parent[max(a, b)] = min(a, b)
    roots = [find(i) for i in range(count)]
    labels = {root: label for label, root in enumerate(sorted(set(roots)))}
    return np.array([labels[root] for root in roots])


def _mst(xy):
    """Euclidean MST through Delaunay edges; collinear fields use sorted neighbours."""
    n = len(xy)
    if n < 2:
        return []
    edge_set = set()
    if n >= 3:
        try:
            for triangle in Delaunay(xy).simplices:
                for a, b in ((triangle[0], triangle[1]), (triangle[1], triangle[2]), (triangle[2], triangle[0])):
                    edge_set.add(tuple(sorted((int(a), int(b)))))
        except QhullError:
            pass
    if not edge_set:
        # Projection on the principal direction orders even a vertical straight line.
        _, _, axes = np.linalg.svd(xy - xy.mean(axis=0), full_matrices=False)
        ordered = np.argsort(xy @ axes[0], kind='stable')
        edge_set.update(tuple(sorted((int(a), int(b)))) for a, b in zip(ordered[:-1], ordered[1:]))
    pairs = sorted(edge_set)
    values = [float(np.linalg.norm(xy[a] - xy[b])) for a, b in pairs]
    graph = coo_matrix((values, ([p[0] for p in pairs], [p[1] for p in pairs])), shape=(n, n)).tocsr()
    tree = minimum_spanning_tree(graph + graph.T).tocoo()
    return sorted([(int(a), int(b), float(d)) for a, b, d in zip(tree.row, tree.col, tree.data)], key=lambda e: (e[2], e[0], e[1]))


def _branches(xy, options):
    edges = [edge for edge in _mst(xy) if edge[2] <= options.radiusFactor]
    neighbors = [[] for _ in xy]
    for index, (a, b, distance) in enumerate(edges):
        neighbors[a].append((b, index, distance))
        neighbors[b].append((a, index, distance))
    removed = set()
    for i, adjacent in enumerate(neighbors):
        if len(adjacent) < 2:
            continue
        best = None
        for j, (a, ia, da) in enumerate(adjacent):
            for b, ib, db in adjacent[j + 1:]:
                cosine = np.clip(np.dot(xy[a] - xy[i], xy[b] - xy[i]) / (da * db), -1, 1)
                bend = 180 - degrees(float(np.arccos(cosine)))
                candidate = (bend, min(ia, ib), max(ia, ib))
                if best is None or candidate < best:
                    best = candidate
        if best and best[0] <= options.turnAngle:
            keep = {best[1], best[2]}
        else:
            # Keep the shorter arm at a corner; the other starts a new segment.
            keep = {min(adjacent, key=lambda p: (p[2], p[1]))[1]}
        removed.update(index for _, index, _ in adjacent if index not in keep)
    return _components(len(xy), [edge for i, edge in enumerate(edges) if i not in removed])


def _compact_sites(xy):
    """Collapse only small close sets for direction estimation, retaining all point IDs."""
    if len(xy) < 3:
        return xy, np.arange(len(xy)), 1.0
    nearest = float(np.median(cKDTree(xy).query(xy, k=2)[0][:, 1]))
    parent = list(range(len(xy)))
    counts = [1] * len(xy)
    bounds = [[*point, *point] for point in xy]

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for a, b, distance in _mst(xy):
        if distance > min(nearest * 3.2, 1.2):
            break
        a, b = find(a), find(b)
        if a == b or counts[a] + counts[b] > 12:
            continue
        low = np.minimum(bounds[a][:2], bounds[b][:2])
        high = np.maximum(bounds[a][2:], bounds[b][2:])
        if np.linalg.norm(high-low) > nearest * 4.2:
            continue
        parent[b] = a
        counts[a] += counts[b]
        bounds[a] = [*low, *high]
    groups = {}
    for i in range(len(xy)):
        groups.setdefault(find(i), []).append(i)
    sites = []
    inverse = np.zeros(len(xy), dtype=int)
    for label, indices in enumerate(groups.values()):
        sites.append(xy[indices].mean(axis=0))
        inverse[indices] = label
    sites = np.array(sites)
    scale = float(np.median(cKDTree(sites).query(sites, k=2)[0][:, 1])) if len(sites) > 1 else 1.0
    return np.round(sites / scale, 10), inverse, scale


def _dominant_angle(xy):
    if len(xy) < 2:
        return 0.0
    distances, indices = cKDTree(xy).query(xy, k=min(5, len(xy)))
    histogram = np.zeros(36)
    for i in range(len(xy)):
        for distance, j in zip(distances[i, 1:], indices[i, 1:]):
            if distance <= 0 or distance > 3:
                continue
            vector = xy[int(j)] - xy[i]
            angle = degrees(atan2(vector[1], vector[0])) % 180
            histogram[int(round(angle / 5)) % 36] += 1 / max(distance, 0.1)
    return float(np.argmax(histogram) * 5)


def _bands(xy, options):
    angle = _dominant_angle(xy) if options.autoAngle else options.angle
    rad = np.radians(angle)
    uv = xy @ np.array([[np.cos(rad), -np.sin(rad)], [np.sin(rad), np.cos(rad)]])
    bands = []
    sums = []
    for i in np.lexsort((uv[:, 0], uv[:, 1])):
        if not bands or abs(uv[i, 1] - sums[-1] / len(bands[-1])) > options.bandTolerance:
            bands.append([int(i)])
            sums.append(float(uv[i, 1]))
        else:
            bands[-1].append(int(i))
            sums[-1] += float(uv[i, 1])
    labels = np.full(len(xy), -1, dtype=int)
    label = -1
    for band in bands:
        previous = None
        for i in sorted(band, key=lambda j: (uv[j, 0], j)):
            if previous is None or uv[i, 0] - uv[previous, 0] > options.radiusFactor:
                label += 1
            labels[i] = label
            previous = i
    return labels, angle


def preview_clusters(request: ClusterPreviewRequest):
    points = sorted(request.points, key=lambda p: (p.x, p.y, p.id))
    if len({p.id for p in points}) != len(points):
        raise ValueError('Повторяются идентификаторы точек.')
    coords = np.array([(p.x, p.y) for p in points], dtype=float)
    if not np.isfinite(coords).all():
        raise ValueError('Координаты должны быть конечными числами.')
    # Equal XY remain distinct input points; geometry treats them as one location.
    unique, inverse = np.unique(coords, axis=0, return_inverse=True)
    if len(unique) > 1:
        distances = cKDTree(unique).query(unique, k=min(3, len(unique)))[0]
        step = float(np.median(distances[:, -1]))
    else:
        step = 1.0
    # CAD grids have many tied distances. Remove floating-point noise from unit
    # conversion so density hierarchies do not change when metres become mm.
    xy, normalized_inverse = np.unique(np.round((unique - unique.mean(axis=0)) / step, 10), axis=0, return_inverse=True)
    inverse = normalized_inverse[inverse]
    full_xy = xy[inverse]
    options = request.options
    messages = []
    angle = None
    if options.method == 'count':
        if options.clusterCount > len(xy):
            raise ValueError(f'Число групп не может превышать число разных положений: {len(xy)}.')
        edges = _mst(xy)
        keep = len(edges) - (options.clusterCount - 1)
        labels = _components(len(xy), edges[:keep])[inverse]
    elif options.method == 'branches':
        sites, site_inverse, site_scale = _compact_sites(xy) if options.compactSites else (xy, np.arange(len(xy)), 1.0)
        labels = _branches(sites, options)[site_inverse][inverse]
        step *= site_scale
    elif options.method == 'bands':
        sites, site_inverse, site_scale = _compact_sites(xy) if options.compactSites else (xy, np.arange(len(xy)), 1.0)
        unique_labels, angle = _bands(sites, options)
        labels = unique_labels[site_inverse][inverse]
        step *= site_scale
    elif options.method == 'dbscan':
        neighbours = cKDTree(full_xy).query_ball_point(full_xy, options.radiusFactor, return_length=True)
        if int(neighbours.sum()) > 5_000_000:
            raise ValueError('Слишком много соседних связей для DBSCAN. Уменьшите радиус, выделите часть поля или используйте HDBSCAN.')
        labels = DBSCAN(eps=options.radiusFactor, min_samples=options.minSamples).fit_predict(full_xy)
    elif len(points) < max(options.minSamples, options.minClusterSize):
        labels = np.full(len(points), -1, dtype=int)
        messages.append('Точек меньше заданного минимального размера или числа соседей.')
    elif options.method == 'hdbscan':
        labels = HDBSCAN(min_cluster_size=options.minClusterSize, min_samples=options.minSamples).fit_predict(full_xy)
    else:
        if len(points) > 5000:
            raise ValueError('Для OPTICS выберите не более 5000 точек: этот метод требует больше времени.')
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', RuntimeWarning)
            labels = OPTICS(min_samples=options.minSamples, min_cluster_size=options.minClusterSize, xi=options.xi).fit_predict(full_xy)
    groups = {}
    unassigned = []
    for point, label in zip(points, labels):
        if label < 0:
            unassigned.append(point.id)
        else:
            groups.setdefault(int(label), []).append(point.id)
    clusters = sorted(groups.values(), key=lambda ids: (-len(ids), ids[0]))
    if unassigned:
        messages.append(f'Без группы останутся {len(unassigned)} точек. Они не будут удалены.')
    if len(clusters) > 100:
        messages.append('Получилось больше 100 групп. Увеличьте радиус или минимальный размер группы для более крупных участков.')
    if clusters and len(clusters[0]) > len(points) * 0.8 and len(points) > 20:
        messages.append('Большая часть точек попала в одну группу. Проверьте соединения между участками.')
    return dict(method=options.method, clusters=clusters, unassignedIds=unassigned,
                step=step, angle=angle, warnings=messages, pointCount=len(points), options=options.model_dump())
