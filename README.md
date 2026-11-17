# 🎓 学管 SmartEdu

**AI 智能化学生查寝签到管理系统** — 人脸识别签到 + 数据预测 + 智能问答 + 数据大屏，一套系统覆盖「教师 / 学生 / 大屏 / AI」四端。

> Node.js + Express + sql.js（内存库）+ better-sqlite3（持久化）+ ARIMA/LSTM 预测 + 智谱 GLM-4 智能问答。开箱即跑，空库自动建表，离线可用。

---

## ✨ 功能特性

| 模块 | 说明 |
|------|------|
| 👤 人脸识别签到 | 基于 `@vladmandic/face-api` 的**离线**人脸比对 + 活体检测（眨眼），防照片代签 |
| 📊 数据预测 | ARIMA / LSTM 双模型预测签到率趋势、未归风险学生 |
| 🤖 智能问答 | 接入智谱 GLM-4，自然语言查询「今天谁没查寝」「学四未归几人」等；强模型超时自动降级 fast model |
| 🔔 异常闭环告警 | 未归自动建单 → 推送辅导员 → 跟进登记 → 销号闭环 |
| 📈 数据大屏 | 实时查寝率、班级排名、行为统计，面向大屏投放 |
| 📱 PWA 支持 | 离线访问、桌面快捷方式、Service Worker 缓存 |
| 🛡️ 安全加固 | Helmet 安全头、CORS、HSTS、CSRF、登录限流、SQL 参数化、bcrypt 12 轮、JWT 认证、审计日志、自动备份 |
| 🌐 公网部署 | 内置 cpolar / Cloudflare Tunnel 一键出公网，非局域网亦可登录 |

---

## 🖥️ 四端入口

启动后访问（HTTP `3100` / HTTPS `3543`）：

- **教师端** `http://localhost:3100/teacher.html` — 查寝记录、请假审批、访客登记、AI 用量、健康自检、异常闭环
- **学生端** `http://localhost:3100/student.html` — 人脸签到、课程打卡、请假申请、异常申诉
- **数据大屏** `http://localhost:3100/dashboard.html` — 实时统计大屏投放
- **Swagger API** `http://localhost:3100/swagger` — 接口文档
- **健康探针** `http://localhost:3100/health` — 供云负载均衡 / 容器探活

---

## 📦 系统要求

| 组件 | 最低版本 | 推荐版本 |
|------|---------|---------|
| Node.js | 18.0 | 20+（本项目 v22） |
| npm | 9.0 | 10+ |
| 操作系统 | Windows 10 | Windows 11 / Linux |

---

## 🚀 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

```bash
copy .env.example .env   # Windows
# macOS / Linux: cp .env.example .env
```

编辑 `.env` 必填项（每项配置方法见文件内注释）：

```env
JWT_SECRET=<32位以上强随机串>
ZHIPU_AI_API_KEY=<智谱 GLM-4 API Key>
DEFAULT_ADMIN_PASSWORD=<管理员初始密码>
```

生成强密钥：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> 各 key 获取方式：智谱 `https://bigmodel.cn`（注册实名 → API Keys）；高德地图 `https://lbs.amap.com`；详见 `.env` 内逐项注释。

### 3. 启动服务

**方式一：双击 `server.bat`（推荐，自动清端口 + 交互式菜单）**

**方式二：命令行**

```bash
npm start          # 即 node server.js
```

### 4. 默认账号

首次启动按内置脚本**自动建全表 + 创建 admin**（空库首启阻断已修复），密码取 `.env` 的 `DEFAULT_ADMIN_PASSWORD`：

- 用户名：`admin`
- 密码：`.env` 中 `DEFAULT_ADMIN_PASSWORD` 的值

> 想灌入演示数据：`node scripts/seed-demo.js --force`（默认 dry-run，加 `--force` 才清库灌数据，且自动备份）。

---

## 🤖 AI 智能问答示例

教师端 / 学生端「AI 问答」可自然语言查询（意图路由 + 本地引擎，接 GLM-4 增强）：

- 「今天哪个班查寝率最低？」
- 「学四栋 D 栋昨天未归几人次？」
- 「最近 7 天签到率预测一下」
- 「张三最近请假多吗？」

> 本地离线也能答数据类问题；填了 `ZHIPU_AI_API_KEY` 后由 GLM-4 兜底增强。强模型超时自动降级 fast model，会话 30 分钟 TTL。

---

## 📁 目录结构

```
学管 SmartEdu/
├── server.js          # 主入口（含数据库初始化 / 首启建表 / 端口自增 / 持久化）
├── app.js             # Express 应用配置
├── .env.example       # 环境变量模板（.env 不提交 Git）
├── routes/            # API 路由（auth / students / checkin / ai / monitor ...）
│   └── ai/           # AI 问答模块化（data-analyzer / llm-client / prompt-builder / session / date-utils）
├── middleware/        # 中间件（auth / csrf / rate-limit）
├── utils/             # 工具（database / helpers / alert-generator / auto-backup）
├── public/            # 前端四端（teacher / student / dashboard / js/modules）
├── models/            # face-api 离线识别模型权重
├── config/            # 配置（index.js；data.db 运行时生成）
├── test/              # Jest 测试用例（133 条）
├── scripts/           # 工具脚本（seed-demo / smoke-page ...）
└── 部署文档/           # 部署与运维 / 性能评估 / 师生指引
```

---

## 🧪 测试

```bash
npm test                # 全量 Jest
npx jest test/checkin.test.js   # 单文件
npx jest --coverage     # 覆盖率
node test/ai_deep_test.js       # AI 问答 52 条离线回归
```

当前状态：**133 / 133 全通过（21 个测试文件）**。

---

## 🚢 部署

### Docker（推荐）

```bash
docker build -t smartedu .
docker-compose up -d
```

### 生产环境

```env
NODE_ENV=production
PORT=3100
HTTPS_PORT=3543
```

SSL 证书（自签名测试用）：

```bash
node -e "const c=require('crypto'),{privateKey,certificate}=c.generateKeyPairSync('rsa',{modulusLength:2048});require('fs').writeFileSync('ssl/server.key',privateKey);require('fs').writeFileSync('ssl/server.crt',certificate)"
```

### 公网访问（非局域网登录）

- 一键出公网：`deploy.bat`（PM2 + cpolar 自动穿透 + 固化）
- 备选：`ecosystem.tunnel.config.js` 走 Cloudflare Tunnel
- 详细步骤见 `部署文档/部署与运维说明_Windows公网版.md`

---

## 🛡️ 安全特性

| 特性 | 实现 |
|------|------|
| SQL 注入防护 | 参数化查询 + ORDER BY 白名单 |
| XSS 防护 | `esc()` 转义 + `safeSetInnerHTML` |
| CSRF 防护 | Token 验证（全局中间件） |
| 密码存储 | bcrypt 12 轮 |
| 认证 | JWT + 登录限流 + 失败锁定 |
| 安全头 | Helmet + HSTS + CORS 白名单 |
| 持久化 | sql.js 内存库 + better-sqlite3 全库快照回放 + WAL checkpoint + 自动备份 |
| 活体防伪 | 眨眼活体检测 + 学号二次确认方可跳过，审计记录 |

---

## ❓ 常见问题

- **端口占用？** `server.bat` 选 `[2] Stop Service`；或 `taskkill /F /IM node.exe` 后重起。服务内置端口自增窗口（`PORT+100`），超窗口自动退出防互写库。
- **中文乱码？** `.bat` 用 GBK 编码；或 `chcp 936 >nul && server.bat`。
- **HTTPS 报错？** 检查 `ssl/` 下 `server.key` / `server.crt`。
- **人脸识别失败？** 确认 `models/` 下 face-api 权重文件完整。

---

## 📝 更新日志

- **v3.8.3**（当前）— 修复 5 个用户报告 bug + HTTPS 学生端 + P1 XSS 加固 + 缓存升级
- **v3.8.2** — 版本号对齐 + Docker 部署防崩溃 + 清理 ai 模块死代码
- **v3.8.0** — 安全加固（helmet/cors/HSTS）、修复 SQL 注入与 .bat 乱码

---

## 📄 许可证

MIT License

## 📮 联系

问题提 [Issue](https://github.com/jxnc2835-arch/SmartEdu/issues)。
