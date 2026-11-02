import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from app.desktop_panels import parse_panel_request, visible_bounds


class NativePanelPolicyTests(unittest.TestCase):
    def test_only_internal_panel_requests_are_handled(self):
        self.assertEqual(parse_panel_request('about:blank#pile-panel?id=point-info&title=Point&drag=1'),
                         {'id': 'point-info', 'title': 'Point', 'drag': True})
        for uri in ('https://example.com', 'about:blank', 'about:blank#pile-panel?id=../file',
                    'about:blank#pile-panel?id=', 'about:blank#pile-panel?id=x' + 'a' * 90):
            self.assertIsNone(parse_panel_request(uri))

    def test_left_monitor_and_missing_monitor(self):
        left = {'x': -1920, 'y': 0, 'width': 1920, 'height': 1080}
        main = {'x': 0, 'y': 0, 'width': 1920, 'height': 1080}
        fallback = {'x': 100, 'y': 100, 'width': 500, 'height': 600}
        bounds = {'x': -1500, 'y': 100, 'width': 500, 'height': 600}
        self.assertEqual(visible_bounds(bounds, [left, main], fallback), bounds)
        self.assertEqual(visible_bounds(bounds, [main], fallback), fallback)
        self.assertEqual(visible_bounds({'x': 'bad'}, [main], fallback), fallback)
        self.assertEqual(visible_bounds({**bounds, 'y': -1000}, [left, main], fallback), fallback)


if __name__ == '__main__': unittest.main()
