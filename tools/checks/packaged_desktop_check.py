"""Drive a copied release EXE on Windows and record an isolated restart check."""

import argparse
from contextlib import contextmanager
from contextvars import ContextVar
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile
import time
from urllib.request import ProxyHandler, build_opener
from uuid import uuid4

import win32con
import win32event
import win32gui
import win32process
import win32service
from websockets.sync.client import connect


ROOT = Path(__file__).resolve().parents[2]
PROJECT = 'DesktopSmoke'
WINDOW_TITLE = 'Нумератор свайного поля'
SETTINGS = '[data-panel-id="workspace-settings"]'
INTERVAL = f'{SETTINGS} input[type="number"][step="0.25"]'
OPENER = build_opener(ProxyHandler({}))
TEST_DESKTOP = ContextVar('test_desktop')


def wait_for(description, condition, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = condition()
        if result:
            return result
        time.sleep(0.1)
    raise TimeoutError(description)


class Page:
    def __init__(self, connection):
        self.connection = connection
        self.sequence = 0

    def evaluate(self, expression):
        self.sequence += 1
        self.connection.send(json.dumps({
            'id': self.sequence,
            'method': 'Runtime.evaluate',
            'params': {'expression': expression, 'returnByValue': True},
        }))
        while True:
            reply = json.loads(self.connection.recv(timeout=10))
            if reply.get('id') == self.sequence:
                break
        if 'error' in reply or 'exceptionDetails' in reply['result']:
            raise RuntimeError(f'Browser script failed: {expression}')
        return reply['result']['result'].get('value')

    def click(self, selector, text=None):
        match = 'true' if text is None else f'node.textContent.trim() === {json.dumps(text)}'
        script = f'''(() => {{
            const node = [...document.querySelectorAll({json.dumps(selector)})]
                .find(node => !node.disabled && node.getClientRects().length && ({match}));
            if (!node) return false;
            node.click();
            return true;
        }})()'''
        wait_for(f'Could not click {text or selector}', lambda: self.evaluate(script))

    def set_input(self, selector, value):
        assert self.evaluate(f'''(() => {{
            const input = document.querySelector({json.dumps(selector)});
            if (!input) return false;
            input.focus();
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, {json.dumps(value)});
            input.dispatchEvent(new Event('input', {{ bubbles: true }}));
            return true;
        }})()'''), selector

    def select_project(self, file_name):
        self.click('.startup-project-row small', file_name)
        wait_for('The project did not open', lambda: self.evaluate('!!document.querySelector(".ribbon-current-project")'))


def browser_target(port, backend_url):
    try:
        with OPENER.open(f'http://127.0.0.1:{port}/json/list', timeout=0.6) as response:
            pages = json.load(response)
    except OSError:
        return None
    for item in pages:
        if item.get('type') == 'page' and item.get('url', '').rstrip('/') == backend_url:
            address = item.get('webSocketDebuggerUrl', '')
            if address.startswith(f'ws://127.0.0.1:{port}/devtools/page/'):
                return address
    return None


@contextmanager
def launch(exe, phase):
    log = exe.parent / 'logs/exe_launcher.log'
    offset = log.stat().st_size if log.exists() else 0
    with socket.socket() as allocation:
        allocation.bind(('127.0.0.1', 0))
        port = allocation.getsockname()[1]
    env = {
        **os.environ,
        'WEBVIEW2_USER_DATA_FOLDER': str(exe.parent / f'webview-{phase}'),
        'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS': (
            f'--remote-debugging-port={port} --remote-debugging-address=127.0.0.1'
        ),
    }
    name = f'PileNumberingCheck-{uuid4().hex}'
    desktop = win32service.CreateDesktop(name, 0, win32con.GENERIC_ALL, None)
    desktop_token = TEST_DESKTOP.set(desktop)
    process = None

    def logs():
        if not log.exists():
            return ''
        with log.open('rb') as source:
            source.seek(offset)
            return source.read().decode('utf-8', errors='replace')

    def startup():
        if win32event.WaitForSingleObject(process, 0) == win32event.WAIT_OBJECT_0:
            raise RuntimeError(f'EXE exited during launch with status {win32process.GetExitCodeProcess(process)}')
        current = logs()
        if 'Desktop workspace ready' not in current:
            return None
        endpoint = re.search(r'Backend started: (http://127\.0\.0\.1:\d+)', current)
        worker = re.search(r'Started server process \[(\d+)\]', current)
        if endpoint and worker:
            return endpoint[1], int(worker[1])
        return None

    try:
        startup_info = win32process.STARTUPINFO()
        # Windows places the whole test process tree on this desktop without
        # switching which desktop the user sees.
        startup_info.lpDesktop = name
        process, thread, boot_pid, _ = win32process.CreateProcess(
            str(exe), subprocess.list2cmdline([str(exe)]), None, None, False,
            subprocess.CREATE_NO_WINDOW | win32con.CREATE_UNICODE_ENVIRONMENT, env, str(exe.parent), startup_info,
        )
        thread.Close()
        backend, pid = wait_for('EXE did not finish startup', startup, timeout=90)
        target = wait_for('Could not connect to the isolated WebView2 page', lambda: browser_target(port, backend))
        with connect(target, proxy=None, open_timeout=10, close_timeout=1) as connection:
            yield Page(connection), pid
        if win32event.WaitForSingleObject(process, 30000) != win32event.WAIT_OBJECT_0:
            raise TimeoutError('The test EXE did not close')
        exit_code = win32process.GetExitCodeProcess(process)
        assert exit_code == 0, exit_code
        assert 'Application closed' in logs()
    finally:
        try:
            if process is not None and win32event.WaitForSingleObject(process, 0) == win32event.WAIT_TIMEOUT:
                # Restrict cleanup to the bootloader started by this check and its children.
                subprocess.run(['taskkill', '/PID', str(boot_pid), '/T', '/F'],
                               capture_output=True, timeout=15, creationflags=subprocess.CREATE_NO_WINDOW)
                if win32event.WaitForSingleObject(process, 15000) != win32event.WAIT_OBJECT_0:
                    raise TimeoutError('Could not stop the test EXE')
        finally:
            if process is not None:
                process.Close()
            TEST_DESKTOP.reset(desktop_token)
            desktop.CloseDesktop()


def windows_of(pid):
    handles = []
    win32gui.EnumDesktopWindows(TEST_DESKTOP.get(), lambda hwnd, result: result.append(hwnd), handles)
    return [hwnd for hwnd in handles if win32gui.IsWindowVisible(hwnd)
            and win32process.GetWindowThreadProcessId(hwnd)[1] == pid]


def close_window(pid):
    def main_window():
        return next((hwnd for hwnd in windows_of(pid) if win32gui.GetWindowText(hwnd) == WINDOW_TITLE), None)

    win32gui.PostMessage(wait_for('Could not locate the test window', main_window), win32con.WM_CLOSE, 0, 0)


def save_dialog(pid):
    return next((hwnd for hwnd in windows_of(pid) if win32gui.GetClassName(hwnd) == '#32770'), None)


def confirm_save(pid, path):
    dialog = wait_for('Native Save dialog did not open', lambda: save_dialog(pid))
    children = []
    win32gui.EnumChildWindows(dialog, lambda hwnd, result: result.append(hwnd), children)
    fields = [hwnd for hwnd in children if win32gui.GetClassName(hwnd) == 'Edit'
              and win32gui.IsWindowVisible(hwnd) and win32gui.IsWindowEnabled(hwnd)]
    assert len(fields) == 1, 'Expected one editable file name field in the test Save dialog'
    win32gui.SendMessageTimeout(fields[0], win32con.WM_SETTEXT, 0, str(path), win32con.SMTO_ABORTIFHUNG, 3000)
    win32gui.PostMessage(dialog, win32con.WM_COMMAND, win32con.IDOK, win32gui.GetDlgItem(dialog, win32con.IDOK))


def check(exe, version, folder, result):
    projects = folder / 'projects'
    projects.mkdir()
    fixture = projects / 'original.pilenum.json'
    original = {'project': {'id': 'desktop-smoke-check', 'name': PROJECT},
                'points': [{'id': 'original-point', 'x': 120, 'y': 200, 'number': 1}], 'groups': []}
    fixture.write_text(json.dumps(original), encoding='utf-8')
    saved = projects / 'after-close.pilenum.json'
    tab = '.ribbon-tab-button'
    groups = 'button[data-tooltip^="Диспетчер групп"]'
    unnumbered = 'button[data-tooltip^="Проверить пустые"]'
    with launch(exe, 1) as (page, first_pid):
        assert page.evaluate('document.querySelector(".startup-eyebrow").textContent').endswith(f'· {version}')
        page.select_project(fixture.name)
        page.click(tab, 'Точки и нумерация')
        assert page.evaluate(f'document.querySelector({json.dumps(groups)}).getAttribute("aria-pressed")') == 'false'
        page.click(groups)
        page.click(tab, 'Вид')
        assert page.evaluate(f'document.querySelector({json.dumps(unnumbered)}).getAttribute("aria-pressed")') == 'false'
        result['firstStart'] = {'projectPicker': True, 'groupManagerClosed': True, 'unnumberedHighlightOff': True}
        page.click(unnumbered)
        page.click('button[data-tooltip^="Настройки рабочего поля"]')
        page.click(f'{SETTINGS} .settings-tab-button', 'Автосохр.')
        page.click(tab, 'Точки и нумерация')
        page.click('button[data-tooltip^="Создать точку"]')
        edit = '[data-panel-id="editing-panel"] .edit-command-card'
        page.click(f'{edit} button', 'Создать точку')
        page.evaluate('''(() => {
            const fetch = window.fetch.bind(window);
            const saveProjectJson = window.pywebview.api.saveProjectJson;
            let localSaveAcknowledged = false;
            window.pywebview.api.saveProjectJson = (...args) => {
                window.smokeNativeSaveInOrder = localSaveAcknowledged;
                return saveProjectJson(...args);
            };
            window.fetch = (input, options) => {
                if (!String(input).endsWith('/api/projects/local/save') || options?.method !== 'POST') {
                    return fetch(input, options);
                }
                window.fetch = fetch;
                return new Promise(resolve => { window.releaseSmokeSave = resolve; })
                    .then(() => fetch(input, options))
                    .then(response => {
                        localSaveAcknowledged = response.ok;
                        return response;
                    });
            };
        })()''')
        page.click(tab, 'Файл')
        page.click('button[data-tooltip^="Сохранить проект"]')
        wait_for('The earlier local save was not queued', lambda: page.evaluate('typeof window.releaseSmokeSave === "function"'))
        page.set_input(f'{edit} label:nth-of-type(1) input', '37')
        page.set_input(f'{edit} label:nth-of-type(2) input', '91')
        page.click(f'{edit} button', 'Создать точку')
        page.click(tab, 'Вид')
        page.set_input(INTERVAL, '9')
        close_window(first_pid)
        page.click('.close-project-dialog button', 'Сохранить')
        wait_for('The close guard did not begin saving', lambda: page.evaluate(
            'document.querySelector(".close-project-dialog .primary")?.disabled === true'))
        assert save_dialog(first_pid) is None, 'Native Save started while an earlier save was pending'
        page.evaluate('window.releaseSmokeSave()')
        wait_for('Native Save did not start', lambda: page.evaluate('typeof window.smokeNativeSaveInOrder === "boolean"'))
        assert page.evaluate('window.smokeNativeSaveInOrder'), 'Native Save started before the local save response'
        confirm_save(first_pid, saved)
    assert {(p['x'], p['y']) for p in json.loads(saved.read_bytes())['points']} == {(120, 200), (0, 0), (37, 91)}
    assert fixture.read_text(encoding='utf-8') == json.dumps(original), 'The original fixture was replaced'
    config = json.loads((folder / 'config/user_config.json').read_bytes())
    assert config['autosaveSettings']['intervalMinutes'] == 9
    assert config['workspace']['windows']['settings'] is True
    result['firstShutdown'] = {'queuedSaveBeforeNativeSave': True, 'savedPoints': 3, 'intervalMinutes': 9, 'returnCode': 0}
    with launch(exe, 2) as (page, second_pid):
        assert first_pid != second_pid
        assert page.evaluate('!!document.querySelector(".startup-screen")')
        page.select_project(saved.name)
        wait_for('Autosave settings panel did not restore', lambda: page.evaluate(
            f'document.querySelector({json.dumps(INTERVAL)})?.value === "9"'))
        assert page.evaluate('document.querySelector(".ribbon-tab-button.active").textContent.trim()') == 'Вид'
        assert page.evaluate(f'document.querySelector({json.dumps(unnumbered)}).getAttribute("aria-pressed")') == 'true'
        page.click(tab, 'Точки и нумерация')
        assert page.evaluate(f'document.querySelector({json.dumps(groups)}).getAttribute("aria-pressed")') == 'true'
        close_window(second_pid)
    result['restart'] = {'projectPicker': True, 'settingsWindowRestored': True, 'groupManagerRestored': True,
                         'unnumberedHighlightRestored': True, 'intervalMinutes': 9, 'returnCode': 0}
    result['isolatedDesktop'] = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('exe', type=Path)
    parser.add_argument('--version', required=True)
    args = parser.parse_args()
    out = ROOT / 'tools/out'
    out.mkdir(parents=True, exist_ok=True)
    folder = Path(tempfile.mkdtemp(prefix='packaged-desktop-', dir=out))
    exe = shutil.copy2(args.exe.resolve(strict=True), folder / 'PileNumbering.exe')
    result = {'version': args.version, 'executableSha256': hashlib.sha256(exe.read_bytes()).hexdigest(), 'passed': False}
    report = folder / 'result.json'
    try:
        check(exe, args.version, folder, result)
        result['passed'] = True
    except Exception as error:
        result['error'] = str(error)
        raise
    finally:
        report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(json.dumps(result, ensure_ascii=True), flush=True)
        print(f'Report: {report.relative_to(ROOT).as_posix()}', flush=True)


if __name__ == '__main__':
    main()
