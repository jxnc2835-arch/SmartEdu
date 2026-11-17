@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"

:menu
cls
echo.
echo ========================================
echo   SmartEdu Service Manager v3.8
echo ========================================
echo.
echo   1. Start Service
echo   2. Stop Service
echo   3. Check Status
echo   4. Open Browser
echo   5. Run Tests
echo   0. Exit
echo.

set /p choice="Select (0-5): "
if "%choice%"=="1" goto start
if "%choice%"=="2" goto stop
if "%choice%"=="3" goto status
if "%choice%"=="4" goto open
if "%choice%"=="5" goto test
if "%choice%"=="0" exit /b
goto menu

:start
cls
echo Starting service...
rem 启动前自动清理占用 3100 端口的旧实例（避免手动/node 启动残留导致 EADDRINUSE）
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3100.*LISTENING"') do (
    taskkill /f /pid %%a >nul 2>&1
)
start "" /b node server.js
timeout /t 3 >nul
rem 验证是否真正起来（监听 3100）
netstat -ano ^| findstr ":3100.*LISTENING" >nul 2>&1
if %errorlevel% equ 0 (
    echo [OK] Service started
) else (
    echo [ERROR] Service failed to bind port 3100 - check logs\server.log
)
echo.
echo   本机访问:
echo     Teacher: http://localhost:3100/teacher.html
echo     Student: http://localhost:3100/student.html
echo.
echo   手机/局域网访问（手机需与电脑在同一 WiFi）:
for /f "tokens=2 delims=:" %%a in ('findstr /r /o "IPv4" %SystemRoot%\System32\drivers\etc\hosts 2^>nul') do set _IP=%%a
echo     1) 查看电脑 IP:
ipconfig | findstr /R /C:"IPv4" /C:"192.168" /C:"10." /C:"172.16" /C:"172.17"
echo     2) 手机浏览器打开: http://电脑IP:3100/student.html
echo.
echo   ⚠ 手机打不开? 依次排查:
echo     ① 确认手机和电脑连的是同一个 WiFi（IP 同 192.168.x.x）
echo     ② Windows 防火墙放行 3100 端口:
echo        netsh advfirewall firewall add rule name="SmartEdu3100" dir=in action=allow protocol=TCP localport=3100
echo     ③ 把 WiFi 网络设为"专用"（控制面板→网络和共享中心→更改网络设置）
echo.
pause
goto menu

:stop
cls
echo Stopping service...
rem 仅停止当前 Claw 目录、占用 3100 端口的 node 实例，避免 taskkill /im node.exe 误伤旧目录 PM2 托管实例
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3100.*LISTENING"') do (
    taskkill /f /pid %%a >nul 2>&1
)
echo.
echo [OK] Service stopped
echo.
pause
goto menu

:status
cls
echo Service Status:
echo.
netstat -ano | findstr ":3100.*LISTENING" >nul 2>&1
if %errorlevel% equ 0 (
    echo   [RUNNING]
) else (
    echo   [STOPPED]
)
echo.
pause
goto menu

:open
cls
echo Opening browser...
start "" http://localhost:3100/teacher.html
timeout /t 1 >nul
start "" http://localhost:3100/student.html
echo.
echo [OK] Done
echo.
pause
goto menu

:test
cls
echo Running tests...
echo.
set NODE_ENV=test
call npx jest --verbose --no-coverage
echo.
echo ========================================
echo   Press any key to return to menu...
echo ========================================
pause >nul
goto menu
