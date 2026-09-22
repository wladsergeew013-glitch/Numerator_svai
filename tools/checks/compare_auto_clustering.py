"""Offline comparison on a copy of a project; never edits the input or production defaults."""
import argparse
import json
import sys
import time
from collections import Counter
from pathlib import Path

import numpy as np
from sklearn.cluster import DBSCAN, HDBSCAN, OPTICS
from sklearn.metrics import adjusted_rand_score
from sklearn.neighbors import NearestNeighbors
from threadpoolctl import threadpool_limits

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'backend'))
from app.clustering_auto import _connected_clusters
from app.schemas import PilePoint


def current_labels(points):
    clusters = _connected_clusters(points)
    mapping = {p.id: i for i, cluster in enumerate(clusters) for p in cluster}
    return np.array([mapping[p.id] for p in points])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('project', type=Path)
    parser.add_argument('--output', type=Path, default=Path('tools/out/clustering-comparison.json'))
    args = parser.parse_args()
    project = json.loads(args.project.read_text(encoding='utf-8-sig'))
    points = [PilePoint.model_validate(p) for p in project['points']]
    if len(points) < 3:
        parser.error('Для сравнения нужны хотя бы три точки.')
    xy = np.array([(p.x, p.y) for p in points])
    distances = NearestNeighbors(n_neighbors=3).fit(xy).kneighbors(xy)[0]
    step = float(np.median(distances[:, 2]))
    methods = [
        ('Текущая авторазбивка', None),
        ('DBSCAN: радиус 1.5 шага, min=3', DBSCAN(eps=step*1.5, min_samples=3)),
        ('DBSCAN: радиус 2 шага, min=3', DBSCAN(eps=step*2, min_samples=3)),
        ('HDBSCAN: размер 8, min=3', HDBSCAN(min_cluster_size=8, min_samples=3)),
        ('HDBSCAN: размер 16, min=4', HDBSCAN(min_cluster_size=16, min_samples=4)),
        ('OPTICS: размер 8, min=4, xi=.05', OPTICS(min_samples=4, min_cluster_size=8, xi=.05)),
    ]
    results = []
    with threadpool_limits(limits=1):
        for name, method in methods:
            started = time.perf_counter()
            labels = current_labels(points) if method is None else method.fit_predict(xy)
            counts = Counter(int(v) for v in labels)
            noise = counts.pop(-1, 0)
            result = dict(name=name, groups=len(counts), sizes=sorted(counts.values(), reverse=True),
                          unassigned=noise, seconds=round(time.perf_counter()-started, 4), labels=labels.tolist())
            results.append(result)
            print(json.dumps({k: v for k, v in result.items() if k != 'labels'}, ensure_ascii=True))
    baseline = np.array(results[0]['labels'])
    stability = []
    random = np.random.default_rng(42)
    variants = [('Поворот 30°', xy @ np.array([[np.cos(np.pi/6), np.sin(np.pi/6)], [-np.sin(np.pi/6), np.cos(np.pi/6)]])),
                ('Поворот 90°', np.column_stack((-xy[:, 1], xy[:, 0]))),
                ('Шум 1% ближайшего шага', xy + random.normal(0, float(np.median(distances[:, 1]))*.01, xy.shape))]
    for name, coords in variants:
        altered = [p.model_copy(update={'x': float(x), 'y': float(y)}) for p, (x, y) in zip(points, coords)]
        labels = current_labels(altered)
        result = dict(name=name, groups=len(set(labels)), agreement=round(adjusted_rand_score(baseline, labels), 4))
        stability.append(result)
        print(json.dumps(result, ensure_ascii=True))
    reversed_labels = current_labels(list(reversed(points)))[::-1]
    assert adjusted_rand_score(baseline, reversed_labels) == 1, 'Input order changed the partition'
    output = dict(points=xy.tolist(), secondNeighborStep=step, results=results, stability=stability,
                  note='No reference engineering labels. Cluster counts and ARI stability do not measure engineering correctness. Unassigned points are retained in the report.')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
