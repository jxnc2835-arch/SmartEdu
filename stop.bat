@echo off
chcp 65001 >nul
cd /d "%~dp0"
setlocal enabledelayedexpansion

title 正在停止查寝系统...
color 0C

echo ╔══════════════════════════════════════╗
echo ║       正在停止学生管理系统          ║
echo ╚══════════════════════════════════════╝
echo .

set "STOPPED=0"

REM P4：优先读取 server.js 实际监听端口（EADDRINUSE 自动递增后写入口径），兜底 3000/3443
REM 注意：server.js 端口漂移时只递增 HTTP 端口，HTTPS 端口恒为 HTTPS_PORT（默认 3443）
set "RUN_PORT=3000"
set "RUN_HTLS_PORT=3443"
if exist "%~dp0config\.runtime-port" (
    set /p RUN_PORT < "%~dp0config\.runtime-port"
)
if defined HTTPS_PORT (
    set "RUN_HTLS_PORT=%HTTPS_PORT%"
)

REM 方法1：通过端口查PID
echo [1/3] 检查端口 %RUN_PORT%（HTTP）/ %RUN_HTLS_PORT%（HTTPS）...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%RUN_PORT% " ^| findstr LISTENING') do (
    echo   → 发现进程 PID=%%a，正在关闭...
    taskkill /F /PID %%a >nul 2>&1
    if !errorlevel! equ 0 ( set "STOPPED=1" ) else ( echo   ⚠ 关闭失败 )
)

echo [2/3] 检查 HTTPS 端口 %RUN_HTLS_PORT%...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%RUN_HTLS_PORT% " ^| findstr LISTENING') do (
    echo   → 发现进程 PID=%%a，正在关闭...
    taskkill /F /PID %%a >nul 2>&1
)

REM 方法2：通过进程名 + 工作目录兜底（不依赖端口，覆盖端口漂移/多实例）
echo [3/3] 检查 node.exe 进程（server.js）...
for /f "tokens=2 delims== " %%a in ('wmic process where "name='node.exe' and commandline like '%%server.js%%'" get processid /value 2^>nul') do (
    echo   → 发现 Node 进程 PID=%%a，正在关闭...
    taskkill /F /PID %%a >nul 2>&1
    if !errorlevel! equ 0 ( set "STOPPED=1" )
)

REM 清理运行时端口文件（若进程已退出，server.js 的 exit hook 亦会清理）
if exist "%~dp0config\.runtime-port" del "%~dp0config\.runtime-port" >nul 2>&1

echo.
if "%STOPPED%"=="1" (
    color 0A
    echo ✅ 学生管理系统已停止运行
) else (
    echo ⚠ 未检测到运行中的服务器进程
    echo   可能原因：服务器未启动 / 非标准端口 / 权限不足
    echo.
    echo 如需强制停止所有 Node 进程，请以管理员身份运行：
    echo   taskkill /F /IM node.exe
)

echo.
echo 按任意键退出...
pause >nul
exit /b 0