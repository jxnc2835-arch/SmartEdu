@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
setlocal EnableDelayedExpansion

:menu
cls
echo ╔══════════════════════════════════════════════════╗
echo ║           🎓 学管 SmartEdu - 服务管理             ║
echo ╚══════════════════════════════════════════════════╝
echo.
echo   [1] ▶ 启动服务  （HTTP :3000 / HTTPS :3443）
echo   [2] ■ 停止服务
echo   [3] ↻ 重启服务
echo   [4] ● 查看状态
echo   [5] 📊 运行测试（Jest）
echo   [6] 🔍 查看日志（最近 30 行）
echo   [0] ✕ 退出
echo.

set /p choice="请选择操作: "
if "%choice%"=="1" goto start
if "%choice%"=="2" goto stop
if "%choice%"=="3" goto restart
if "%choice%"=="4" goto status
if "%choice%"=="5" goto test
if "%choice%"=="6" goto logs
if "%choice%"=="0" exit /b 0
echo   ❌ 无效选项，请重试
timeout /t 1 /nobreak >nul
goto menu

:start
cls
echo ╔══════════════════════════════════════════════════╗
echo ║                    启动服务                       ║
echo ╚══════════════════════════════════════════════════╝
echo.

:: 检查 Node.js
where node >nul 2>&1 || (
    echo ❌ 错误: 未找到 Node.js，请先安装 Node.js 18+
    echo    下载地址: https://nodejs.org/
    pause
    exit /b 1
)
for /f "tokens=2" %%v in ('node -v 2^>nul') do set NODE_VER=%%v
echo   ✓ Node.js !NODE_VER!

:: 检查依赖
if not exist "node_modules\express" (
    echo ⚠️  node_modules 缺失，正在执行 npm install...
    call npm install
    if errorlevel 1 (
        echo ❌ npm install 失败，请检查网络或 npm 源
        pause
        exit /b 1
    )
)
echo   ✓ node_modules OK

:: 检查端口占用
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":3000 .* LISTENING"') do (
    for /f "tokens=1 delims= " %%b in ('wmic process where "processid=%%a" get name 2^>nul ^| findstr /i "node.exe"') do (
        echo ⚠️  端口 3000 已被占用，正在关闭旧进程...
        taskkill /pid %%a /f >nul 2>&1
    )
)

echo.
echo 🚀 正在启动服务...
echo    HTTP:  http://localhost:3000
echo    HTTPS: https://localhost:3443
echo    教师端: http://localhost:3000/teacher.html
echo.
echo 💡 提示: 按 Ctrl+C 可停止服务
echo ───────────────────────────────────────────────────
node server.js
echo.
echo ❌ 服务已退出 (代码 %ERRORLEVEL%)
pause
goto menu

:stop
cls
echo ╔══════════════════════════════════════════════════╗
echo ║                    停止服务                       ║
echo ╚══════════════════════════════════════════════════╝
echo.

set "STOPPED=0"
set "RUN_PORT=3000"
set "RUN_HTLS_PORT=3443"

if exist "%~dp0config\.runtime-port" (
    set /p RUN_PORT < "%~dp0config\.runtime-port"
)

echo [1/3] 检查 HTTP 端口 %RUN_PORT%...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%RUN_PORT% " ^| findstr LISTENING') do (
    echo   → PID=%%a 正在关闭...
    taskkill /F /PID %%a >nul 2>&1
    if !errorlevel! equ 0 set "STOPPED=1"
)

echo [2/3] 检查 HTTPS 端口 %RUN_HTLS_PORT%...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%RUN_HTLS_PORT% " ^| findstr LISTENING') do (
    echo   → PID=%%a 正在关闭...
    taskkill /F /PID %%a >nul 2>&1
)

echo [3/3] 检查 server.js 进程...
for /f "tokens=2 delims==" %%a in ('wmic process where "name='node.exe' and commandline like '%%server.js%%'" get processid /value 2^>nul') do (
    echo   → PID=%%a 正在关闭...
    taskkill /F /PID %%a >nul 2>&1
    if !errorlevel! equ 0 set "STOPPED=1"
)

if exist "%~dp0config\.runtime-port" del "%~dp0config\.runtime-port" >nul 2>&1

echo.
if "%STOPPED%"=="1" (
    echo ✅ 服务已停止
) else (
    echo ⚠️  未检测到运行中的服务器
)
timeout /t 2 /nobreak >nul
goto menu

:restart
echo 🔄 正在重启服务...
call :stop
timeout /t 2 /nobreak >nul
call :start
goto menu

:status
cls
echo ╔══════════════════════════════════════════════════╗
echo ║                    服务状态                       ║
echo ╚══════════════════════════════════════════════════╝
echo.

:: 检查 HTTP 端口
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":3000 .* LISTENING"') do (
    for /f "tokens=2 delims==" %%p in ('wmic process where "processid=%%a" get caption /value 2^>nul') do (
        echo   HTTP  : ✅ 运行中 (PID=%%a)
    )
)

:: 检查 HTTPS 端口
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":3443 .* LISTENING"') do (
    echo   HTTPS : ✅ 运行中 (PID=%%a)
)

:: 健康检查
curl -s -o nul -w "   健康检查: %%{http_code}%%" http://localhost:3000/health 2>nul
echo.

:: 数据库大小
if exist "config\data.db" (
    for %%f in ("config\data.db") do (
        set /a size=%%~zf/1024
        echo   数据库: config\data.db (!size! KB)
    )
)

:: 备份数量
if exist "config\backups" (
    for /f %%c in ('dir /b "config\backups\*.db" 2^>nul ^| find /c /v ""') do (
        echo   备份文件: %%c 个
    )
)

echo.
timeout /t 3 /nobreak >nul
goto menu

:test
cls
echo ╔══════════════════════════════════════════════════╗
echo ║                    运行测试                       ║
echo ╚══════════════════════════════════════════════════╝
echo.
echo 🧪 正在运行 Jest 测试套件...
echo.
set NODE_ENV=test
npx jest --verbose --no-coverage
echo.
echo 测试完成，按任意键返回菜单...
pause >nul
goto menu

:logs
cls
echo ╔══════════════════════════════════════════════════╗
echo ║                  最近日志 (30行)                  ║
echo ╚══════════════════════════════════════════════════╝
echo.
if exist "logs\app.log.2026-09-12" (
    powershell -Command "Get-Content 'logs\app.log.2026-09-12' -Tail 30"
) else if exist "logs\app.log" (
    powershell -Command "Get-Content 'logs\app.log' -Tail 30"
) else (
    echo   暂无日志文件
)
echo.
echo 按任意键返回菜单...
pause >nul
goto menu
