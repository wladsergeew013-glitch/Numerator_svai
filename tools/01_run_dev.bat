@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul

REM ================================================================
REM run_dev.bat - Pile Numbering App
REM Location: <repo_root>\tools\01_run_dev.bat
REM
REM Fast local launch without Docker.
REM Full reinstall: tools\01_run_dev.bat --setup
REM ================================================================

set "TOOLS_DIR=%~dp0"
for %%I in ("%TOOLS_DIR%..") do set "ROOT=%%~fI"
set "OUT_DIR=%TOOLS_DIR%out"
if not exist "%OUT_DIR%" mkdir "%OUT_DIR%" >nul 2>nul

set "LOG=%OUT_DIR%\run_dev.log"
set "BACKEND_LAUNCHER=%OUT_DIR%\_start_backend.bat"
set "FRONTEND_LAUNCHER=%OUT_DIR%\_start_frontend.bat"
set "FORCE_SETUP=0"
if /I "%~1"=="--setup" set "FORCE_SETUP=1"

> "%LOG%" echo ============================================================
>>"%LOG%" echo RUN DEV - PILE NUMBERING APP
>>"%LOG%" echo ============================================================
>>"%LOG%" echo Started: %DATE% %TIME%
>>"%LOG%" echo Tools: %TOOLS_DIR%
>>"%LOG%" echo Root: %ROOT%
>>"%LOG%" echo Force setup: %FORCE_SETUP%
>>"%LOG%" echo.

echo ============================================================
echo RUN DEV - PILE NUMBERING APP
echo ============================================================
echo Root: %ROOT%
echo Log:  %LOG%
echo.

call :check_project || goto fail
call :find_python || goto fail
call :setup_backend || goto fail
call :setup_frontend || goto fail
call :write_launchers || goto fail

echo.
echo [OK] Setup complete.
echo [INFO] Starting backend and frontend in separate windows...
>>"%LOG%" echo [INFO] Starting backend and frontend windows...

start "Pile Numbering Backend" "%BACKEND_LAUNCHER%"
start "Pile Numbering Frontend" "%FRONTEND_LAUNCHER%"

timeout /t 3 /nobreak >nul
start "" "http://localhost:5173"

echo.
echo ============================================================
echo STARTED
echo ============================================================
echo Frontend: http://localhost:5173
echo Backend:  http://localhost:8000/health
echo.
echo Backend/frontend are running in separate cmd windows.
echo Do not close those windows while working.
echo.
pause
exit /b 0


:check_project
echo [INFO] Checking project files...
>>"%LOG%" echo [INFO] Checking project files...

if not exist "%ROOT%\backend\app\main.py" (
  echo [ERROR] Not found: %ROOT%\backend\app\main.py
  >>"%LOG%" echo [ERROR] Not found: %ROOT%\backend\app\main.py
  exit /b 1
)
if not exist "%ROOT%\backend\requirements.txt" (
  echo [ERROR] Not found: %ROOT%\backend\requirements.txt
  >>"%LOG%" echo [ERROR] Not found: %ROOT%\backend\requirements.txt
  exit /b 1
)
if not exist "%ROOT%\frontend\package.json" (
  echo [ERROR] Not found: %ROOT%\frontend\package.json
  >>"%LOG%" echo [ERROR] Not found: %ROOT%\frontend\package.json
  exit /b 1
)
exit /b 0


:find_python
echo [INFO] Searching Python...
>>"%LOG%" echo [INFO] Searching Python...
set "PY_CMD="

where py >nul 2>nul
if not errorlevel 1 (
  py -3.12 -c "import sys" >nul 2>nul
  if not errorlevel 1 set "PY_CMD=py -3.12"

  if not defined PY_CMD (
    py -3.13 -c "import sys" >nul 2>nul
    if not errorlevel 1 set "PY_CMD=py -3.13"
  )

  if not defined PY_CMD (
    py -3 -c "import sys" >nul 2>nul
    if not errorlevel 1 set "PY_CMD=py -3"
  )
)

if not defined PY_CMD (
  where python >nul 2>nul
  if not errorlevel 1 (
    python -c "import sys" >nul 2>nul
    if not errorlevel 1 set "PY_CMD=python"
  )
)

if not defined PY_CMD (
  echo [ERROR] Python not found. Install Python 3.12/3.13 or add python to PATH.
  >>"%LOG%" echo [ERROR] Python not found.
  exit /b 1
)

echo [OK] Python command: %PY_CMD%
>>"%LOG%" echo [OK] Python command: %PY_CMD%
%PY_CMD% --version >>"%LOG%" 2>&1
exit /b 0


:setup_backend
set "VENV_DIR=%ROOT%\backend\.venv"
set "VENV_PY=%VENV_DIR%\Scripts\python.exe"
set "VENV_BROKEN=0"

if "%FORCE_SETUP%"=="1" (
  if exist "%VENV_DIR%" (
    echo [INFO] Removing old backend venv (--setup)...
    >>"%LOG%" echo [INFO] Removing old backend venv (--setup)...
    rmdir /s /q "%VENV_DIR%" >>"%LOG%" 2>&1
  )
)

if exist "%VENV_PY%" (
  echo [INFO] Checking backend venv portability...
  >>"%LOG%" echo [INFO] Checking backend venv portability: %VENV_PY%
  "%VENV_PY%" -c "import sys; print(sys.executable)" >>"%LOG%" 2>&1
  if errorlevel 1 set "VENV_BROKEN=1"
)

if "%VENV_BROKEN%"=="1" (
  echo [WARN] Existing backend\.venv is broken or copied from another PC. Recreating it...
  >>"%LOG%" echo [WARN] Existing backend\.venv is broken or copied from another PC. Recreating it.
  if exist "%VENV_DIR%\pyvenv.cfg" (
    >>"%LOG%" echo [INFO] Old pyvenv.cfg:
    type "%VENV_DIR%\pyvenv.cfg" >>"%LOG%" 2>&1
  )
  rmdir /s /q "%VENV_DIR%" >>"%LOG%" 2>&1
  if exist "%VENV_DIR%" (
    echo [ERROR] Failed to remove broken backend\.venv. Close Python/cmd windows and retry.
    >>"%LOG%" echo [ERROR] Failed to remove broken backend\.venv.
    exit /b 1
  )
)

if not exist "%VENV_PY%" (
  echo [INFO] Creating backend virtual environment...
  >>"%LOG%" echo [INFO] Creating backend virtual environment with: %PY_CMD%
  %PY_CMD% -m venv "%VENV_DIR%" >>"%LOG%" 2>&1
  if errorlevel 1 (
    echo [ERROR] Failed to create backend venv.
    exit /b 1
  )
)

"%VENV_PY%" -c "import sys; print('VENV OK', sys.executable)" >>"%LOG%" 2>&1
if errorlevel 1 (
  echo [ERROR] backend\.venv still does not start after recreate.
  >>"%LOG%" echo [ERROR] backend\.venv still does not start after recreate.
  exit /b 1
)

echo [INFO] Installing backend requirements...
>>"%LOG%" echo [INFO] Installing backend requirements...
"%VENV_PY%" -m pip install --upgrade pip >>"%LOG%" 2>&1
if errorlevel 1 (
  echo [ERROR] Failed to upgrade pip.
  exit /b 1
)
"%VENV_PY%" -m pip install -r "%ROOT%\backend\requirements.txt" >>"%LOG%" 2>&1
if errorlevel 1 (
  echo [ERROR] Failed to install backend requirements.
  exit /b 1
)
exit /b 0


:setup_frontend
echo [INFO] Checking Node.js and npm...
>>"%LOG%" echo [INFO] Checking Node.js and npm...
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node not found. Install Node.js LTS.
  >>"%LOG%" echo [ERROR] node not found.
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm not found. Install Node.js LTS.
  >>"%LOG%" echo [ERROR] npm not found.
  exit /b 1
)
node --version >>"%LOG%" 2>&1
call npm --version >>"%LOG%" 2>&1

if "%FORCE_SETUP%"=="1" (
  if exist "%ROOT%\frontend\node_modules" (
    echo [INFO] Removing old frontend node_modules...
    >>"%LOG%" echo [INFO] Removing old frontend node_modules...
    rmdir /s /q "%ROOT%\frontend\node_modules" >>"%LOG%" 2>&1
  )
)

echo [INFO] Synchronizing frontend npm dependencies...
>>"%LOG%" echo [INFO] Synchronizing frontend npm dependencies...
pushd "%ROOT%\frontend"
call npm install >>"%LOG%" 2>&1
if errorlevel 1 (
  popd
  echo [ERROR] npm install failed.
  exit /b 1
)
call npm list xlsx --depth=0 >>"%LOG%" 2>&1
if errorlevel 1 (
  echo [INFO] xlsx package is missing. Installing explicitly...
  >>"%LOG%" echo [INFO] xlsx package is missing. Installing explicitly...
  call npm install xlsx >>"%LOG%" 2>&1
  if errorlevel 1 (
    popd
    echo [ERROR] Failed to install xlsx package.
    exit /b 1
  )
)
popd
exit /b 0


:write_launchers
echo [INFO] Writing helper launchers...
>>"%LOG%" echo [INFO] Writing helper launchers...

> "%BACKEND_LAUNCHER%" echo @echo off
>>"%BACKEND_LAUNCHER%" echo chcp 65001 ^>nul
>>"%BACKEND_LAUNCHER%" echo cd /d "%ROOT%\backend"
>>"%BACKEND_LAUNCHER%" echo echo Backend: http://localhost:8000/health
>>"%BACKEND_LAUNCHER%" echo echo.
>>"%BACKEND_LAUNCHER%" echo "%VENV_PY%" -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
>>"%BACKEND_LAUNCHER%" echo echo.
>>"%BACKEND_LAUNCHER%" echo echo Backend stopped or failed.
>>"%BACKEND_LAUNCHER%" echo pause

> "%FRONTEND_LAUNCHER%" echo @echo off
>>"%FRONTEND_LAUNCHER%" echo chcp 65001 ^>nul
>>"%FRONTEND_LAUNCHER%" echo cd /d "%ROOT%\frontend"
>>"%FRONTEND_LAUNCHER%" echo set VITE_API_BASE=http://localhost:8000
>>"%FRONTEND_LAUNCHER%" echo echo Frontend: http://localhost:5173
>>"%FRONTEND_LAUNCHER%" echo echo.
>>"%FRONTEND_LAUNCHER%" echo call npm run dev
>>"%FRONTEND_LAUNCHER%" echo echo.
>>"%FRONTEND_LAUNCHER%" echo echo Frontend stopped or failed.
>>"%FRONTEND_LAUNCHER%" echo pause
exit /b 0


:fail
echo.
echo ============================================================
echo FAILED
echo ============================================================
echo Log: %LOG%
echo.
if exist "%LOG%" (
  echo Full log:
  echo ------------------------------------------------------------
  type "%LOG%"
  echo ------------------------------------------------------------
) else (
  echo Log file was not created.
)
echo.
pause
exit /b 1
