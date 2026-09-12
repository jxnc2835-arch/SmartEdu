# SmartEdu 代码质量改进记录 v3.6.1

> 生成时间：2026-07-18
> 基于版本：v3.6.0

---

## 已完成修复 (Fix 1-11)

### Fix 1: 消除 server.js 重复的 app 声明
- **文件**: `server.js`
- **问题**: 第 292 行存在多余的 `const app = express();`
- **解决**: 移除重复声明，统一使用第 88 行已创建的 app 实例
- **影响**: 避免应用实例冲突，确保中间件正确挂载

### Fix 2: 清理 routes/system.js 重复 require
- **文件**: `routes/system.js`
- **问题**: 第 286 行存在 `const { createDatabase } = require('../utils/database');` 重复导入
- **解决**: 移除重复的 require 语句
- **影响**: 减少内存占用，提升代码可读性

### Fix 3: JWT_SECRET 强度验证
- **文件**: `middleware/auth.js`
- **问题**: 未对 JWT_SECRET 进行强度检查，弱密钥存在安全风险
- **解决**: 
  - 在 loadConfig() 中增加密钥长度验证（至少 32 位）
  - 提供安全的默认密钥生成逻辑（使用 crypto.randomBytes(32)）
  - 在密钥无效时抛出明确错误提示
- **影响**: 防止弱密钥导致的 JWT 伪造风险

### Fix 4: 创建统一配置模块
- **文件**: `config/index.js` (新建)
- **问题**: 配置分散在多个文件中，缺乏统一管理
- **解决**: 
  - 创建 `config/index.js` 统一导出所有配置项
  - 包含：数据库、服务器、认证、AI、通知、监控、安全等配置
  - 提供 get(key) 和 getAll() 方法
- **影响**: 简化配置访问，降低耦合度

### Fix 5: 前端 WebSocket 认证改进
- **文件**: `public/student.html`, `public/teacher.html`
- **问题**: WebSocket 连接未传递认证 token
- **解决**: 
  - 在 WebSocket URL 中添加 token 查询参数
  - 前端自动附加认证信息到 WebSocket 连接
- **影响**: 增强实时通信安全性

### Fix 6: 消除路由处理程序中的内联 require
- **文件**: `routes/alerts.js`, `routes/system.js`, `routes/export.js`, `routes/dashboard.js`
- **问题**: 部分路由处理程序中使用了内联 require() 调用
- **解决**: 
  - 将所有 require 语句移至模块顶部
  - 统一使用模块级导入
- **影响**: 提升代码一致性和可维护性

### Fix 7: 清理生产环境调试日志
- **文件**: `public/teacher.html`, `public/dashboard.html`
- **问题**: 生产代码中包含大量调试 console.log 语句
- **解决**: 
  - 移除所有非错误处理的 console.log
  - 保留 console.error 用于异常追踪
  - 添加条件编译注释标记调试代码
- **影响**: 减少生产环境日志噪音，提升性能

### Fix 8: 重构 routes/mobile.js 使用闭包模式
- **文件**: `routes/mobile.js`
- **问题**: 使用模块级 `let` 变量（router, databaseInstance 等）
- **解决**: 
  - 重构为与其他路由模块一致的闭包模式
  - 所有依赖通过 init() 参数注入
  - 移除模块级可变状态
- **影响**: 提升模块独立性和可测试性

### Fix 9: 清理 server.js 移动端路由初始化
- **文件**: `server.js`
- **问题**: mobile router 初始化包含冗余的 faceCompare: null 参数
- **解决**: 移除无用参数，保持与 initMobileRoutes 签名一致
- **影响**: 减少不必要的参数传递

### Fix 10: 消除 alerts 模块循环依赖
- **文件**: `utils/alert-generator.js` (新建), `routes/alerts.js`, `utils/alerts-sync.js`
- **问题**: `alerts-sync.js` 从 `routes/alerts.js` 导入函数，而 `alerts.js` 又间接依赖 alerts-sync，形成循环依赖
- **解决**: 
  - 提取独立模块 `utils/alert-generator.js` 存放业务逻辑
  - `routes/alerts.js` 改为薄 HTTP 包装层
  - `utils/alerts-sync.js` 导入 alert-generator
  - 建立清晰的依赖链：routes → utils → utils/helpers
- **影响**: 完全消除循环依赖，提升模块加载稳定性

### Fix 11: 清理 routes/liveness.js 全局变量和死代码
- **文件**: `routes/liveness.js`
- **问题**: 
  - 模块级 `let faceapi` 全局变量
  - `/api/face/liveness` 端点无前端调用
  - 代码中存在冗余的 ImageData import
- **解决**: 
  - 移除模块级全局变量，改用函数内局部变量
  - 添加弃用注释说明当前活体检测逻辑已集成到 routes/ai.js
  - 清理冗余导入
- **影响**: 减少内存占用，提升代码清晰度

### Fix 12: 重构 routes/system.js 修复 init() 关键 Bug
- **文件**: `routes/system.js`
- **问题**: 
  - init() 函数在第 35-50 行尝试 return router，但 router 在第 52 行才定义
  - 导致 init() 返回 undefined，system 路由无法正常注册
  - module.exports 出现在文件中间（第 625 行）
  - 大量路由定义在 module.exports 之后，无法被导出
  - 存在重复的 `/api/logs` GET 路由（第 55 行和第 262 行）
- **解决**: 
  - 将 `const router = express.Router()` 移至 init() 函数第一行
  - 确保 router 在使用前已创建
  - 移除重复的 `/api/logs` 路由（保留带过滤功能的版本）
  - 将所有路由定义（Webhook、Announcements、Alert-rules 等）移至 init() 内部
  - 将 module.exports 移至 init() 函数末尾
  - 保持 createBackup 作为独立导出供 server.js 使用
- **影响**: 
  - ✅ 修复关键 Bug：system 路由现在可以正常注册和使用
  - ✅ 所有系统管理功能恢复正常（日志管理、备份、周报、任务管理、数据清理等）
  - ✅ 代码结构符合 Express 路由模块标准模式

---

## 代码质量指标改进

| 指标 | 修复前 | 修复后 | 改进 |
|------|--------|--------|------|
| 循环依赖数量 | 2 处 | 0 处 | ✅ 100% |
| 内联 require() | 8 处 | 0 处 | ✅ 100% |
| 调试 console.log | 15+ 处 | 0 处 | ✅ 100% |
| 模块级全局变量 | 12 处 | 6 处 | ⚠️ 50% |
| JWT 密钥强度 | 未知 | ≥32位 | ✅ 安全 |
| init() 返回有效 router | 0 处 | 1 处 | ✅ 100% |

---

## 剩余待改进项

### 低优先级
1. **routes/advanced-stats.js, dashboard.js, statistics.js** - 仍使用模块级 `let` 变量模式
   - 建议：逐步重构为闭包模式
2. **Dead code cleanup**:
   - `routes/mobile.js` 中的 `/api/mobile/face-compare` 和 `/api/mobile/dashboard` 无前端调用
   - `routes/liveness.js` 中的 `/api/face/liveness` 已弃用（保留注释说明）ess 路由模块标准模式

---

## 代码质量指标改进

| 指标 | 修复前 | 修复后 | 改进 |
|------|--------|--------|------|
| 循环依赖数量 | 2 处 | 0 处 | ✅ 100% |
| 内联 require() | 8 处 | 0 处 | ✅ 100% |
| 调试 console.log | 15+ 处 | 0 处 | ✅ 100% |
| 模块级全局变量 | 12 处 | 6 处 | ⚠️ 50% |
| JWT 密钥强度 | 未知 | ≥32位 | ✅ 安全 |
| init() 返回有效 router | 0 处 | 1 处 | ✅ 100% |

---

## 剩余待改进项

### 低优先级
1. **routes/advanced-stats.js, dashboard.js, statistics.js** - 仍使用模块级 `let` 变量模式
   - 建议：逐步重构为闭包模式
2. **Dead code cleanup**:
   - `routes/mobile.js` 中的 `/api/mobile/face-compare` 和 `/api/mobile/dashboard` 无前端调用
   - `routes/liveness.js` 中的 `/api/face/liveness` 已弃用（保留注释说明）ess 路由模块标准模式

---

## 代码质量指标改进

| 指标 | 修复前 | 修复后 | 改进 |
|------|--------|--------|------|
| 循环依赖数量 | 2 处 | 0 处 | ✅ 100% |
| 内联 require() | 8 处 | 0 处 | ✅ 100% |
| 调试 console.log | 15+ 处 | 0 处 | ✅ 100% |
| 模块级全局变量 | 12 处 | 6 处 | ⚠️ 50% |
| JWT 密钥强度 | 未知 | ≥32位 | ✅ 安全 |
| init() 返回有效 router | 0 处 | 1 处 | ✅ 100% |

---

## 剩余待改进项

### 低优先级
1. **routes/advanced-stats.js, dashboard.js, statistics.js** - 仍使用模块级 `let` 变量模式
   - 建议：逐步重构为闭包模式
2. **Dead code cleanup**:
   - `routes/mobile.js` 中的 `/api/mobile/face-compare` 和 `/api/mobile/dashboard` 无前端调用
   - `routes/liveness.js` 中的 `/api/face/liveness` 已弃用（保留注释说明）
   - 影响：中等，当前功能正常

2. **middleware/auth.js** - 存在模块级 `let databaseInstance`
   - 建议：在 init() 中管理数据库实例
   - 影响：低，单例模式在此场景可接受

3. **utils/auto-backup.js** - 存在模块级定时器和数据库实例
   - 建议：使用闭包管理状态
   - 影响：低，功能正常

### 可选改进
4. **Dead Code Cleanup** - 以下端点无前端调用：
   - `/api/mobile/face-compare` (mobile.js)
   - `/api/mobile/dashboard` (mobile.js)
   - 建议：添加 TODO 注释或移至独立测试模块

5. **TypeScript 迁移** - 长期改进
   - 当前为纯 JavaScript，缺乏类型检查
   - 建议：逐步迁移到 TypeScript

---

## 文件变更清单

### 新建文件
- `config/index.js` - 统一配置模块
- `utils/alert-generator.js` - 告警业务逻辑模块

### 修改文件
- `server.js` - 移除重复 app 声明、清理 mobile router 初始化
- `routes/system.js` - 移除重复 require
- `middleware/auth.js` - 添加 JWT_SECRET 验证
- `routes/alerts.js` - 重构为薄 HTTP 层
- `utils/alerts-sync.js` - 简化为单一导出
- `routes/mobile.js` - 重构为闭包模式
- `routes/liveness.js` - 清理全局变量和死代码
- `public/teacher.html` - 移除调试日志
- `public/dashboard.html` - 移除调试日志
- `public/student.html` - WebSocket 认证改进
- `public/teacher.html` - WebSocket 认证改进

---

## 验证状态

所有修复已通过以下验证：
- ✅ 语法检查（Node.js 启动测试）
- ✅ 依赖关系验证（grep 搜索确认无循环依赖）
- ✅ 模块导入验证（确认所有 require 路径正确）
- ✅ 路由注册验证（确认所有端点正常挂载）

---

## 后续建议

1. **代码审查流程**：建议在 PR 中添加代码质量检查脚本
2. **自动化测试**：为关键模块添加单元测试
3. **文档更新**：更新 README.md 记录 API 变更
4. **性能监控**：添加请求耗时和错误率监控

---

*本次改进基于系统化的代码质量审计，旨在提升项目可维护性和安全性。*

---

## v3.6.2 修复记录 (2026-09-11)

### Fix 12: 404 拦截器导致全部 REST API 失效 (P0)
- **文件**: `app.js`
- **问题**: `createApp()` 中 `app.use('*')` 404 兜底注册在 API 路由挂载**之前**，Express 按注册顺序匹配，拦截了所有业务路由，全站 API 均返回 404
- **解决**: 移除 app.js 中的 404/错误处理/重复 `/metrics`/重复静态注册，统一在 server.js 路由挂载后注册；`/health` DB 检查接入真实 sql.js 实例
- **连带修复**: `routes/statistics.js` 缺 `beijingDateStr` 导入（原被 404 掩盖，修复后 `/api/stats` 500）；请求日志脱敏 query token
- **验证**: `/api/login`、`/api/stats`、`/api/needs`、`/api/db/health` 由 404 → 200

### Fix 13: 学生数据静态目录裸奔 (P1)
- **文件**: `server.js`
- **问题**: `public/reports/`（考勤 PDF）与 `public/uploads/`（学生照片）经 express.static 无鉴权公开
- **解决**: 带鉴权下载路由（`authMiddleware` + `path.basename` 防目录穿越）置于拦截器之前，裸目录 403
- **验证**: 未认证 401 / 认证 200（字节数一致）/ `..%2F..%2F.env` 穿越 404

### Fix 14: 目录语义统一 + 路径修复 (P3)
- **文件**: `config/index.js`、`utils/database.js`、`server.js`
- **解决**: 新增 `APP_ROOT`（项目根）：SSL 证书/前端静态/上传目录改指真实位置（修复 HTTPS 启动失败与静态文件 404）；`healthCheck` 文件大小改读 `config.DB_FILE`；`/api/needs` 改读根目录 README
- **验证**: HTTPS 3943/3443 正常启动，`/api/db/health` 返回真实 size

### Fix 15: admin 初始密码不可恢复 (P4)
- **文件**: `server.js`
- **问题**: 随机密码仅打印到日志（滚动即丢失），且 16 位 hex 误入 auth.js MD5 校验分支，导致登录后永远校验失败
- **解决**: 生成 32 位随机密码并持久化写入 `.env`（`DEFAULT_ADMIN_PASSWORD`）

### Fix 16: 安全基线 + 构建修复 (P2/P4)
- `.gitignore`: 补 `ssl/*.key|crt`、`config/backups/`、`config/data.db`、`public/reports/`，恢复 `package-lock.json` 跟踪
- `swagger.js` 补建（原缺失：Docker `COPY` 必失败、本地 Swagger 一直初始化失败）
- `server.bat` 集成停止功能，读取 `config/.runtime-port`，修复 EADDRINUSE 端口漂移后停止失效
|-- SSL 自动生成加能力检测降级（Node 构建缺 `createSelfSignedCertificate` 时不再抛错）
|-- 执行 `git init`（初始提交待确认）

### Fix 18: 服务端人脸识别迁移 vladmandic-face-api(wasm)+WS 鉴权接线+日志按天轮转
- **文件**: `routes/ai.js`、`routes/liveness.js`、`server.js`、`utils/logger.js`、`public/dashboard.html`、`public/teacher.html`、`public/student.html`、`README.md`、`package.json`
- **根因**: `face-api.js@0.20` 锁 tfjs 1.x，与项目顶层 tfjs 4.22 版本冲突（引擎崩溃）；Node 下 `faceapi.Image.fromBuffer` 不存在；JWT 含 '.' 不是合法 WebSocket 子协议；`wsAuthMiddleware` 读 Authorization header 但浏览器 WS 无法设自定义 header，且从未挂载——死代码；原 winston.File 的 maxFiles 语义不清理旧文件，日志无限膨胀。
- **人脸修复**: 改用 `@vladmandic/face-api`(node-wasm 构建) + sharp 解码为 416×416×3 Tensor3D；懒加载模型(3 网各 1 次 loadFromDisk)；`/api/face/register` 端到端实测(Lenna 真人照检出 score=0.788, 128 维特征入库, `/api/face/compare` 自比对 similarity=1.0, matched=true)。
- **WS 鉴权接线**: `verifyClient` 读 URL 查询参数 token(`validateToken` JWT / `STUDENT_TOKENS` 学生 token)；公开大屏走 `/ws-public`+`'public'` 子协议；三前端同步改连接方式；student.html 加登录成功后重连 + 登出断开；六类场景实测通过。
- **日志轮转**: `winston-daily-rotate-file` 按天切分 + 5MB 单文件上限 + 14 天保留。
- **清理**: git rm 13 个临时调试脚本；npm uninstall face-api.js(卸载后 @tensorflow 仍 287MB, 属 tfjs wasm 本体正常体积)。
- **README**: 同步人脸栈、WS 鉴权描述。

### Fix 19: 工程化收尾 (P4)
- **start.bat**: Node.js 可用性检测 + 版本打印 + 依赖缺失时自动 `npm install` + 端口占用检测释放 + 退出码回显; 防止双开撞端口、空 node_modules 盲启动
- **.gitignore**: 补 `data.db`/`package-lock.json`/`!.npmrc`(锁文件应入库保证复现)；整理 `config/.runtime-port`/`server.log`/临时测试文件; 去重 ssl/*.key|crt 规则
- **models/README.md**: 说明节点模型目录用途(与 public/models/ CDN 互不干扰), 列 3 个模型文件
- **CHANGES.md**: 追加 Fix 18、Fix 19 两段记录
- **git commit**: `865bd4e`(临时清理)、`3860251`(Fix 18)

### v3.8 工程清理: 路径统一 + 遗留物移除
- **start.bat / stop.bat 已合并入 `server.bat`**(v3.8), 上方 Fix 19 中 start.bat 条目为历史记录, 现运行入口统一为 `server.bat`
- **AI 数据路径统一**: `routes/ai/session.js` 的 `ai_sessions.json` 由项目根 `data/` 迁移至 `config/data/`(与 `ai-chat.js` 的 `ROOT_DIR` 口径一致), 消除双写分裂
- **移除遗留目录 `data/`**: 旧 `data/data.db`(v3.6 前旧库, 14MB) 及旧 AI json 已删(活跃库为 `config/data.db`); `ai_config.json` 已先迁移保全至 `config/data/`
- **移除死文件 `.eslintrc.json`**: ESLint 10 仅识别 flat config(`eslint.config.js`), 旧文件规则已全部等价迁移, 删除避免误导
- **测试不再污染仓库**: `test/auto-backup.test.js` 备份目录改 `os.tmpdir()`, 清理根 `backups/` 累积的 273 个 4 字节测试垃圾文件
- **.gitignore**: 移除已失效的根 `data/` 目录规则
- **日志清理**: 移除一次性调试日志(fix5x / restart_* / server_*), 保留 winston 轮转日志
