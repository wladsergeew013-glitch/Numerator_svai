@echo off
setlocal EnableExtensions
chcp 65001 >nul

rem ============================================================
rem 05_docker_build_run.bat
rem Pile Numbering App - Docker build and run.
rem Docker is optional: local work mode is tools\01_run_dev.bat.
rem ============================================================

cd /d "%~dp0.."
set "ROOT=%CD%"
set "LOG_DIR=%ROOT%\tools\out"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>nul
set "LOG_FILE=%LOG_DIR%\docker_build_run.log"

> "%LOG_FILE%" echo Pile Numbering Docker launcher
>> "%LOG_FILE%" echo Root: %ROOT%
>> "%LOG_FILE%" echo Started: %DATE% %TIME%
>> "%LOG_FILE%" echo.

echo ============================================================
echo Pile Numbering App - Docker build and run
echo ============================================================
echo Root: %ROOT%
echo.

if not exist "%ROOT%\docker-compose.yml" (
    echo [ERROR] docker-compose.yml not found in project root.
    >> "%LOG_FILE%" echo [ERROR] docker-compose.yml not found.
    goto fail
)

where docker >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Docker is not found in PATH.
    echo Install Docker Desktop first, or use local mode:
    echo   tools\01_run_dev.bat
    >> "%LOG_FILE%" echo [ERROR] Docker is not found in PATH.
    goto fail
)

docker info >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Docker daemon is not running.
    echo This is not a project code error. Start Docker Desktop and wait until it says Docker is running.
    echo.
    echo Local browser/dev mode works without Docker:
    echo   tools\01_run_dev.bat
    echo.
    echo EXE build also does not require Docker:
    echo   tools\06_build_exe.bat
    >> "%LOG_FILE%" echo [ERROR] Docker daemon is not running.
    goto fail
)

set "COMPOSE=docker compose"
docker compose version >nul 2>nul
if errorlevel 1 (
    where docker-compose >nul 2>nul
    if errorlevel 1 (
        echo [ERROR] Neither "docker compose" nor "docker-compose" is available.
        >> "%LOG_FILE%" echo [ERROR] Compose command not available.
        goto fail
    )
    set "COMPOSE=docker-compose"
)

echo [INFO] Compose command: %COMPOSE%
>> "%LOG_FILE%" echo [INFO] Compose command: %COMPOSE%

echo.
echo [INFO] Building and starting containers...
echo [INFO] This can take time on first run.
echo.
>> "%LOG_FILE%" echo [INFO] Running: %COMPOSE% up -d --build

%COMPOSE% up -d --build >> "%LOG_FILE%" 2>&1
if errorlevel 1 (
    echo [ERROR] Docker compose build/run failed.
    echo See log: %LOG_FILE%
    type "%LOG_FILE%"
    goto fail
)

echo.
echo [OK] Containers are running.
echo Frontend: http://localhost:5173
echo Backend:  http://localhost:8000/health
echo.
echo [INFO] Opening browser...
start "" "http://localhost:5173"

echo [INFO] Following logs. Press Ctrl+C to stop viewing logs.
echo [INFO] Containers will keep running in background.
echo.
>> "%LOG_FILE%" echo [OK] Containers started.
%COMPOSE% logs -f --tail=120

goto finish

:fail
echo.
echo ============================================================
echo FAILED
echo ============================================================
echo Log: %LOG_FILE%
echo.
pause
exit /b 1

:finish
echo.
echo ============================================================
echo DONE
echo ============================================================
echo To stop containers later, run:
echo   docker compose down
echo.
pause
exit /b 0
