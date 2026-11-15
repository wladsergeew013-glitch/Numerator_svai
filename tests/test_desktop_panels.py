import sys
import unittest
import tempfile
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from app.desktop_panels import NativePanelWindows, parse_panel_request, visible_bounds, read_window_layout, save_window_bounds


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

    def test_window_layout_merges_independent_windows_and_survives_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / 'detached_windows.json'
            def save(index):
                save_window_bounds(target, f'panel-{index}', {'x': index, 'y': 40, 'width': 400, 'height': 500, 'state': 'normal'})
            with ThreadPoolExecutor(4) as pool:
                list(pool.map(save, range(8)))
            fresh = NativePanelWindows(None, Path(folder))
            self.assertEqual(len(fresh._saved_bounds()), 8)
            self.assertEqual(fresh._saved_bounds()['panel-7']['x'], 7)
            self.assertFalse(list(Path(folder).glob('*.tmp')))

    def test_shutdown_captures_normal_bounds_of_maximized_and_minimized_windows(self):
        with tempfile.TemporaryDirectory() as folder:
            manager = NativePanelWindows(None, Path(folder))
            manager.forms = SimpleNamespace(FormWindowState=SimpleNamespace(Normal=0,Maximized=1,Minimized=2))
            rect = SimpleNamespace(X=-1450,Y=40,Width=1250,Height=800)
            main = SimpleNamespace(IsDisposed=False,WindowState=1,RestoreBounds=rect)
            popup = SimpleNamespace(IsDisposed=False,WindowState=2,RestoreBounds=rect)
            main.Close = lambda: None
            popup.Close = lambda: None
            manager.owner = main
            manager.panels = {'settings':{'form':popup}}
            manager.bounds_timer = SimpleNamespace(Stop=lambda:None)
            save_window_bounds(manager.config_file,'settings',{'state':'maximized'})
            manager.shutdown()
            values = read_window_layout(manager.config_file)
            self.assertEqual(values['__main__'],{'x':-1450,'y':40,'width':1250,'height':800,'state':'maximized'})
            self.assertEqual(values['settings']['state'],'maximized','Minimizing must preserve the previous restore mode')
            self.assertEqual(values['settings']['width'],1250)
            self.assertTrue(manager.shutting_down)
            manager.shutdown()  # Idempotent after forms have already closed.

    def test_main_restore_recovers_from_a_disconnected_monitor(self):
        with tempfile.TemporaryDirectory() as folder:
            manager = NativePanelWindows(None, Path(folder))
            area = SimpleNamespace(X=0,Y=0,Width=1920,Height=1080)
            manager.forms = SimpleNamespace(FormWindowState=SimpleNamespace(Normal=0,Maximized=1),
                FormStartPosition=SimpleNamespace(Manual=3),Screen=SimpleNamespace(FromControl=lambda _:SimpleNamespace(WorkingArea=area)))
            manager.Point = lambda x,y:(x,y)
            manager.Size = lambda w,h:(w,h)
            manager._areas = lambda:[{'x':0,'y':0,'width':1920,'height':1080}]
            manager.owner = SimpleNamespace(WindowState=1)
            save_window_bounds(manager.config_file,'__main__',{'x':-1500,'y':10,'width':1200,'height':750,'state':'normal'})
            manager._restore_main_bounds()
            self.assertEqual(manager.owner.Location,(0,0))
            self.assertEqual(manager.owner.Size,(1500,950))
            self.assertEqual(manager.owner.WindowState,0)


if __name__ == '__main__': unittest.main()
