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


def visible_bounds(bounds: dict, areas: list[dict], fallback: dict) -> dict:
    """Keep a usable title strip on a currently connected monitor."""
    try:
        result = {key: int(bounds[key]) for key in ('x', 'y', 'width', 'height')}
        result['width'] = max(260, min(2400, result['width']))
        result['height'] = max(180, min(2000, result['height']))
        for area in areas:
            if (min(result['x'] + result['width'], area['x'] + area['width']) - max(result['x'], area['x']) >= 100
                    and area['y'] <= result['y'] < area['y'] + area['height'] - 35):
                return result
    except (KeyError, TypeError, ValueError, OverflowError):
        pass
    return dict(fallback)


class NativePanelWindows:
    def __init__(self, window, config_dir: Path):
        self.window = window
        self.config_file = config_dir / 'detached_windows.json'
        self.panels = {}
        self.shutting_down = False

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
        try:
            data = json.loads(self.config_file.read_text(encoding='utf-8'))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _save_bounds(self, panel_id, form):
        if self.shutting_down or form.WindowState != self.forms.FormWindowState.Normal:
            return
        values = self._saved_bounds()
        values[panel_id] = {'x': form.Left, 'y': form.Top, 'width': form.Width, 'height': form.Height}
        try:
            self.config_file.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.config_file.with_suffix('.json.tmp')
            temporary.write_text(json.dumps(values, ensure_ascii=False, indent=2), encoding='utf-8')
            temporary.replace(self.config_file)
        except OSError:
            logging.exception('Could not save detached panel bounds')

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
        areas = [{'x': screen.WorkingArea.X, 'y': screen.WorkingArea.Y,
                  'width': screen.WorkingArea.Width, 'height': screen.WorkingArea.Height}
                 for screen in self.forms.Screen.AllScreens]
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
            if not record['closing'] and not self.shutting_down:
                # Move the live portal back before disposing its document.
                event.Cancel = True
                self._event('closePanel', panel_id)

        def closed(*_):
            self._save_bounds(panel_id, form)
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
        self.shutting_down = True
        for panel_id in list(self.panels):
            self._close(panel_id)

    def _main_closed(self, *_):
        self.shutdown()
