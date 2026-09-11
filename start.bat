@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
setlocal EnableDelayedExpansion

echo.
echo  🎓 学管 SmartEdu 启动中...
echo.

:: 检查 Node.js 是否可用
where node >nul 2>&1 || (
    echo ❌ 错误: 未找到 Node.js，请先安装 Node.js 18+
    echo    下载地址: https://nodejs.org/
    pause
    exit /b 1
)
for /f "tokens=2" %%v in ('node -v 2^>nul') do set NODE_VER=%%v
echo   Node.js !NODE_VER!

:: 检查依赖是否已安装
if not exist "node_modules\express" (
    echo ⚠️  node_modules 缺失, 正在执行 npm install...
    call npm install
    if errorlevel 1 (
        echo ❌ npm install 失败, 请检查网络或 npm 源
        pause
        exit /b 1
    )
)
echo   ✓ node_modules OK

:: 端口检测与释放(避免双开冲突, 仅杀 node 进程, 不误杀微信等)
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":3000 .* LISTENING"') do (
    for /f "tokens=1 delims= " %%b in ('wmic process where "processid=%%a" get name 2^>nul ^| findstr /i "node.exe"') do (
        taskkill /pid %%a /f >nul 2>&1
    )
)

:: 启动服务
echo ✅ 启动 server.js (HTTP 3000 / HTTPS 3443)
echo.
node server.js
set EXIT_CODE=%ERRORLEVEL%

if %EXIT_CODE% neq 0 (
    echo.
    echo ❌ 服务异常退出(代码 %EXIT_CODE%)
    echo    请查看上方日志, 或检查 .env 配置
)

endlocal
