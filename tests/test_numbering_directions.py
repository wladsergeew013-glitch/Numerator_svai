import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from app.numbering_rows import build_rows_order
from app.schemas import PilePoint, NumberingSettings


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
