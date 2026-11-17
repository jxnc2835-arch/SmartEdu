# 学管 SmartEdu —— Windows 部署与运维说明（免 bat · 开机自启 · 出公网）

> 目标：把这套系统做成「在某台 Windows 电脑上配置一次 → 之后每次开机自动运行 → 手机/异地公网直接访问」。
> 适用场景：学院辅导员自用（主机 24h 在线）+ 师生在任何网络（校园/家里/手机流量）都能登录；亦适用于远程演示。
> 本说明不绑定任何特定电脑——只要把整个项目文件夹搬过去、装好运行环境、在那台机器跑一次命令即可。

---

## 一、总体架构

```
[学生/教师 手机 / 家里宽带 / 校外网络]
        │  HTTPS（公网地址，cpolar 提供）
        ▼
[cpolar 内网穿透]  ──(本机回环)──►  http://localhost:3100
                                        │
                                   [PM2 守护]
                                        │
                              node server.js（学管 SmartEdu）
                                        │
                              config/data.db（业务数据，留辅导员机器）
```

- **PM2**：守护 `server.js`，崩溃自动拉起；`pm2 save` + `pm2-startup` 实现开机自启（免 bat、24h 在线）。
- **cpolar 内网穿透（主推，国产）**：把本机 `localhost:3100` 映射成公网 HTTPS 地址，免公网 IP、免路由器改端口、国内访问稳；师生零安装，开链接即用。Cloudflare Tunnel 作为免费备选。
- **数据**：`config/data.db` 留在辅导员那台机器，不外传云/公网，隐私更可控。

---

## 二、目标机一次性准备（Windows）

### 1. 装 Node.js（建议 22.x LTS）
- 官网 https://nodejs.org 下载 Windows 安装包（含 npm），一路默认安装。
- 装完开一个**新的** PowerShell 验证：`node -v` 应显示 v22.x，`npm -v` 正常。
- ⚠️ `ecosystem.claw.config.js` 已设为 `interpreter: 'node'`（走 PATH），**不要再硬编码本机路径**，否则换机器起不来。

### 2. 拷项目
把整个 `学管 SmartEdu` 文件夹复制到目标机任意目录（如 `D:\学管SmartEdu`）。
内含 `config/data.db`（业务数据）、`.env`（端口等）、`ecosystem.claw.config.js` 等，一并带走。

### 3. 装 PM2 与开机自启组件
以**管理员 PowerShell** 运行：
```powershell
npm install -g pm2 pm2-windows-startup
pm2 --version        # 确认安装成功
```

### 4. 启动服务并固化（关键三步）
```powershell
cd D:\学管SmartEdu
pm2 start ecosystem.claw.config.js     # 拉起 server，端口 3100 / 3543
pm2 save                              # 把进程列表写入 dump.pm2（记的是当前目录绝对路径）
pm2-startup install                   # 注册 Windows 服务：开机自动 resurrect
```
> ✅ 到此：不用再开 bat，开机自动起，崩了自动拉。

### 5.（可选但推荐）验证开机自启
任务管理器 →「启动」选项卡应出现 `PM2` / `pm2-startup` 项；或重启一次电脑，浏览器开 `http://localhost:3100` 确认能访问。

### 6.（推荐）固定内网 IP，避免校内访问地址失效
若老师/学生在**校内局域网**用 `http://内网IP:3100` 访问（不依赖 cpolar 公网地址），路由器 DHCP 重新分配可能让该 IP 变化、旧收藏地址打不开。三招解决（推荐度从高到低）：

- **① 路由器 DHCP 保留（最稳 ✅）**：进路由器管理页（一般 `192.168.0.1`/`192.168.1.1`，账号密码印在机身）→ 找「DHCP 静态分配 / 地址保留」→ 把辅导员电脑的 MAC 地址（`ipconfig /all` 里的「物理地址」）和想固定的 IP（如 `192.168.0.150`）绑定保存。从此该电脑永远拿这个 IP，绝不与其它设备冲突，且 IP 由路由器统一管，换网卡才需改。
- **② 电脑手动设静态 IP**：设置 → 网络 → 正在用的网卡 → IP 分配「编辑」→ 手动、开 IPv4 → 填 IP（最后一段用 150 这类大数，避开 DHCP 池 2–100 防冲突）、掩码 `255.255.255.0`、网关和 DNS 照 `ipconfig /all` 填。
- **③ 不依赖 IP：用主机名访问**：同局域网内可用 `http://辅导员电脑名:3100` 或 mDNS `http://电脑名.local:3100`，IP 变了也不影响（跨网段/部分校园网可能解析不到）。

> 💡 最省心组合：**路由器保留（治本）** + **师生统一用 cpolar 固定公网地址（彻底不依赖内网 IP）**。若用 cpolar 免费版地址 24h 变，在 cpolar 控制台「保留二级子域名」（付费档）拿固定公网地址，一个链接走天下。

---

## 三、出公网（手机/异地访问，不限制校园网）

> 目标：老师/学生在任何网络（校园 WiFi、家里宽带、手机 4G/5G）都能打开地址登录，**不用连校园网、不用装任何软件**。
> 主机仍在辅导员那台 Windows 电脑 24h 在线，数据留院内，只是访问入口经穿透暴露成公网 URL。

### 方案 A：cpolar（国产内网穿透，主推 ✅）
国内服务器、师生零安装、访问稳，最适合「一群老师/学生」使用。

#### A.1 安装 cpolar（目标机，管理员 PowerShell）
- 官网 https://www.cpolar.com 注册免费账号，下载 Windows 客户端安装（自动进 PATH）；或手动下载 `cpolar-stable-windows-amd64.zip` 解压出 `cpolar.exe` 放到 `C:\Windows\System32\`。
- 一键脚本 `deploy.bat` 已内置自动下载安装步骤。
- 绑定 token（一次性）：`cpolar authtoken <你的token>`（token 在 cpolar 官网控制台复制）。

#### A.2 启动穿透并固化（PM2 托管，开机自启）
```powershell
cd D:\学管SmartEdu
pm2 start ecosystem.cpolar.config.js    # 内部执行 cpolar http 3100
pm2 save                               # 连同 server 一起固化，开机自启时一并拉起
pm2 logs smartedu-cpolar               # 日志里找 *.cpolar.io / *.cpolar.cn 的公网地址
```
浏览器/手机打开日志里的 `https://xxxx.cpolar.io` 即可外网访问。
- 免费版地址约每 24h 变一次；需固定地址可在 cpolar 控制台「保留二级子域名」（付费档），并把 `ecosystem.cpolar.config.js` 的 `args` 改为 `http -subdomain=你的固定名 3100` 后重起。
- 或直接运行 `deploy.bat`（管理员）一次搞定装依赖 + 起服务 + 固化 + 起隧道。

### 方案 B：Cloudflare Tunnel（免费备选）
若 cpolar 在你网络下不稳，可用 Cloudflare（国内终端有时偏慢）：
```powershell
winget install Cloudflare.cloudflared      # 或手动下 cloudflared.exe 放 System32
pm2 start ecosystem.tunnel.config.js       # 快速隧道，日志找 *.trycloudflare.com
pm2 save
```
需稳定地址见 `ecosystem.tunnel.config.js` 注释（命名隧道，需免费 Cloudflare 账号）。

### 方案 C：Tailscale 私有组网（仅限授权设备，本场景不推荐）
- 适合「只给少数成员、不希望公网任何人能扫到」的场景；**但每个老师/学生都要装 Tailscale App 并加入同一网络**，用户多时维护成本高，本场景（辅导员 + 师生群）不推荐。
- 用法：目标机/手机/异地电脑都装 Tailscale 登录同一账号，用目标机 Tailscale IP（如 `100.x.x.x:3100`）访问。

---

## 四、日常运维命令

```powershell
pm2 status                      # 看 smartedu-claw / smartedu-cpolar 是否 online
pm2 logs smartedu-claw          # 看服务端日志
pm2 logs smartedu-cpolar        # 看公网隧道日志（含公网地址）
pm2 restart smartedu-claw       # 改完代码后重启服务
pm2 restart smartedu-cpolar     # 换公网地址/重连隧道
pm2 stop smartedu-cpolar        # 临时关闭公网出口（保留院内访问）
pm2 stop smartedu-claw          # 临时停服务（开机仍会自启，除非 pm2 unstartup）
pm2 unstartup                   # 取消开机自启（需管理员）
```

> 端口说明：`.env` 中 `PORT=3100`（HTTP）、`HTTPS_PORT=3543`（自签 HTTPS）。公网隧道建议只转发 `3100`，由 cpolar / Cloudflare 给客户端提供 HTTPS，省去自签证书信任问题。

---

## 五、迁移 / 换机器注意事项

- **不要直接拷贝本机的 `dump.pm2`**。它记的是原机器绝对路径。`pm2 save` 必须在目标机、项目就位后**重新执行一次**。
- 迁移步骤 = 第二节 1→5 在目标机重做一遍（拷目录 → 装环境 → `pm2 start` → `pm2 save` → `pm2-startup install` → 起隧道）。
- 业务数据 `config/data.db` 随目录走，无需单独处理；如需清空演示数据，删 `config/data.db` 重启即按内置脚本重生。
- 旧目录（端口 3000 的 `smartedu`）与本项目完全隔离，互不影响，可同时存在。

---

## 六、安全提醒（出公网后务必看）

- 公网地址任何人都能访问，**admin 密码已是强口令**（`gWQBdNDDq8xD8B&$`），请勿改回弱口令。
- 对外时，建议开启应用内登录鉴权（系统已带 teacher/admin/student 角色登录）作为第一道防线；如需进一步限制，可在 cpolar 控制台开启「隧道认证 / 访问白名单」，避免被无关人扫到后台。
- 学生人脸/签到属个人敏感信息，**公网暴露仅用于脱敏演示数据**；正式多校部署须做隐私合规与数据加密。
- 不用公网时建议 `pm2 stop smartedu-cpolar` 关闭公网出口，仅留院内 / 辅导员机器访问。
