# -*- mode: python ; coding: utf-8 -*-
from pathlib import Path
ROOT = Path(SPECPATH).resolve().parent
from PyInstaller.utils.hooks import collect_submodules
from PyInstaller.utils.hooks import collect_all

datas = [(str(ROOT / 'frontend' / 'dist'), 'frontend_dist')]
binaries = []
hiddenimports = ['app.main', 'app.cad_operations', 'app.schemas', 'app.io_project', 'app.numbering_rows', 'app.numbering_route', 'app.numbering_vector', 'app.numbering_manual', 'app.clustering_auto', 'app.clustering_methods', 'app.clustering_learning', 'app.sync_import', 'uvicorn.logging', 'uvicorn.loops.auto', 'uvicorn.protocols.http.auto', 'uvicorn.protocols.websockets.auto', 'uvicorn.lifespan.on', 'h11', 'anyio', 'starlette.staticfiles', 'starlette.responses', 'webview.platforms.edgechromium', 'win32com.client', 'pythoncom', 'pywintypes']
hiddenimports += collect_submodules('uvicorn')
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
