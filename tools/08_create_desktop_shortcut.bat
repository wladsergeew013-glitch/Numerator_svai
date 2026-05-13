@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul

title Pile Numbering App - apply EXE icon
cd /d "%~dp0.."
set "ROOT=%CD%"
set "LOG_DIR=%ROOT%\tools\out"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>nul
set "LOG=%LOG_DIR%\08_apply_exe_icon.log"
set "CONFIG_ICON=%ROOT%\config\app_icon.ico"
set "TOOLS_ICON=%ROOT%\tools\app_icon.ico"
set "EXE=%ROOT%\dist\PileNumbering.exe"

> "%LOG%" echo APPLY EXE ICON
>>"%LOG%" echo Root: %ROOT%
>>"%LOG%" echo Started: %DATE% %TIME%
>>"%LOG%" echo.

echo ============================================================
echo APPLY EXE ICON - PILE NUMBERING APP
echo ============================================================
echo Root: %ROOT%
echo.
echo This helper does NOT create desktop shortcuts.
echo Windows stores the EXE icon inside the executable file.
echo To apply an icon, the EXE must be rebuilt with PyInstaller.
echo.

if not exist "%ROOT%\tools\06_build_exe.bat" (
  echo [ERROR] tools\06_build_exe.bat not found.
  >>"%LOG%" echo [ERROR] tools\06_build_exe.bat not found.
  goto fail
)

if not exist "%CONFIG_ICON%" (
  if exist "%TOOLS_ICON%" (
    if not exist "%ROOT%\config" mkdir "%ROOT%\config" >nul 2>nul
    copy /Y "%TOOLS_ICON%" "%CONFIG_ICON%" >>"%LOG%" 2>&1
  )
)

if exist "%CONFIG_ICON%" (
  echo [OK] Icon selected: %CONFIG_ICON%
  >>"%LOG%" echo [OK] Icon selected: %CONFIG_ICON%
) else (
  echo [WARN] config\app_icon.ico not found. Build will use tools\app_icon.ico if available.
  >>"%LOG%" echo [WARN] config\app_icon.ico not found.
)

echo.
echo [INFO] Rebuilding EXE with icon...
echo [INFO] This may take a few minutes.
echo.
call "%ROOT%\tools\06_build_exe.bat"
if errorlevel 1 goto fail

echo.
if exist "%EXE%" (
  echo [OK] EXE rebuilt:
  echo   %EXE%
  echo.
  echo If Windows still shows the old icon, refresh Explorer or restart it.
) else (
  echo [ERROR] EXE was not created: %EXE%
  goto fail
)

echo.
pause
exit /b 0

:fail
echo.
echo ============================================================
echo FAILED
echo ============================================================
echo Log: %LOG%
if exist "%LOG%" type "%LOG%"
echo.
pause
exit /b 1
