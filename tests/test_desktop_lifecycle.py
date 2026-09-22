import importlib.util
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import MagicMock, patch

spec = importlib.util.spec_from_file_location('desktop_launcher', Path(__file__).parents[1] / 'tools' / 'exe_launcher.py')
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class Window:
    def __init__(self):
        self.closed = False
        self.notified = threading.Event()
        self.script = ''

    def destroy(self):
        self.closed = True

    def evaluate_js(self, script):
        self.script = script
        self.notified.set()


class DesktopLifecycleTest(unittest.TestCase):
    def test_start_does_not_wait_for_window_before_gui_loop(self):
        webview = MagicMock()
        with patch.dict('sys.modules', {'webview': webview}), \
                patch.object(launcher, '_prepare_app'), \
                patch.object(launcher, '_start_backend'), \
                patch.object(launcher, '_wait_for_backend'), \
                patch.object(launcher, '_find_free_port', return_value=12345), \
                patch.object(launcher, '_configure_local_proxy_bypass'), \
                patch.object(launcher, '_splash_message'), \
                patch.object(launcher.os, 'chdir'):
            self.assertEqual(launcher.main(), 0)
        self.assertTrue(webview.create_window.call_args.kwargs['maximized'])
        webview.create_window.return_value.maximize.assert_not_called()
        webview.start.assert_called_once()

    def test_splash_waits_for_both_window_and_first_paint(self):
        for order in [('frontendReady', '_on_shown'), ('_on_shown', 'frontendReady')]:
            api = launcher.DesktopApi()
            with patch.object(launcher, '_splash_close') as close:
                getattr(api, order[0])()
                close.assert_not_called()
                getattr(api, order[1])()
                close.assert_called_once()

    def test_close_waits_for_frontend_decision(self):
        api = launcher.DesktopApi()
        api._window = Window()
        with patch.object(launcher, '_splash_close'):
            api.frontendReady()
        self.assertFalse(api._on_closing())
        self.assertTrue(api._window.notified.wait(1))
        self.assertIn('pile-numbering:close-requested', api._window.script)
        self.assertFalse(api._window.closed)
        # Cancel leaves the application open; only the confirmed action destroys it.
        api.closeConfirmed()
        self.assertTrue(api._window.closed)
        self.assertTrue(api._on_closing())

    def test_can_close_during_startup(self):
        with patch.object(launcher, '_splash_close'):
            self.assertTrue(launcher.DesktopApi()._on_closing())

    def test_failed_replace_preserves_existing_project(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'field.json'
            path.write_text('old', encoding='utf-8')
            with patch.object(Path, 'replace', side_effect=OSError('disk error')):
                with self.assertRaises(OSError):
                    launcher._atomic_write_project(path, 'new')
            self.assertEqual(path.read_text(encoding='utf-8'), 'old')
            self.assertEqual(list(Path(folder).iterdir()), [path])
            launcher._atomic_write_project(path, 'new')
            self.assertEqual(path.read_text(encoding='utf-8'), 'new')


if __name__ == '__main__':
    unittest.main()
