import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from app.numbering_rows import apply_numbering_rows, build_rows_order
from app.schemas import NumberingRowsRequest, NumberingSettings, PileGroup, PilePoint


class AxisDirections(unittest.TestCase):
    def test_rows_follow_x_columns_follow_y(self):
        points = [PilePoint(id=str(i), x=x, y=y) for i, (x, y) in enumerate(
            [(0, 10), (10, 10), (20, 10), (0, 0), (10, 0), (20, 0)])]
        cases = [
            ('rows', 'left_to_right_top_to_bottom', '012345'),
            ('rows', 'right_to_left_top_to_bottom', '210543'),
            ('rows', 'left_to_right_bottom_to_top', '345012'),
            ('rows', 'right_to_left_bottom_to_top', '543210'),
            ('rows', 'snake_rows_left_top', '012543'),
            ('rows', 'snake_rows_right_top', '210345'),
            ('columns', 'snake_columns_top_left', '034125'),
            ('columns', 'snake_columns_bottom_left', '301452'),
            ('columns', 'left_to_right_top_to_bottom', '031425'),
        ]
        for method, direction, expected in cases:
            with self.subTest(direction=direction, method=method):
                settings = NumberingSettings(method=method, direction=direction, rowTolerance=1, columnTolerance=1)
                self.assertEqual(''.join(p.id for p in build_rows_order(points, settings)), expected)

    def test_row_tolerance_keeps_compensated_center(self):
        coordinates = [1e12 + (index % 11) * .001 for index in range(129)]
        points = [PilePoint(id=str(index), x=index, y=value) for index, value in enumerate(coordinates)]
        edge = PilePoint(id='edge', x=1000, y=1e12 + 2)
        tolerance = edge.y - sum(sorted(coordinates)) / len(coordinates)
        for value, index in ((tolerance, -1), (math.nextafter(tolerance, 0), 0)):
            with self.subTest(tolerance=value):
                route = build_rows_order([*points, edge], NumberingSettings(rowTolerance=value))
                self.assertEqual(route[index].id, 'edge')
                self.assertEqual(len(route), len(points) + 1)

    def test_single_group_retains_untouched_points_in_input_order(self):
        points = [
            PilePoint(id='same', x=100, y=0, groupId='other', number=7),
            PilePoint(id='same', x=200, y=1, groupId='other', number=8),
            PilePoint(id='target-point', x=0, y=0, groupId='target'),
        ]
        groups = [PileGroup(id='other', name='Other', order=1), PileGroup(id='target', name='Target', order=2)]
        request = NumberingRowsRequest(points=points, groups=groups, groupId='target', numberingMode='per_group')
        result = apply_numbering_rows(request)
        self.assertEqual(result[:2], points[:2])
        self.assertEqual(result[2].number, 1)
        self.assertIsNone(request.points[2].number)
