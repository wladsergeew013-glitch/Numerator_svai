@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul

rem ============================================================
rem 03_dump_project_code.bat
rem Dumps backend/frontend/tools code into tools\out only.
rem ============================================================

set "TOOLS_DIR=%~dp0"
for %%I in ("%TOOLS_DIR%..") do set "ROOT=%%~fI"
set "OUT_DIR=%TOOLS_DIR%out"
if not exist "%OUT_DIR%" mkdir "%OUT_DIR%" >nul 2>nul

set "BACKEND=%OUT_DIR%\project_code_dump_backend.txt"
set "FRONTEND=%OUT_DIR%\project_code_dump_frontend.txt"
set "TOOLS=%OUT_DIR%\project_code_dump_tools.txt"
set "ALL=%OUT_DIR%\project_code_dump_all.txt"
set "MANIFEST=%OUT_DIR%\project_code_dump_manifest.txt"
set "LOG=%OUT_DIR%\03_dump_project_code.log"

for %%F in ("%BACKEND%" "%FRONTEND%" "%TOOLS%" "%ALL%" "%MANIFEST%" "%LOG%") do if exist "%%~F" del "%%~F" >nul 2>nul

call :header "%BACKEND%" "PROJECT CODE DUMP - BACKEND"
call :header "%FRONTEND%" "PROJECT CODE DUMP - FRONTEND"
call :header "%TOOLS%" "PROJECT CODE DUMP - TOOLS"
call :header "%ALL%" "PROJECT CODE DUMP - ALL"

> "%LOG%" echo Started: %DATE% %TIME%
>>"%LOG%" echo Root: %ROOT%

rem ---------------- ROOT CONTRACT / CONFIG FILES ----------------
call :dump_if_exists "%ROOT%\README.md" "%ALL%"
call :dump_if_exists "%ROOT%\RULES.md" "%ALL%"
call :dump_if_exists "%ROOT%\FUNCTIONALITY_LOCK_RU.md" "%ALL%"
call :dump_if_exists "%ROOT%\docker-compose.yml" "%ALL%"
call :dump_if_exists "%ROOT%\.env.example" "%ALL%"

rem ---------------- BACKEND ----------------
call :dump_if_exists "%ROOT%\backend\Dockerfile" "%BACKEND%"
call :dump_if_exists "%ROOT%\backend\requirements.txt" "%BACKEND%"
call :dump_if_exists "%ROOT%\backend\pyproject.toml" "%BACKEND%"
if exist "%ROOT%\backend\app" (
  for /r "%ROOT%\backend\app" %%F in (*.py) do call :dump_file "%%~fF" "%BACKEND%"
) else (
  >>"%LOG%" echo WARN: backend\app not found
)

rem ---------------- FRONTEND ----------------
call :dump_if_exists "%ROOT%\frontend\Dockerfile" "%FRONTEND%"
call :dump_if_exists "%ROOT%\frontend\package.json" "%FRONTEND%"
call :dump_if_exists "%ROOT%\frontend\tsconfig.json" "%FRONTEND%"
call :dump_if_exists "%ROOT%\frontend\vite.config.ts" "%FRONTEND%"
call :dump_if_exists "%ROOT%\frontend\index.html" "%FRONTEND%"
if exist "%ROOT%\frontend\src" (
  for /r "%ROOT%\frontend\src" %%F in (*.ts) do call :dump_file "%%~fF" "%FRONTEND%"
  for /r "%ROOT%\frontend\src" %%F in (*.tsx) do call :dump_file "%%~fF" "%FRONTEND%"
  for /r "%ROOT%\frontend\src" %%F in (*.css) do call :dump_file "%%~fF" "%FRONTEND%"
  for /r "%ROOT%\frontend\src" %%F in (*.json) do call :dump_file "%%~fF" "%FRONTEND%"
) else (
  >>"%LOG%" echo WARN: frontend\src not found
)

rem ---------------- TOOLS ----------------
if exist "%ROOT%\tools" (
  for /r "%ROOT%\tools" %%F in (*.bat *.ps1 *.py *.md) do (
    echo "%%~fF" | findstr /I /C:"\tools\out\" /C:"\tools\legacy_" >nul
    if errorlevel 1 call :dump_file "%%~fF" "%TOOLS%"
  )
)

rem ---------------- COMBINE ----------------
type "%BACKEND%" >> "%ALL%"
type "%FRONTEND%" >> "%ALL%"
type "%TOOLS%" >> "%ALL%"

call :finish "%BACKEND%"
call :finish "%FRONTEND%"
call :finish "%TOOLS%"
call :finish "%ALL%"

> "%MANIFEST%" echo PROJECT CODE DUMP MANIFEST
>>"%MANIFEST%" echo Root: %ROOT%
>>"%MANIFEST%" echo Generated: %DATE% %TIME%
>>"%MANIFEST%" echo.
for %%F in ("%BACKEND%" "%FRONTEND%" "%TOOLS%" "%ALL%") do >>"%MANIFEST%" echo %%~nxF - %%~zF bytes

>>"%LOG%" echo Done: %DATE% %TIME%

echo.
echo DONE.
echo Backend dump:  %BACKEND%
echo Frontend dump: %FRONTEND%
echo Tools dump:    %TOOLS%
echo All dump:      %ALL%
echo Manifest:      %MANIFEST%
echo.
pause
exit /b 0

:header
set "OUT_FILE=%~1"
set "TITLE=%~2"
> "%OUT_FILE%" echo ============================================================
>>"%OUT_FILE%" echo %TITLE%
>>"%OUT_FILE%" echo ============================================================
>>"%OUT_FILE%" echo Root: %ROOT%
>>"%OUT_FILE%" echo Generated: %DATE% %TIME%
>>"%OUT_FILE%" echo.
exit /b 0

:finish
set "OUT_FILE=%~1"
>>"%OUT_FILE%" echo.
>>"%OUT_FILE%" echo ============================================================
>>"%OUT_FILE%" echo END
>>"%OUT_FILE%" echo ============================================================
exit /b 0

:dump_if_exists
if exist "%~1" call :dump_file "%~1" "%~2"
exit /b 0

:dump_file
set "ABS=%~1"
set "OUT_FILE=%~2"
set "REL=%ABS%"
set "REL=!REL:%ROOT%\=!"
>>"%OUT_FILE%" echo.
>>"%OUT_FILE%" echo ============================================================
>>"%OUT_FILE%" echo FILE: !REL!
>>"%OUT_FILE%" echo ============================================================
type "%ABS%" >> "%OUT_FILE%"
>>"%OUT_FILE%" echo.
exit /b 0
