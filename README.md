# 🎓 学管 SmartEdu

AI 智能化学生管理系统 — 人脸签到 + 数据预测 + 智能问答

---

## 功能特性

- **人脸签到** — 基于 `@vladmandic/face-api` 的离线人脸识别
- **数据预测** — ARIMA/LSTM 模型预测签到率趋势
- **智能问答** — 接入智谱 GLM-4 大模型，自然语言查询数据
- **PWA 支持** — 离线访问、桌面快捷方式
- **安全加固** — Helmet 安全头、CORS、HSTS、CSRF 防护、SQL 参数化

---

## 系统要求

| 组件 | 最低版本 | 推荐版本 |
|------|---------|---------|
| Node.js | 18.0 | 20+ |
| npm | 9.0 | 10+ |
| 操作系统 | Windows 10 | Windows 11 / Linux |

---

## 快速开始

### 1. 安装依赖

```bash
cd "D:\my pj\WorkBuddy\Claw\学管 SmartEdu"
npm install
```

### 2. 配置环境变量

复制模板并修改：

```bash
copy .env.example .env
```

编辑 `.env`，必填项：

```env
JWT_SECRET=你的32位以上密钥
ZHIPU_AI_API_KEY=你的智谱API密钥
```

生成强密钥：
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. 启动服务

**方式一：双击启动（推荐）**
```
双击 server.bat
```

**方式二：命令行启动**
```bash
npm start
```

服务启动后访问：
- 教师端：http://localhost:3100/teacher.html
- 学生端：http://localhost:3100/student.html
- 数据大屏：http://localhost:3100/dashboard.html
- Swagger API：http://localhost:3100/swagger

### 4. 默认账号

首次启动自动生成管理员账号：
- 用户名：`admin`
- 密码：查看日志输出

---

## 目录结构

```
学管 SmartEdu/
├── server.js          # 主入口
├── app.js             # Express 应用配置
├── .env               # 环境变量（不提交 Git）
├── package.json       # 项目配置
├── routes/            # API 路由
│   ├── auth.js        # 认证
│   ├── students.js    # 学生管理
│   ├── checkin.js     # 查寝签到
│   ├── ai.js          # AI 预测
│   └── ...
├── middleware/        # 中间件
│   ├── auth.js        # JWT 认证
│   ├── csrf.js        # CSRF 防护
│   └── rate-limit.js  # 限流
├── utils/             # 工具函数
│   ├── database.js    # SQLite 封装
│   ├── helpers.js     # 通用工具
│   └── alert-generator.js  # 告警生成
├── public/            # 前端静态文件
│   ├── teacher.html   # 教师端
│   ├── student.html   # 学生端
│   ├── dashboard.html # 数据大屏
│   └── js/modules/    # 前端模块
├── config/            # 配置文件
│   └── data.db        # SQLite 数据库
├── test/              # 测试用例
└── scripts/           # 工具脚本
```

---

## API 文档

启动服务后访问：
- Swagger UI：http://localhost:3100/swagger
- Health Check：http://localhost:3100/health

### 认证方式

所有需要认证的接口需在请求头携带：
```
x-auth-token: <JWT_TOKEN>
```

获取 Token：
```bash
POST /api/login
{
  "username": "admin",
  "password": "your_password"
}
```

---

## 测试

```bash
# 运行全部测试
npm test

# 运行单个测试文件
npx jest test/checkin.test.js

# 带覆盖率的测试
npx jest --coverage
```

当前覆盖率：133/133 通过（21 个测试文件全部通过）

---

## 部署

### Docker 部署（推荐）

```bash
# 构建镜像
docker build -t smartedu .

# 运行容器
docker-compose up -d
```

访问：http://localhost:3100

### 生产环境配置

```env
NODE_ENV=production
HTTPS_MODE=true
PORT=3100
HTTPS_PORT=3543
```

需要 SSL 证书：
```bash
# 自签名证书（测试用）
node -e "const crypto=require('crypto'); const {privateKey,certificate}=crypto.generateKeyPairSync('rsa',{modulusLength:2048}); require('fs').writeFileSync('ssl/server.key',privateKey); require('fs').writeFileSync('ssl/server.crt',certificate)"
```

---

## 安全特性

| 特性 | 实现 |
|------|------|
| SQL 注入防护 | 参数化查询 + ORDER BY 白名单 |
| XSS 防护 | esc() 转义 + safeSetInnerHTML |
| CSRF 防护 | Token 验证 |
| 密码存储 | bcrypt (12轮) |
| 认证 | JWT + Rate Limiting |
| 安全头 | Helmet + HSTS |

---

## 常见问题

### Q: 启动报端口占用？
双击 `server.bat`，选择 `[2] Stop Service` 停止服务后重新启动。
或手动执行：
```bash
taskkill /F /IM node.exe
server.bat
```

### Q: 中文乱码？
确保使用 GBK 编码打开 .bat 文件，或直接运行：
```bash
chcp 936 >nul && server.bat
```

### Q: HTTPS 报错？
检查 `config/ssl/` 目录下是否有 `server.key` 和 `server.crt`。

### Q: 人脸识别失败？
确保 `public/models/` 目录下有 face-api 模型文件。

---

## 更新日志

### v3.8.0 (2026-09-12)
- 🔒 安全加固：添加 helmet、cors、HSTS
- 🐛 修复 SQL 注入漏洞（ORDER BY 白名单）
- 🐛 修复 .bat 文件中文乱码（GBK 编码）
- 🐛 修复 Ctrl+C 直接退出问题
- 🐛 修复图标 404（.png → .svg）
- ✨ 版本号统一为 v3.8.0
- ✨ 删除心理化措辞

---

## 许可证

MIT License

---

## 联系方式

如有问题请提 Issue 或联系开发团队。
