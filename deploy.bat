@echo off
chcp 65001 >nul 2>&1
REM ============================================================
REM  SmartEdu one-click deploy (RUN AS ADMINISTRATOR)
REM  Host: counselor Windows PC, 24/7. Expose via cpolar tunnel.
REM  Steps: install PM2 -> start server -> boot auto-start -> install cpolar -> start tunnel
REM ============================================================

REM --- admin check ---
fltmc >nul 2>&1 || (
  echo [ERROR] Please run this script as Administrator.
  echo Right-click the file -> "Run as administrator".
  pause
  exit /b 1
)

cd /d "%~dp0"

REM --- Node check ---
where node >nul 2>&1 || (
  echo [ERROR] Node.js not found. Install LTS from https://nodejs.org first.
  pause
  exit /b 1
)
echo [OK] node detected.

REM --- install PM2 + startup component ---
echo [*] Installing PM2 and startup component...
call npm install -g pm2 pm2-windows-startup
if errorlevel 1 (
  echo [ERROR] npm install failed. Check your network / npm.
  pause
  exit /b 1
)

REM --- start server via PM2 ---
echo [*] Starting server via PM2...
call pm2 start ecosystem.claw.config.js
call pm2 save

REM --- register Windows service for boot auto-start ---
echo [*] Registering PM2 as Windows service (boot auto-start)...
call pm2-startup install

REM --- cpolar tunnel preparation ---
echo [*] Preparing cpolar tunnel...
where cpolar >nul 2>&1 || call :install_cpolar

REM --- check authtoken (cpolar stores config after authtoken is set) ---
if exist "%USERPROFILE%\.cpolar\cpolar.yml" (
  call pm2 start ecosystem.cpolar.config.js
  call pm2 save
  echo [OK] cpolar tunnel started. Public URL: pm2 logs smartedu-cpolar
) else (
  echo.
  echo [ACTION] cpolar needs a free authtoken (one-time):
  echo    1. Register at https://www.cpolar.com
  echo    2. Copy token from dashboard
  echo    3. Run: cpolar authtoken YOUR_TOKEN
  echo    4. Then run: pm2 start ecosystem.cpolar.config.js
  echo                   pm2 save
  echo.
  echo Server is already running internally; tunnel not started yet.
)

echo.
echo ============================================================
echo  Deploy finished.
echo  - Server status : pm2 status / pm2 logs smartedu-claw
echo  - Public URL    : pm2 logs smartedu-cpolar  (after authtoken set)
echo  - Stop tunnel   : pm2 stop smartedu-cpolar
echo  - Stop server   : pm2 stop smartedu-claw
echo ============================================================
pause
exit /b 0

REM ---------- subroutines ----------
:install_cpolar
echo [*] Downloading cpolar...
powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://www.cpolar.com/static/downloads/cpolar-stable-windows-amd64.zip' -OutFile '%TEMP%\cpolar.zip'"
if errorlevel 1 (
  echo [ERROR] cpolar download failed. Install manually from https://www.cpolar.com/download
  exit /b 1
)
powershell -NoProfile -Command "Expand-Archive -Path '%TEMP%\cpolar.zip' -DestinationPath '%TEMP%\cpolar_tmp' -Force"
copy "%TEMP%\cpolar_tmp\cpolar.exe" "C:\Windows\System32\cpolar.exe" >nul
if errorlevel 1 (
  echo [ERROR] Failed to copy cpolar.exe to System32. Copy it manually.
  exit /b 1
)
echo [OK] cpolar installed.
exit /b 0
