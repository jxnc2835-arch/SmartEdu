# SmartEdu 部署指南

## 方式一：Docker（推荐）

### 1. 配置环境变量
```bash
cp .env.example .env
# 编辑 .env，设置以下必需变量：
JWT_SECRET=<生成强密钥: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
DEFAULT_ADMIN_PASSWORD=<设置强密码>
ZHIPU_AI_API_KEY=<智谱 API Key>
```

### 2. 启动服务
```bash
# 构建并启动
docker-compose up -d

# 查看日志
docker-compose logs -f smartedu

# 停止服务
docker-compose down

# 数据持久化位置
# - 数据库: ./volumes/smartedu-data/
# - 日志: ./volumes/smartedu-logs/
# - 上传文件: ./volumes/smartedu-uploads/
# - 备份: ./volumes/smartedu-backups/
```

### 3. 访问服务
- 教师端: http://localhost:3000/teacher.html
- 学生端: http://localhost:3000/student.html
- 数据大屏: http://localhost:3000/dashboard.html
- API 文档: http://localhost:3000/swagger

## 方式二：直接运行

### 1. 安装依赖
```bash
npm install
```

### 2. 配置环境变量
```bash
# 复制并编辑 .env
cp .env.example .env
```

### 3. 启动服务
```bash
# 开发模式
npm run dev

# 生产模式
NODE_ENV=production npm start
```

## 生产环境建议

### 1. 使用 Nginx 反向代理
```nginx
server {
    listen 80;
    server_name your-domain.com;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### 2. 启用 HTTPS
- 使用 Let's Encrypt 免费证书
- 或购买商业 SSL 证书
- 将证书放入 `ssl/` 目录

### 3. 数据库备份
- 自动备份：每天 02:00 自动备份到 `backups/`
- 手动备份：POST /api/backup
- 备份保留策略：可在系统设置中配置

### 4. 监控与日志
- 健康检查: GET /health
- 监控指标: GET /api/metrics (Prometheus 格式)
- 日志轮转：按天分割，保留 14 天

## 故障排查

### 1. 启动失败
- 检查端口占用: `netstat -ano | findstr :3000`
- 查看日志: `tail -f logs/app.log`
- 确认环境变量已设置

### 2. 数据库锁定
- 确保只有一个进程访问数据库
- 检查 `config/data.db` 权限

### 3. AI 功能不可用
- 检查 ZHIPU_AI_API_KEY 是否正确
- 查看日志中的 `[大模型AI]` 相关输出
