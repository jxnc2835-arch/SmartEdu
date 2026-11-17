@echo off
chcp 65001 >nul
REM ============================================================
REM  学管 SmartEdu · 开放局域网访问端口
REM  以「管理员身份」运行本脚本，允许同局域网手机/其他电脑访问。
REM  HTTP 默认 3100；HTTPS（人脸打卡摄像头需要）默认 3543。
REM  若 server.js 启动时提示端口被占用并自增（如 3101），请把下方端口同步修改。
REM ============================================================
echo 正在开放 SmartEdu 端口（3100 / 3543）...
netsh advfirewall firewall add rule name="SmartEdu-HTTP-3100" dir=in action=allow protocol=TCP localport=3100 >nul 2>&1
netsh advfirewall firewall add rule name="SmartEdu-HTTPS-3543" dir=in action=allow protocol=TCP localport=3543 >nul 2>&1
echo.
echo 本机局域网 IPv4 地址如下（手机请访问 http://该IP:3100/student.html ）：
ipconfig | findstr /i "IPv4"
echo.
echo 开放完成。学生端手机访问示例： http://192.168.x.x:3100/student.html
echo 如需人脸摄像头打卡，请改用 https://192.168.x.x:3543/student.html （自签证书浏览器会提示风险，点继续即可）
pause
