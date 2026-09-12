# ====== 多阶段构建：缩小镜像体积 ======
# 第一阶段：安装依赖
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --only=production && npm cache clean --force

# 第二阶段：复制应用代码
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p public/uploads logs backups ssl

# 第三阶段：运行生产镜像
FROM node:20-alpine AS production
# 使用非 root 用户运行
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app

# 从构建阶段复制产物
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/server.js ./server.js
COPY --from=builder --chown=nodejs:nodejs /app/routes/ ./routes/
COPY --from=builder --chown=nodejs:nodejs /app/middleware/ ./middleware/
COPY --from=builder --chown=nodejs:nodejs /app/utils/ ./utils/
COPY --from=builder --chown=nodejs:nodejs /app/services/ ./services/
COPY --from=builder --chown=nodejs:nodejs /app/templates/ ./templates/
COPY --from=builder --chown=nodejs:nodejs /app/swagger.js ./swagger.js
COPY --from=builder --chown=nodejs:nodejs /app/config/ ./config/
COPY --from=builder --chown=nodejs:nodejs /app/public/ ./public/
COPY --from=builder --chown=nodejs:nodejs /app/models/ ./models/
COPY --from=builder --chown=nodejs:nodejs /app/ssl/ ./ssl/ 2>/dev/null || true

# 创建运行时目录
RUN mkdir -p public/uploads logs backups && \
    chmod -R 755 public/uploads logs backups

# 切换到非 root 用户
USER nodejs

# 暴露端口
EXPOSE 3000 3443

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => { process.exit(r.statusCode === 0 ? 0 : 1) })"

# 启动命令
CMD ["node", "server.js"]

# 健康检查
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 运行端口
EXPOSE 3000

# 默认命令
CMD ["node", "server.js"]
