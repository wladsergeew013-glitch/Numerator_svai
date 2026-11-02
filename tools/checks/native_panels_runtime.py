"""Windows-only native integration check; uses isolated data and no CAD."""
import json
import logging
import sys
from pathlib import Path
root = Path(__file__).resolve().parents[2]
sys.argv[0] = str(Path(__file__).resolve())
sys.path[:0] = [str(root / 'tools'), str(root / 'backend')]
import exe_launcher as launcher
import webview

folder = root / 'tools/out/native-panels-runtime-data'
(folder / 'logs').mkdir(parents=True, exist_ok=True)
launcher.APP_DIR = folder
launcher._frontend_dist_dir = lambda: root / 'tools/out/native-panels-runtime-ui'
logging.basicConfig(filename=folder / 'logs/runtime.log', level=logging.INFO, encoding='utf-8', force=True)

class Api(launcher.DesktopApi):
    def drop(self, panel_id, x, y):
        from System import Action
        self._window.native.Invoke(Action(lambda: self._panels._event('dragOver', panel_id, x=x, y=y, finished=True)))

    def closeNativePanel(self, panel_id):
        from System import Action
        self._window.native.Invoke(Action(lambda: self._panels.panels[panel_id]['form'].Close()))

    def openPanels(self):
        return list(self._panels.panels)

    def requestMainClose(self):
        from System import Action
        self._window.native.Invoke(Action(self._window.native.Close))

    def report(self, result):
        (folder / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        self.closeConfirmed()

app = launcher._prepare_app()
port = launcher._find_free_port()
thread = launcher._start_backend(app, '127.0.0.1', port)
launcher._wait_for_backend(f'http://127.0.0.1:{port}/health', thread)
api = Api()
window = webview.create_window('Проверка отдельных окон', f'http://127.0.0.1:{port}/native_panels_runtime.html',
                               width=1200, height=800, js_api=api, background_color='#111827')
api._window = window
window.events.closing += api._on_closing
webview.start(debug=False)
result_file = folder / 'result.json'
if result_file.exists():
    result = json.loads(result_file.read_text(encoding='utf-8'))
    result['mainCloseDestroysRemainingPanels'] = not bool(api._panels.panels)
    if not result['mainCloseDestroysRemainingPanels']: result['passed'] = False
    result_file.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
