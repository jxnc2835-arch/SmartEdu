/**
 * app.js - Express 应用配置模块
 * 负责中间件、静态文件、错误处理等应用级配置
 */

const express = require('express');
const path = require('path');
const { rateLimit, loginRateLimit } = require('./middleware/rate-limit');
const { getAppDb } = require('./utils/helpers');
const logger = require('./utils/logger');

// 脱敏：请求日志中隐藏 query 里的 token（authMiddleware 允许 token 放 query，防止 JWT 泄漏进日志）
function safeUrl(url) {
  return String(url).replace(/([?&]token=)[^&\s]*/g, '$1***');
}

/**
 * 创建并配置 Express 应用
 * @returns {object} 配置好的 Express 应用实例
 */
function createApp() {
  const app = express();

  // ==================== 基础中间件 ====================
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // HTTPS 安全头（仅在 HTTPS 模式下生效）
  if (process.env.HTTPS_MODE === 'true' || process.env.NODE_ENV === 'production') {
    app.use((req, res, next) => {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-XSS-Protection', '1; mode=block');
      next();
    });
  }

  // API 限流（全局）
  app.use(rateLimit({ windowMs: 15 * 60 * 1000, maxRequests: 200 }));

  // 请求日志中间件（脱敏 query 中的 token，防止 JWT 泄漏进日志）
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      logger.info(`${req.method} ${safeUrl(req.originalUrl)} ${res.statusCode} - ${duration}ms`);
    });
    next();
  });

  // /metrics、静态文件、favicon 统一在 server.js 路由挂载之后注册（见 server.js），
  // 此处不再重复注册，避免两套 Cache-Control 策略互相覆盖。

  // ==================== Health Check Endpoint ====================
  app.get('/health', (req, res) => {
    try {
      // 检查数据库连接：通过 helpers 注入的 db 引用（sql.js 实例有 exec 方法）
      let dbHealthy = false;
      try {
        const db = getAppDb();
        if (db && typeof db.exec === 'function') {
          db.exec('SELECT 1');
          dbHealthy = true;
        }
      } catch (e) {}

      const memory = process.memoryUsage();
      res.json({
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
        memory: {
          rss: `${(memory.rss / 1024 / 1024).toFixed(2)} MB`,
          heapUsed: `${(memory.heapUsed / 1024 / 1024).toFixed(2)} MB`,
          heapTotal: `${(memory.heapTotal / 1024 / 1024).toFixed(2)} MB`
        },
        db: dbHealthy ? 'connected' : 'disconnected',
        nodeVersion: process.version
      });
    } catch (err) {
      logger.error(`Health check failed: ${err.message}`);
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

// /metrics、404、全局错误处理均在 server.js 路由挂载之后统一注册，
// 避免重复注册导致首匹配命中错误位置。

  return app;
}

module.exports = { createApp, rateLimit, loginRateLimit };
