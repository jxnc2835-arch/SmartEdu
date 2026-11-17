# ====== 多阶段构建：node:22-alpine，缩小镜像体积 + 非 root 运行 ======
# 说明：server.js 已绑定 0.0.0.0:3100 / :3543，容器外网可直接访问，无需改代码。

# 第一阶段：安装生产依赖
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 第二阶段：准备应用代码（含运行时所需目录）
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p public/uploads logs backups config/backups data

# 第三阶段：生产镜像
FROM node:22-alpine AS production
# 非 root 用户运行
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app

# 从构建阶段复制产物（仅运行时必需目录）
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
COPY --from=builder --chown=nodejs:nodejs /app/ssl/ ./ssl/

# 运行时目录与权限
RUN mkdir -p public/uploads logs backups config/backups data && \
    chmod -R 755 public/uploads logs backups config/backups data && \
    chown -R nodejs:nodejs /app

USER nodejs

# 暴露端口（HTTP 3100 / 自签 HTTPS 3543）
EXPOSE 3100 3543

# 健康检查（依赖 server.js 新增的公开 /health 路由，无需鉴权）
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3100/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
