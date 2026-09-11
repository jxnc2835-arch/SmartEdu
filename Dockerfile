# ====== 多阶段构建：缩小镜像体积 ======
# 第一阶段：安装依赖
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --only=production && npm cache clean --force

# 第三阶段：运行生产镜像
FROM node:20-alpine AS production
# 使用非 root 用户运行
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app

# 复制依赖
COPY --from=deps /app/node_modules ./node_modules

# 复制应用代码
COPY --chown=nodejs:nodejs package.json ./
COPY --chown=nodejs:nodejs server.js ./
COPY --chown=nodejs:nodejs routes/ ./routes/
COPY --chown=nodejs:nodejs middleware/ ./middleware/
COPY --chown=nodejs:nodejs utils/ ./utils/
COPY --chown=nodejs:nodejs services/ ./services/
COPY --chown=nodejs:nodejs templates/ ./templates/
COPY --chown=nodejs:nodejs swagger.js ./

# 复制公共静态文件（排除上传目录）
COPY --chown=nodejs:nodejs public/ ./public/
RUN mkdir -p public/uploads logs backups && \
    chmod -R 755 public/uploads logs backups

# 复制 SSL 证书（如果存在）
COPY --chown=nodejs:nodejs ssl/ ./ssl/ 2>/dev/null || true

# 切换到非 root 用户
USER nodejs

# 暴露端口
EXPOSE 3000 3443

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1) })"

# 启动命令
CMD ["node", "server.js"]
