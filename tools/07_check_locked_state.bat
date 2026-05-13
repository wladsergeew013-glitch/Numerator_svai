@echo off
setlocal EnableExtensions
chcp 65001 >nul

rem ============================================================
rem 07_check_locked_state.bat
rem Full locked-state contract check for the current stable UI/backend.
rem Runs static frontend lock + backend runtime micro-tests.
rem Optional: pass --build to run npm install + npm run build after checks.
rem ============================================================

cd /d "%~dp0.."
set "ROOT=%CD%"
set "LOG_DIR=%ROOT%\tools\out"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>nul
set "LOG=%LOG_DIR%\07_check_locked_state.log"
set "FRONT_CHECK=%ROOT%\tools\checks\frontend_contract_check.py"
set "LOCK_CHECK=%ROOT%\tools\checks\locked_state_contract_check.py"
set "RUN_BUILD=0"
if /I "%~1"=="--build" set "RUN_BUILD=1"

> "%LOG%" echo LOCKED STATE CONTRACT CHECK
>>"%LOG%" echo Root: %ROOT%
>>"%LOG%" echo Started: %DATE% %TIME%
>>"%LOG%" echo Run build: %RUN_BUILD%
>>"%LOG%" echo.

echo ============================================================
echo LOCKED STATE CONTRACT CHECK
echo ============================================================
echo Root: %ROOT%
echo Log:  %LOG%
echo.

if not exist "%FRONT_CHECK%" (
  echo [ERROR] Check script not found: %FRONT_CHECK%
  >>"%LOG%" echo [ERROR] Check script not found: %FRONT_CHECK%
  goto fail
)
if not exist "%LOCK_CHECK%" (
  echo [ERROR] Check script not found: %LOCK_CHECK%
  >>"%LOG%" echo [ERROR] Check script not found: %LOCK_CHECK%
  goto fail
)

call :find_python || goto fail

echo [INFO] Running frontend contract check...
>>"%LOG%" echo [INFO] Running frontend contract check...
call :run_python "%FRONT_CHECK%" >>"%LOG%" 2>&1
if errorlevel 1 (
  echo [ERROR] Frontend contract check failed.
  goto fail_with_log
)

echo [INFO] Running locked-state contract check...
>>"%LOG%" echo [INFO] Running locked-state contract check...
call :run_python "%LOCK_CHECK%" >>"%LOG%" 2>&1
if errorlevel 1 (
  echo [ERROR] Locked-state contract check failed.
  goto fail_with_log
)

if "%RUN_BUILD%"=="1" (
  echo [INFO] Running frontend build check...
  >>"%LOG%" echo [INFO] Running frontend build check...
  where npm >nul 2>nul
  if errorlevel 1 (
    echo [ERROR] npm not found.
    >>"%LOG%" echo [ERROR] npm not found.
    goto fail_with_log
  )
  pushd "%ROOT%\frontend" >nul
  call npm install >>"%LOG%" 2>&1
  if errorlevel 1 (
    popd >nul
    echo [ERROR] npm install failed.
    goto fail_with_log
  )
  call npm run build >>"%LOG%" 2>&1
  if errorlevel 1 (
    popd >nul
    echo [ERROR] npm run build failed.
    goto fail_with_log
  )
  popd >nul
)

type "%LOG%"
echo.
echo [OK] Locked state contract passed.
pause
exit /b 0

:find_python
set "PY_EXE="
set "PY_LAUNCH="
if exist "%ROOT%\backend\.venv\Scripts\python.exe" (
  "%ROOT%\backend\.venv\Scripts\python.exe" -c "import sys" >nul 2>nul
  if not errorlevel 1 set "PY_EXE=%ROOT%\backend\.venv\Scripts\python.exe"
)
if not defined PY_EXE (
  where python >nul 2>nul
  if not errorlevel 1 (
    python -c "import sys" >nul 2>nul
    if not errorlevel 1 set "PY_LAUNCH=python"
  )
)
if not defined PY_EXE if not defined PY_LAUNCH (
  where py >nul 2>nul
  if not errorlevel 1 (
    py -3.13 -c "import sys" >nul 2>nul
    if not errorlevel 1 set "PY_LAUNCH=py -3.13"
  )
)
if not defined PY_EXE if not defined PY_LAUNCH (
  where py >nul 2>nul
  if not errorlevel 1 (
    py -3.12 -c "import sys" >nul 2>nul
    if not errorlevel 1 set "PY_LAUNCH=py -3.12"
  )
)
if not defined PY_EXE if not defined PY_LAUNCH (
  where py >nul 2>nul
  if not errorlevel 1 (
    py -3 -c "import sys" >nul 2>nul
    if not errorlevel 1 set "PY_LAUNCH=py -3"
  )
)
if not defined PY_EXE if not defined PY_LAUNCH (
  echo [ERROR] Python is not found. Run tools\01_run_dev.bat --setup first.
  >>"%LOG%" echo [ERROR] Python not found.
  exit /b 1
)
if defined PY_EXE (
  echo [INFO] Python: %PY_EXE%
  >>"%LOG%" echo [INFO] Python: %PY_EXE%
) else (
  echo [INFO] Python: %PY_LAUNCH%
  >>"%LOG%" echo [INFO] Python: %PY_LAUNCH%
)
exit /b 0

:run_python
if defined PY_EXE (
  "%PY_EXE%" %*
) else (
  %PY_LAUNCH% %*
)
exit /b %ERRORLEVEL%

:fail_with_log
echo.
echo Last log lines:
echo ------------------------------------------------------------
powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Test-Path -LiteralPath '%LOG%') { Get-Content -LiteralPath '%LOG%' -Tail 140 }"
echo ------------------------------------------------------------
goto fail

:fail
echo.
echo ============================================================
echo FAILED
echo ============================================================
echo Log: %LOG%
echo.
pause
exit /b 1
