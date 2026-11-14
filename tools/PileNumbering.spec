# -*- mode: python ; coding: utf-8 -*-
from pathlib import Path
import json
import runpy
ROOT = Path(SPECPATH).resolve().parent
from PyInstaller.utils.hooks import collect_submodules
from PyInstaller.utils.hooks import collect_all
from PyInstaller.utils.win32.versioninfo import VSVersionInfo, FixedFileInfo, StringFileInfo, StringTable, StringStruct, VarFileInfo, VarStruct

APP_VERSION = runpy.run_path(str(ROOT / 'backend' / 'app' / 'version.py'))['APP_VERSION']
if json.loads((ROOT / 'frontend' / 'package.json').read_text(encoding='utf-8'))['version'] != APP_VERSION:
    raise SystemExit('Frontend and backend release versions must match.')
version_tuple = tuple(int(part) for part in APP_VERSION.split('.')) + (0,)
version_info = VSVersionInfo(
    ffi=FixedFileInfo(filevers=version_tuple, prodvers=version_tuple, mask=0x3f, flags=0, OS=0x40004, fileType=1, subtype=0, date=(0, 0)),
    kids=[StringFileInfo([StringTable('040904B0', [
        StringStruct('FileDescription', 'Нумератор свайного поля'),
        StringStruct('FileVersion', APP_VERSION), StringStruct('ProductVersion', APP_VERSION),
        StringStruct('ProductName', 'PileNumbering'), StringStruct('OriginalFilename', 'PileNumbering.exe')
    ])]), VarFileInfo([VarStruct('Translation', [1033, 1200])])]
)

datas = [(str(ROOT / 'frontend' / 'dist'), 'frontend_dist')]
sdk_bridge = ROOT / 'cad_bridge' / 'bin' / 'nanoCAD26' / 'PileNumbering.Sdk26.nrx'
if not sdk_bridge.is_file():
    raise SystemExit('Build the nanoCAD 26 SDK bridge first: tools/09_build_sdk_bridge.ps1')
datas.append((str(sdk_bridge), 'cad_bridge'))
binaries = []
hiddenimports = ['app.main', 'app.cad_operations', 'app.schemas', 'app.io_project', 'app.numbering_rows', 'app.numbering_route', 'app.numbering_vector', 'app.numbering_manual', 'app.clustering_auto', 'app.clustering_methods', 'app.clustering_learning', 'app.sync_import', 'uvicorn.logging', 'uvicorn.loops.auto', 'uvicorn.protocols.http.auto', 'uvicorn.protocols.websockets.auto', 'uvicorn.lifespan.on', 'h11', 'anyio', 'starlette.staticfiles', 'starlette.responses', 'webview.platforms.edgechromium', 'win32com.client', 'pythoncom', 'pywintypes']
hiddenimports += collect_submodules('uvicorn')
hiddenimports += ['app.sdk_bridge', 'app.desktop_panels']
hiddenimports += collect_submodules('fastapi')
hiddenimports += collect_submodules('starlette')
hiddenimports += collect_submodules('pydantic')
hiddenimports += collect_submodules('win32com')
tmp_ret = collect_all('webview')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]


a = Analysis(
    [str(ROOT / 'tools' / 'exe_launcher.py')],
    pathex=[str(ROOT / 'backend')],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

# Use TkDefaultFont: PyInstaller inserts custom family names into Tcl unquoted,
# so a multiword name such as Segoe UI aborts the splash before it is displayed.
splash = Splash(str(ROOT / 'tools' / 'splash.png'), binaries=a.binaries, datas=a.datas, text_pos=(32, 332), text_size=11, text_color='#b6dbf5', text_default='Загрузка программы…', always_on_top=True)

exe = EXE(
    pyz,
    a.scripts,
    splash,
    splash.binaries,
    a.binaries,
    a.datas,
    [],
    name='PileNumbering',
    version=version_info,
    icon=str(ROOT / 'config' / 'app_icon.ico') if (ROOT / 'config' / 'app_icon.ico').exists() else str(ROOT / 'tools' / 'app_icon.ico'),
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
