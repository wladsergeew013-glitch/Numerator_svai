"""Native WebView2 popup hosts for the existing React panel tree.

The popup shares the opener's WebView2 environment/profile and about:blank
origin. React keeps one portal container, moved between the two documents.
No second project store, event relay, or copy of the application is created.
"""
from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from urllib.parse import parse_qs
from app.project_files import atomic_write_project, project_file_lock


def parse_panel_request(uri: str) -> dict | None:
    prefix = 'about:blank#pile-panel?'
    if not uri.startswith(prefix) or len(uri) > 3000:
        return None
    values = parse_qs(uri[len(prefix):])
    panel_id = values.get('id', [''])[0]
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,79}', panel_id):
        return None
    return {'id': panel_id, 'title': values.get('title', ['Панель'])[0][:150],
            'drag': values.get('drag', ['0'])[0] == '1'}


def visible_bounds(bounds: dict, areas: list[dict], fallback: dict, *, minimum=(260, 180), maximum=(2400, 2000)) -> dict:
    """Keep a usable title strip on a currently connected monitor."""
    try:
        result = {key: int(bounds[key]) for key in ('x', 'y', 'width', 'height')}
        result['width'] = max(minimum[0], min(maximum[0], result['width']))
        result['height'] = max(minimum[1], min(maximum[1], result['height']))
        for area in areas:
            if (min(result['x'] + result['width'], area['x'] + area['width']) - max(result['x'], area['x']) >= 100
                    and area['y'] <= result['y'] < area['y'] + area['height'] - 35):
                return result
    except (KeyError, TypeError, ValueError, OverflowError):
        pass
    return dict(fallback)


def read_window_layout(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
        return {key: value for key, value in data.items() if isinstance(value, dict)} if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_window_bounds(path: Path, window_id: str, bounds: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with project_file_lock(path):
        values = read_window_layout(path)
        values[window_id] = bounds
        atomic_write_project(path, json.dumps(values, ensure_ascii=False, indent=2))


class NativePanelWindows:
    def __init__(self, window, config_dir: Path):
        self.window = window
        self.config_file = config_dir / 'detached_windows.json'
        self.panels = {}
        self.shutting_down = False
        self.dirty_bounds = {}

    def install(self):
        # Called on the WinForms thread after pywebview's main WebView is ready.
        from System import Action
        from System.Drawing import Color, Point, Size
        import System.Windows.Forms as forms
        from Microsoft.Web.WebView2.WinForms import WebView2, CoreWebView2CreationProperties
        self.Action, self.Color, self.Point, self.Size = Action, Color, Point, Size
        self.forms, self.WebView2, self.CreationProperties = forms, WebView2, CoreWebView2CreationProperties
        self.owner = self.window.native
        self.browser = self.owner.browser
        self.core = self.owner.webview.CoreWebView2
        self.original_handler = self.browser.on_new_window_request
        self.core.NewWindowRequested -= self.original_handler
        self.core.NewWindowRequested += self._new_window
        self.bounds_timer = forms.Timer()
        self.bounds_timer.Interval = 200
        self.bounds_timer.Tick += self._flush_bounds
        self._restore_main_bounds()
        self.owner.Move += lambda *_: self._queue_bounds('__main__', self.owner)
        self.owner.Resize += lambda *_: self._queue_bounds('__main__', self.owner)
        self.owner.FormClosed += self._main_closed
        self._notify("window.pileNativePanelsReady=true;window.dispatchEvent(new Event('pile-native-panels-ready'))")
        logging.info('Native panel windows ready (shared WebView2 environment)')

    def _notify(self, script):
        if not self.shutting_down:
            self.core.ExecuteScriptAsync(script)

    def _event(self, name, panel_id, **values):
        payload = json.dumps({'id': panel_id, **values}, ensure_ascii=True)
        self._notify(f'window.__pilePanels?.{name}({payload})')

    def _saved_bounds(self):
        return read_window_layout(self.config_file)

    def _areas(self):
        return [{'x': screen.WorkingArea.X, 'y': screen.WorkingArea.Y,
                 'width': screen.WorkingArea.Width, 'height': screen.WorkingArea.Height}
                for screen in self.forms.Screen.AllScreens]

    def _restore_main_bounds(self):
        saved = self._saved_bounds().get('__main__')
        if not isinstance(saved, dict):
            return  # First launch keeps the existing maximized default.
        area = self.forms.Screen.FromControl(self.owner).WorkingArea
        fallback = {'x': area.X, 'y': area.Y, 'width': min(1500, area.Width), 'height': min(950, area.Height)}
        bounds = visible_bounds(saved, self._areas(), fallback, minimum=(1100, 700), maximum=(16384, 16384))
        self.owner.WindowState = self.forms.FormWindowState.Normal
        self.owner.StartPosition = self.forms.FormStartPosition.Manual
        self.owner.Location = self.Point(bounds['x'], bounds['y'])
        self.owner.Size = self.Size(bounds['width'], bounds['height'])
        if saved.get('state') == 'maximized':
            self.owner.WindowState = self.forms.FormWindowState.Maximized

    def _save_bounds(self, panel_id, form, *, strict=False):
        if form.IsDisposed:
            return
        normal = form.WindowState == self.forms.FormWindowState.Normal
        rect = form.Bounds if normal else form.RestoreBounds
        old = self._saved_bounds().get(panel_id, {})
        state = ('normal' if normal else 'maximized' if form.WindowState == self.forms.FormWindowState.Maximized
                 else old.get('state', 'normal'))
        bounds = {'x': rect.X, 'y': rect.Y, 'width': rect.Width, 'height': rect.Height, 'state': state}
        if old == bounds:
            return
        try:
            save_window_bounds(self.config_file, panel_id, bounds)
        except (OSError, TimeoutError):
            logging.exception('Could not save window bounds: %s', panel_id)
            if strict:
                raise

    def _queue_bounds(self, panel_id, form):
        if self.shutting_down:
            return
        self.dirty_bounds[panel_id] = form
        self.bounds_timer.Stop()
        self.bounds_timer.Start()

    def _flush_bounds(self, *_):
        self.bounds_timer.Stop()
        dirty, self.dirty_bounds = self.dirty_bounds, {}
        for panel_id, form in dirty.items():
            self._save_bounds(panel_id, form)

    def _new_window(self, sender, args):
        request = parse_panel_request(str(args.Uri))
        if request is None:
            self.original_handler(sender, args)
            return
        args.Handled = True
        panel_id = request['id']
        if panel_id in self.panels or self.shutting_down:
            return
        deferral = args.GetDeferral()
        form = self.forms.Form()
        view = self.WebView2()
        record = {'form': form, 'view': view, 'closing': False, 'moving': False}
        self.panels[panel_id] = record
        form.Text = request['title']
        form.Icon = self.owner.Icon
        form.BackColor = self.Color.FromArgb(17, 24, 39)
        form.StartPosition = self.forms.FormStartPosition.Manual
        form.MinimumSize = self.Size(280, 220)
        # Keep this a top-level window. WinForms closes owned forms *before*
        # asking the main form's unsaved-changes guard, even if closing is canceled.
        scale = float(self.owner._scale)
        features = args.WindowFeatures
        width = int(features.Width * scale) if features.HasSize else int(500 * scale)
        height = int(features.Height * scale) if features.HasSize else int(620 * scale)
        cursor = self.forms.Cursor.Position
        fallback = {'x': cursor.X - int(70 * scale), 'y': cursor.Y - int(16 * scale),
                    'width': max(280, width), 'height': max(220, height)}
        areas = self._areas()
        if not request['drag']:
            bounds = visible_bounds(self._saved_bounds().get(panel_id, {}), areas, fallback)
        else:
            bounds = fallback
        form.Location = self.Point(bounds['x'], bounds['y'])
        form.Size = self.Size(bounds['width'], bounds['height'])
        view.Dock = self.forms.DockStyle.Fill
        view.DefaultBackgroundColor = form.BackColor
        # A popup MUST use the same environment and profile as its opener.
        properties = self.CreationProperties()
        properties.ProfileName = self.core.Profile.ProfileName
        properties.IsInPrivateModeEnabled = self.core.Profile.IsInPrivateModeEnabled
        view.CreationProperties = properties
        form.Controls.Add(view)

        def ready(_, event):
            try:
                if not event.IsSuccess:
                    raise RuntimeError(str(event.InitializationException))
                child = view.CoreWebView2
                child.Settings.AreDefaultContextMenusEnabled = False
                child.Settings.IsStatusBarEnabled = False
                child.Settings.AreBrowserAcceleratorKeysEnabled = False
                child.Settings.AreDevToolsEnabled = False
                child.Settings.IsZoomControlEnabled = False
                def navigation(_, event):
                    uri = str(event.Uri)
                    if not uri.startswith('about:blank'):
                        event.Cancel = True
                        if uri.startswith(('https://', 'http://')):
                            import webbrowser
                            webbrowser.open(uri)
                child.NavigationStarting += navigation
                child.WindowCloseRequested += lambda *_: self._close(panel_id)
                child.NewWindowRequested += self.original_handler
                args.NewWindow = child
                deferral.Complete()
                form.Show()
                if not request['drag'] and self._saved_bounds().get(panel_id, {}).get('state') == 'maximized':
                    form.WindowState = self.forms.FormWindowState.Maximized
                self._event('nativeReady', panel_id)
                if request['drag']:
                    form.BeginInvoke(self.Action(lambda: self._begin_move(panel_id, only_if_pressed=True)))
                logging.info('Panel detached: %s', panel_id)
            except Exception:
                logging.exception('Could not initialize detached panel %s', panel_id)
                deferral.Complete()
                self._event('failed', panel_id)
                self._close(panel_id)

        def closing(_, event):
            self._save_bounds(panel_id, form)
            if not record['closing'] and not self.shutting_down:
                # Move the live portal back before disposing its document.
                event.Cancel = True
                self._event('closePanel', panel_id)

        def closed(*_):
            self.dirty_bounds.pop(panel_id, None)
            self.panels.pop(panel_id, None)
            view.Dispose()
            logging.info('Panel returned/closed: %s', panel_id)

        def move_begin(*_):
            record['moving'] = True
            record['start_location'] = (form.Left, form.Top)

        def move_progress(*_):
            if record['moving']:
                self._drag_event(panel_id, finished=False)

        def move_end(*_):
            moved = record.get('start_location') != (form.Left, form.Top)
            record['moving'] = False
            self._save_bounds(panel_id, form)
            if moved:
                self._drag_event(panel_id, finished=True)

        form.FormClosing += closing
        form.FormClosed += closed
        form.ResizeBegin += move_begin
        form.Move += move_progress
        form.Move += lambda *_: self._queue_bounds(panel_id, form)
        form.Resize += lambda *_: self._queue_bounds(panel_id, form)
        form.ResizeEnd += move_end
        view.CoreWebView2InitializationCompleted += ready
        # Create the native handle without navigating the new WebView.
        form.CreateControl()
        view.EnsureCoreWebView2Async(self.core.Environment)

    def _drag_event(self, panel_id, *, finished):
        if self.owner.WindowState == self.forms.FormWindowState.Minimized:
            return
        cursor = self.forms.Cursor.Position
        origin = self.owner.PointToScreen(self.Point(0, 0))
        scale = float(self.owner._scale)
        self._event('dragOver', panel_id, x=(cursor.X - origin.X) / scale,
                    y=(cursor.Y - origin.Y) / scale, finished=finished)

    def _begin_move(self, panel_id, *, only_if_pressed=False):
        import ctypes
        record = self.panels.get(panel_id)
        if not record:
            return
        user32 = ctypes.windll.user32
        if only_if_pressed and not user32.GetAsyncKeyState(1) & 0x8000:
            return
        user32.ReleaseCapture()
        # Use pointer-sized HWND; this also supports a 64-bit Python host.
        user32.SendMessageW.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_size_t, ctypes.c_ssize_t]
        user32.SendMessageW(record['form'].Handle.ToInt64(), 0xA1, 2, 0)  # WM_NCLBUTTONDOWN, HTCAPTION

    def begin_move(self, panel_id):
        self.owner.BeginInvoke(self.Action(lambda: self._begin_move(str(panel_id), only_if_pressed=True)))

    def _close(self, panel_id):
        record = self.panels.get(panel_id)
        if record:
            record['closing'] = True
            record['form'].Close()

    def shutdown(self):
        if self.shutting_down:
            return
        # Save BEFORE closing windows; RestoreBounds retains the normal size of
        # maximized windows. A minimized state never becomes the next startup.
        self._save_bounds('__main__', self.owner, strict=True)
        for panel_id, record in self.panels.items():
            self._save_bounds(panel_id, record['form'], strict=True)
        self.bounds_timer.Stop()
        self.shutting_down = True
        for panel_id in list(self.panels):
            self._close(panel_id)

    def _main_closed(self, *_):
        self.shutdown()
