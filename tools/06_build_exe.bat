@echo off
setlocal EnableExtensions
chcp 65001 >nul

rem ============================================================
rem 06_build_exe.bat
rem Pile Numbering App - build desktop EXE with embedded WebView.
rem Produces: dist\PileNumbering.exe
rem ============================================================

cd /d "%~dp0.."
set "ROOT=%CD%"
set "LOG_DIR=%ROOT%\tools\out"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>nul
set "LOG_FILE=%LOG_DIR%\build_exe.log"
set "VENV_DIR=%ROOT%\backend\.venv"
set "VENV_PY=%VENV_DIR%\Scripts\python.exe"

> "%LOG_FILE%" echo Pile Numbering desktop exe builder
>> "%LOG_FILE%" echo Root: %ROOT%
>> "%LOG_FILE%" echo Started: %DATE% %TIME%
>> "%LOG_FILE%" echo.

echo ============================================================
echo Pile Numbering App - build desktop EXE
echo ============================================================
echo Root: %ROOT%
echo.

if not exist "%ROOT%\backend\app\main.py" (
    echo [ERROR] backend\app\main.py not found.
    >> "%LOG_FILE%" echo [ERROR] backend\app\main.py not found.
    goto fail
)
if not exist "%ROOT%\frontend\package.json" (
    echo [ERROR] frontend\package.json not found.
    >> "%LOG_FILE%" echo [ERROR] frontend\package.json not found.
    goto fail
)
if not exist "%ROOT%\tools\exe_launcher.py" (
    echo [ERROR] tools\exe_launcher.py not found.
    echo Extract the full patch into the project root first.
    >> "%LOG_FILE%" echo [ERROR] tools\exe_launcher.py not found.
    goto fail
)
if not exist "%ROOT%\backend\requirements.txt" (
    echo [ERROR] backend\requirements.txt not found.
    >> "%LOG_FILE%" echo [ERROR] backend\requirements.txt not found.
    goto fail
)

rem Find a real Python installed on THIS computer. backend\.venv is validated later;
rem copied venvs are not portable and may point to another user's WindowsApps path.
set "PYTHON_CMD="
where py >nul 2>nul
if not errorlevel 1 (
    py -3.12 -c "import sys" >nul 2>nul
    if not errorlevel 1 set "PYTHON_CMD=py -3.12"
)
if not defined PYTHON_CMD (
    where py >nul 2>nul
    if not errorlevel 1 (
        py -3.13 -c "import sys" >nul 2>nul
        if not errorlevel 1 set "PYTHON_CMD=py -3.13"
    )
)
if not defined PYTHON_CMD (
    where py >nul 2>nul
    if not errorlevel 1 (
        py -3 -c "import sys" >nul 2>nul
        if not errorlevel 1 set "PYTHON_CMD=py -3"
    )
)
if not defined PYTHON_CMD (
    where python >nul 2>nul
    if not errorlevel 1 (
        python -c "import sys" >nul 2>nul
        if not errorlevel 1 set "PYTHON_CMD=python"
    )
)
if not defined PYTHON_CMD (
    echo [ERROR] Python is not found. Install Python 3.12/3.13 and try again.
    >> "%LOG_FILE%" echo [ERROR] Python is not found.
    goto fail
)

echo [INFO] Python command: %PYTHON_CMD%
>> "%LOG_FILE%" echo [INFO] Python command: %PYTHON_CMD%
%PYTHON_CMD% --version >> "%LOG_FILE%" 2>&1

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js is not found in PATH.
    echo Install Node.js LTS first.
    >> "%LOG_FILE%" echo [ERROR] Node.js is not found.
    goto fail
)
where npm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] npm is not found in PATH.
    >> "%LOG_FILE%" echo [ERROR] npm is not found.
    goto fail
)

call :ensure_backend_venv || goto fail_with_log

echo [INFO] Installing Python dependencies...
>> "%LOG_FILE%" echo [INFO] Installing Python dependencies.
"%VENV_PY%" -m pip install --upgrade pip >> "%LOG_FILE%" 2>&1
if errorlevel 1 goto fail_with_log
"%VENV_PY%" -m pip install -r "%ROOT%\backend\requirements.txt" pyinstaller pywebview >> "%LOG_FILE%" 2>&1
if errorlevel 1 goto fail_with_log

echo [INFO] Installing frontend dependencies and building frontend...
>> "%LOG_FILE%" echo [INFO] Building frontend.
pushd "%ROOT%\frontend" >nul
call npm install >> "%LOG_FILE%" 2>&1
if errorlevel 1 (
    popd >nul
    goto fail_with_log
)
call npm list xlsx --depth=0 >> "%LOG_FILE%" 2>&1
if errorlevel 1 (
    echo [INFO] xlsx package is missing. Installing explicitly...
    >> "%LOG_FILE%" echo [INFO] xlsx package is missing. Installing explicitly.
    call npm install xlsx >> "%LOG_FILE%" 2>&1
    if errorlevel 1 (
        popd >nul
        goto fail_with_log
    )
)
rem Build frontend for same-origin API inside the desktop app.
set "VITE_API_BASE=."
call npm run build >> "%LOG_FILE%" 2>&1
if errorlevel 1 (
    popd >nul
    goto fail_with_log
)
popd >nul

if not exist "%ROOT%\frontend\dist\index.html" (
    echo [ERROR] frontend\dist\index.html not found after build.
    >> "%LOG_FILE%" echo [ERROR] frontend build output missing.
    goto fail
)

if not exist "%ROOT%\projects" mkdir "%ROOT%\projects" >nul 2>nul
if not exist "%ROOT%\config" mkdir "%ROOT%\config" >nul 2>nul
if not exist "%ROOT%\data\images" mkdir "%ROOT%\data\images" >nul 2>nul

set "EXE_ICON="
if exist "%ROOT%\config\app_icon.ico" set "EXE_ICON=%ROOT%\config\app_icon.ico"
if not defined EXE_ICON if exist "%ROOT%\dist\config\app_icon.ico" set "EXE_ICON=%ROOT%\dist\config\app_icon.ico"
if not defined EXE_ICON set "EXE_ICON=%ROOT%\tools\app_icon.ico"
if defined EXE_ICON (
    echo [INFO] EXE icon: %EXE_ICON%
    >> "%LOG_FILE%" echo [INFO] EXE icon: %EXE_ICON%
) else (
    echo [INFO] EXE icon: default PyInstaller icon
    >> "%LOG_FILE%" echo [INFO] EXE icon: default PyInstaller icon
)

echo [INFO] Building desktop EXE with PyInstaller...
>> "%LOG_FILE%" echo [INFO] Running PyInstaller.
"%VENV_PY%" -m PyInstaller ^
  --noconfirm ^
  --clean ^
  --onefile ^
  --windowed ^
  --name "PileNumbering" ^
  --icon "%EXE_ICON%" ^
  --paths "%ROOT%\backend" ^
  --add-data "%ROOT%\frontend\dist;frontend_dist" ^
  --collect-all webview ^
  --collect-submodules uvicorn ^
  --collect-submodules fastapi ^
  --collect-submodules starlette ^
  --collect-submodules pydantic ^
  --collect-submodules win32com ^
  --hidden-import app.main ^
  --hidden-import app.schemas ^
  --hidden-import app.io_project ^
  --hidden-import app.numbering_rows ^
  --hidden-import app.numbering_route ^
  --hidden-import app.numbering_vector ^
  --hidden-import app.numbering_manual ^
  --hidden-import app.clustering_auto ^
  --hidden-import app.sync_import ^
  --hidden-import uvicorn.logging ^
  --hidden-import uvicorn.loops.auto ^
  --hidden-import uvicorn.protocols.http.auto ^
  --hidden-import uvicorn.protocols.websockets.auto ^
  --hidden-import uvicorn.lifespan.on ^
  --hidden-import h11 ^
  --hidden-import anyio ^
  --hidden-import starlette.staticfiles ^
  --hidden-import starlette.responses ^
  --hidden-import webview.platforms.edgechromium ^
  --hidden-import win32com.client ^
  --hidden-import pythoncom ^
  --hidden-import pywintypes ^
  "%ROOT%\tools\exe_launcher.py" >> "%LOG_FILE%" 2>&1
if errorlevel 1 goto fail_with_log

if not exist "%ROOT%\dist\PileNumbering.exe" (
    echo [ERROR] dist\PileNumbering.exe was not created.
    >> "%LOG_FILE%" echo [ERROR] exe output missing.
    goto fail
)

if not exist "%ROOT%\dist\projects" mkdir "%ROOT%\dist\projects" >nul 2>nul
if not exist "%ROOT%\dist\config" mkdir "%ROOT%\dist\config" >nul 2>nul
if not exist "%ROOT%\dist\data\images" mkdir "%ROOT%\dist\data\images" >nul 2>nul
if exist "%ROOT%\README.md" copy "%ROOT%\README.md" "%ROOT%\dist\README.md" >nul 2>nul
if exist "%ROOT%\RULES.md" copy "%ROOT%\RULES.md" "%ROOT%\dist\RULES.md" >nul 2>nul
if exist "%ROOT%\FUNCTIONALITY_LOCK_RU.md" copy "%ROOT%\FUNCTIONALITY_LOCK_RU.md" "%ROOT%\dist\FUNCTIONALITY_LOCK_RU.md" >nul 2>nul
if defined EXE_ICON copy /Y "%EXE_ICON%" "%ROOT%\dist\PileNumbering.ico" >nul 2>nul

echo.
echo ============================================================
echo DESKTOP EXE BUILD COMPLETE
echo ============================================================
echo File: %ROOT%\dist\PileNumbering.exe
echo Projects folder: %ROOT%\dist\projects
echo Config folder:   %ROOT%\dist\config
echo Logs folder:     %ROOT%\dist\logs
echo.
echo The EXE opens its own application window, not a browser tab.
echo.
>> "%LOG_FILE%" echo [OK] EXE created: %ROOT%\dist\PileNumbering.exe
pause
exit /b 0

:ensure_backend_venv
set "VENV_BROKEN=0"
if exist "%VENV_PY%" (
    echo [INFO] Checking backend venv portability...
    >> "%LOG_FILE%" echo [INFO] Checking backend venv portability: %VENV_PY%
    "%VENV_PY%" -c "import sys; print(sys.executable)" >> "%LOG_FILE%" 2>&1
    if errorlevel 1 set "VENV_BROKEN=1"
)

if "%VENV_BROKEN%"=="1" (
    echo [WARN] Existing backend\.venv is broken or copied from another PC. Recreating it...
    >> "%LOG_FILE%" echo [WARN] Existing backend\.venv is broken or copied from another PC. Recreating it.
    if exist "%VENV_DIR%\pyvenv.cfg" (
        >> "%LOG_FILE%" echo [INFO] Old pyvenv.cfg:
        type "%VENV_DIR%\pyvenv.cfg" >> "%LOG_FILE%" 2>&1
    )
    rmdir /s /q "%VENV_DIR%" >> "%LOG_FILE%" 2>&1
    if exist "%VENV_DIR%" (
        echo [ERROR] Failed to remove broken backend\.venv. Close Python/cmd windows and retry.
        >> "%LOG_FILE%" echo [ERROR] Failed to remove broken backend\.venv.
        exit /b 1
    )
)

if not exist "%VENV_PY%" (
    echo [INFO] Creating backend virtual environment...
    >> "%LOG_FILE%" echo [INFO] Creating backend virtual environment with: %PYTHON_CMD%
    %PYTHON_CMD% -m venv "%VENV_DIR%" >> "%LOG_FILE%" 2>&1
    if errorlevel 1 exit /b 1
)

"%VENV_PY%" -c "import sys; print('VENV OK', sys.executable)" >> "%LOG_FILE%" 2>&1
if errorlevel 1 (
    echo [ERROR] backend\.venv still does not start after recreate.
    >> "%LOG_FILE%" echo [ERROR] backend\.venv still does not start after recreate.
    exit /b 1
)
exit /b 0

:fail_with_log
echo [ERROR] Build failed. Last log lines:
echo ------------------------------------------------------------
powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Test-Path -LiteralPath '%LOG_FILE%') { Get-Content -LiteralPath '%LOG_FILE%' -Tail 120 }"
echo ------------------------------------------------------------
goto fail

:fail
echo.
echo ============================================================
echo FAILED
echo ============================================================
echo Log: %LOG_FILE%
echo.
pause
exit /b 1
