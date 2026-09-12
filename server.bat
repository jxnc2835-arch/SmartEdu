@echo off
chcp 936 >nul 2>&1
cd /d "%~dp0"
setlocal EnableDelayedExpansion

:menu
cls
echo.
echo ===========================================================
echo           SmartEdu Service Manager - Service Management
echo ===========================================================
echo.
echo   [1] Start Service  - Start HTTP/HTTPS service
echo   [2] Stop Service   - Stop all Node processes
echo   [3] Restart        - Restart service
echo   [4] Check Status   - Show running status
echo   [5] Run Tests      - Run Jest test suite
echo   [6] View Logs      - Show recent logs
echo   [0] Exit           - Exit program
echo.
set /p choice="Please select option (0-6): "
if "%choice%"=="1" goto start
if "%choice%"=="2" goto stop
if "%choice%"=="3" goto restart
if "%choice%"=="4" goto status
if "%choice%"=="5" goto test
if "%choice%"=="6" goto logs
if "%choice%"=="0" exit /b 0
echo   Invalid option, please try again
timeout /t 1 /nobreak >nul
goto menu

:start
cls
echo ===========================================================
echo                         Starting Service
echo ===========================================================
echo.

:: Check Node.js
where node >nul 2>&1 || (
    echo Error: Node.js not found, please install Node.js 18+
    pause
    exit /b 1
)
for /f "tokens=2" %%v in ('node -v 2^>nul') do set NODE_VER=%%v
echo   Node.js !NODE_VER!

:: Check dependencies
if not exist "node_modules\express" (
    echo node_modules missing, running npm install...
    call npm install
    if errorlevel 1 (
        echo npm install failed
        pause
        exit /b 1
    )
)
echo   node_modules OK

:: Check port occupation
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":3000 .* LISTENING"') do (
    for /f "tokens=1 delims= " %%b in ('wmic process where "processid=%%a" get name 2^>nul ^| findstr /i "node.exe"') do (
        echo Port 3000 in use, closing old process...
        taskkill /pid %%a /f >nul 2>&1
    )
)

echo.
echo Starting service...
echo    HTTP:  http://localhost:3000
echo    HTTPS: https://localhost:3443
echo    Teacher: http://localhost:3000/teacher.html
echo.
echo Tip: Press [2] Stop Service from menu, or close this window
echo ---
call node server.js
echo.
echo Service exited (code %ERRORLEVEL%)
echo.
echo Press any key to return to menu...
pause >nul
goto menu

:stop
cls
echo ===========================================================
echo                         Stopping Service
echo ===========================================================
echo.

set "STOPPED=0"
set "RUN_PORT=3000"
set "RUN_HTLS_PORT=3443"

if exist "%~dp0config\.runtime-port" (
    set /p RUN_PORT < "%~dp0config\.runtime-port"
)

echo [1/3] Checking HTTP port %RUN_PORT%...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%RUN_PORT% " ^| findstr LISTENING') do (
    echo   PID=%%a stopping...
    taskkill /F /PID %%a >nul 2>&1
    if !errorlevel! equ 0 set "STOPPED=1"
)

echo [2/3] Checking HTTPS port %RUN_HTLS_PORT%...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%RUN_HTLS_PORT% " ^| findstr LISTENING') do (
    echo   PID=%%a stopping...
    taskkill /F /PID %%a >nul 2>&1
)

echo [3/3] Checking server.js process...
for /f "tokens=2 delims==" %%a in ('wmic process where "name='node.exe' and commandline like '%%server.js%%'\" get processid /value 2^>nul') do (
    echo   PID=%%a stopping...
    taskkill /F /PID %%a >nul 2>&1
    if !errorlevel! equ 0 set "STOPPED=1"
)

if exist "%~dp0config\.runtime-port" del "%~dp0config\.runtime-port" >nul 2>&1

echo.
if "%STOPPED%"=="1" (
    echo Service stopped
) else (
    echo No running server detected
)
timeout /t 2 /nobreak >nul
goto menu

:restart
echo Restarting service...
call :stop
timeout /t 2 /nobreak >nul
call :start
goto menu

:status
cls
echo ===========================================================
echo                         Service Status
echo ===========================================================
echo.

for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":3000 .* LISTENING"') do (
    echo   HTTP : Running (PID=%%a)
)

for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":3443 .* LISTENING"') do (
    echo   HTTPS: Running (PID=%%a)
)

curl -s -o nul -w "   Health: %%{http_code}%%" http://localhost:3000/health 2>nul
echo.

if exist "config\data.db" (
    for %%f in ("config\data.db") do (
        set /a size=%%~zf/1024
        echo   Database: config\data.db (!size! KB)
    )
)

echo.
timeout /t 3 /nobreak >nul
goto menu

:test
cls
echo ===========================================================
echo                         Running Tests
echo ===========================================================
echo.
echo Running Jest test suite...
echo.
set NODE_ENV=test
npx jest --verbose --no-coverage
echo.
echo Tests complete, press any key to return...
pause >nul
goto menu

:logs
cls
echo ===========================================================
echo                     Recent Logs (30 lines)
echo ===========================================================
echo.
if exist "logs\app.log" (
    type "logs\app.log" | findstr /n "." | more +!total_lines!-30
) else (
    echo No log files found
)
echo.
echo Press any key to return...
pause >nul
goto menu
