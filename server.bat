@echo off
chcp 936 >nul 2>&1
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
if "%choice%"=="0" exit
goto menu

:start
cls
echo Starting service...
start "" /b node server.js
timeout /t 2 >nul
echo.
echo [OK] Service started
echo.
echo   本机访问:
echo     Teacher: http://localhost:3000/teacher.html
echo     Student: http://localhost:3000/student.html
echo.
echo   手机/局域网访问（手机需与电脑在同一 WiFi）:
for /f "tokens=2 delims=:" %%a in ('findstr /r /o "IPv4" %SystemRoot%\System32\drivers\etc\hosts 2^>nul') do set _IP=%%a
echo     1) 查看电脑 IP:
ipconfig | findstr /R /C:"IPv4" /C:"192.168" /C:"10." /C:"172.16" /C:"172.17"
echo     2) 手机浏览器打开: http://电脑IP:3000/student.html
echo.
echo   ⚠ 手机打不开? 依次排查:
echo     ① 确认手机和电脑连的是同一个 WiFi（IP 同 192.168.x.x）
echo     ② Windows 防火墙放行 3000 端口:
echo        netsh advfirewall firewall add rule name="SmartEdu3000" dir=in action=allow protocol=TCP localport=3000
echo     ③ 把 WiFi 网络设为"专用"（控制面板→网络和共享中心→更改网络设置）
echo.
pause
goto menu

:stop
cls
echo Stopping service...
taskkill /f /im node.exe >nul 2>&1
echo.
echo [OK] Service stopped
echo.
pause
goto menu

:status
cls
echo Service Status:
echo.
netstat -ano | findstr ":3000.*LISTENING" >nul 2>&1
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
start "" http://localhost:3000/teacher.html
timeout /t 1 >nul
start "" http://localhost:3000/student.html
echo.
echo [OK] Done
echo.
pause
goto menu

:test
cls
echo Running tests...
set NODE_ENV=test
npx jest --verbose --no-coverage
echo.
pause
goto menu
