import json
import math
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from app.clustering_methods import ClusterPreviewRequest, preview_clusters
from app.clustering_learning import LabeledField, normalized_training_field


METHODS = ['branches', 'bands', 'hdbscan', 'dbscan', 'optics', 'count']


def field():
    return [{'id': str(i), 'x': (i % 4) * 2 + (i // 16) * 50, 'y': ((i % 16) // 4) * 2,
             'groupId': str(i // 16), 'number': i + 1} for i in range(48)]


def partition(result):
    return sorted(tuple(sorted(g)) for g in result['clusters']), sorted(result['unassignedIds'])


class ClusteringMethods(unittest.TestCase):
    def run_method(self, points, method, **options):
        return preview_clusters(ClusterPreviewRequest(points=points, options={'method': method, 'clusterCount': 3, **options}))

    def test_all_methods_preserve_every_point_without_mutation(self):
        points = field()
        before = json.dumps(points)
        for method in METHODS:
            with self.subTest(method=method):
                result = self.run_method(points, method)
                ids = sum(result['clusters'], []) + result['unassignedIds']
                self.assertEqual(len(ids), len(set(ids)))
                self.assertEqual(set(ids), {p['id'] for p in points})
                self.assertEqual(json.dumps(points), before)

    def test_methods_are_scale_translation_and_input_order_invariant(self):
        points = field()
        transformed = [{**p, 'x': p['x'] * 1000 + 123456, 'y': p['y'] * 1000 - 50000} for p in reversed(points)]
        for method in METHODS:
            with self.subTest(method=method):
                self.assertEqual(partition(self.run_method(points, method)), partition(self.run_method(transformed, method)))

    def test_requested_count_and_distant_islands(self):
        result = self.run_method(field(), 'count')
        self.assertEqual(sorted(map(len, result['clusters'])), [16, 16, 16])
        for method in ('hdbscan', 'dbscan'):
            result = self.run_method(field(), method)
            self.assertEqual(len(result['clusters']), 3)
            self.assertFalse(result['unassignedIds'])

    def test_bands_respect_rotated_angle_and_split_gaps(self):
        original = [{'id': f'{y}-{x}', 'x': x, 'y': y} for y in (0, 6) for x in (0, 1, 2, 20, 21, 22)]
        angle = math.radians(30)
        rotated = [{**p, 'x': p['x']*math.cos(angle)-p['y']*math.sin(angle),
                    'y': p['x']*math.sin(angle)+p['y']*math.cos(angle)} for p in original]
        expected = self.run_method(original, 'bands', autoAngle=False, angle=0)
        actual = self.run_method(rotated, 'bands', autoAngle=False, angle=30)
        self.assertEqual(len(expected['clusters']), 4)
        self.assertEqual(partition(expected), partition(actual))

    def test_branch_cuts_a_right_angle_but_keeps_straight_run(self):
        line = [{'id': str(i), 'x': i, 'y': 0} for i in range(10)]
        elbow = line + [{'id': 'v'+str(i), 'x': 9, 'y': i} for i in range(1, 8)]
        self.assertEqual(len(self.run_method(line, 'branches')['clusters']), 1)
        self.assertEqual(len(self.run_method(elbow, 'branches')['clusters']), 2)

    def test_duplicates_and_collinear_fields_are_supported(self):
        points = [{'id': str(i), 'x': 0, 'y': i // 2} for i in range(20)]
        for method in METHODS:
            with self.subTest(method=method):
                result = self.run_method(points, method)
                self.assertEqual(len(sum(result['clusters'], []) + result['unassignedIds']), 20)
                labels = {id: n for n, group in enumerate(result['clusters']) for id in group}
                for i in range(0, 20, 2):
                    self.assertEqual(labels.get(str(i)), labels.get(str(i+1)))

    def test_invalid_ids_coordinates_and_count_rejected(self):
        for points, options in [([{'id':'a','x':0,'y':0}, {'id':'a','x':1,'y':1}], {}),
                                ([{'id':'a','x':float('inf'),'y':0}, {'id':'b','x':1,'y':1}], {}),
                                ([{'id':'a','x':0,'y':0}, {'id':'b','x':0,'y':0}], {'clusterCount':2})]:
            with self.assertRaises(ValueError):
                self.run_method(points, 'count', **options)

    def test_noise_remains_explicitly_unassigned(self):
        points = [{'id': str(i), 'x': i*10, 'y': 0} for i in range(8)]
        result = self.run_method(points, 'dbscan', radiusFactor=.1)
        self.assertEqual(len(result['unassignedIds']), 8)
        self.assertEqual(result['clusters'], [])

    def test_dense_dbscan_rejects_excessive_neighbour_storage(self):
        points = [{'id': str(i), 'x': 0, 'y': 0} for i in range(2300)]
        with self.assertRaisesRegex(ValueError, 'HDBSCAN'):
            self.run_method(points, 'dbscan')

    def test_future_learning_requires_confirmed_fields_and_normalizes_scale(self):
        points = field()
        with self.assertRaises(ValueError):
            normalized_training_field(LabeledField(fieldId='test', points=points))
        first = normalized_training_field(LabeledField(fieldId='test', points=points, confirmed=True))
        second = normalized_training_field(LabeledField(fieldId='test', points=[{**p,'x':p['x']*1000+30,'y':p['y']*1000-90} for p in points], confirmed=True))
        np.testing.assert_allclose([[p['x'],p['y']] for p in first['points']], [[p['x'],p['y']] for p in second['points']], atol=1e-12)
