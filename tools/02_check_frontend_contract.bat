@echo off
setlocal EnableExtensions
chcp 65001 >nul

rem ============================================================
rem 02_check_frontend_contract.bat
rem Fast static frontend contract check.
rem Robust Python lookup: does not trust stale py launcher entries.
rem ============================================================

cd /d "%~dp0.."
set "ROOT=%CD%"
set "LOG_DIR=%ROOT%\tools\out"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>nul
set "LOG=%LOG_DIR%\02_check_frontend_contract.log"
set "CHECK=%ROOT%\tools\checks\frontend_contract_check.py"

> "%LOG%" echo Frontend contract check
>>"%LOG%" echo Root: %ROOT%
>>"%LOG%" echo Started: %DATE% %TIME%
>>"%LOG%" echo.

echo ============================================================
echo FRONTEND CONTRACT CHECK
echo ============================================================
echo Root: %ROOT%
echo.

if not exist "%CHECK%" (
  echo [ERROR] Check script not found: %CHECK%
  echo.
  echo Most likely you launched this BAT directly from inside the ZIP archive.
  echo Extract the whole patch ZIP into the project root first, then run:
  echo   tools\02_check_frontend_contract.bat
  echo.
  if not exist "%ROOT%\frontend\src" echo [HINT] Current root does not look like the project root: %ROOT%
  >>"%LOG%" echo [ERROR] Check script not found: %CHECK%
  >>"%LOG%" echo [HINT] Extract the whole patch ZIP into the project root before running this BAT.
  goto fail
)

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
  echo [ERROR] Python is not found or py launcher points to a broken Python install.
  echo Install Python or recreate backend\.venv by running tools\01_run_dev.bat --setup
  >>"%LOG%" echo [ERROR] Python not found / stale py launcher.
  goto fail
)

if defined PY_EXE (
  echo [INFO] Python: %PY_EXE%
  >>"%LOG%" echo [INFO] Python: %PY_EXE%
  "%PY_EXE%" "%CHECK%" >>"%LOG%" 2>&1
) else (
  echo [INFO] Python: %PY_LAUNCH%
  >>"%LOG%" echo [INFO] Python: %PY_LAUNCH%
  %PY_LAUNCH% "%CHECK%" >>"%LOG%" 2>&1
)

set "ERR=%ERRORLEVEL%"
type "%LOG%"
if not "%ERR%"=="0" goto fail

echo.
echo [OK] Frontend contract check passed.
pause
exit /b 0

:fail
echo.
echo ============================================================
echo FAILED
echo ============================================================
echo Log: %LOG%
echo.
pause
exit /b 1
