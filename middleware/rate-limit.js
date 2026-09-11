/**
 * rate-limit.js - API 限流中间件
 * 防止暴力破解和滥用
 */

const logger = require('../utils/logger');

/**
 * 内存中的请求计数存储
 * 键格式: `${ip}:${endpoint}`
 */
const requestCounts = new Map();

/**
 * 创建限流中间件
 * @param {object} options
 * @param {number} options.windowMs - 时间窗口（毫秒），默认 15 分钟
 * @param {number} options.maxRequests - 最大请求数，默认 100
 * @param {string} options.message - 超限时返回消息
 * @param {function} options.keyGenerator - 自定义生成键的函数
 */
function rateLimit(options = {}) {
  const {
    windowMs = 15 * 60 * 1000, // 15 分钟
    maxRequests = 100,
    message = '请求过于频繁，请稍后再试',
    keyGenerator = (req) => req.ip
  } = options;

  return (req, res, next) => {
    const key = `${keyGenerator(req)}:${req.method}:${req.path}`;
    const now = Date.now();
    const windowStart = now - windowMs;

    // 获取或创建计数记录
    let record = requestCounts.get(key);
    if (!record || record.windowStart < windowStart) {
      // 新窗口
      record = { count: 0, windowStart: now };
      requestCounts.set(key, record);
    }

    record.count++;

    // 设置限流相关头
    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - record.count));
    res.setHeader('X-RateLimit-Reset', new Date(record.windowStart + windowMs).toISOString());

    if (record.count > maxRequests) {
      logger.warn(`限流触发: ${key} (${record.count} 次请求)`);
      return res.status(429).json({
        code: 1,
        message,
        retryAfter: Math.ceil((record.windowStart + windowMs - now) / 1000)
      });
    }

    next();
  };
}

/**
 * 登录专用限流（更严格）
 */
function loginRateLimit(options = {}) {
  return rateLimit({
    windowMs: 5 * 60 * 1000, // 5 分钟
    maxRequests: 10, // 最多 10 次登录尝试
    message: '登录尝试次数过多，请稍后再试',
    ...options
  });
}

/**
 * 清理过期的记录（定期调用）
 */
function cleanupExpiredRecords(windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  const threshold = now - windowMs * 2; // 保留 2 个窗口用于安全

  for (const [key, record] of requestCounts.entries()) {
    if (record.windowStart < threshold) {
      requestCounts.delete(key);
    }
  }
}

// 每 10 分钟清理一次
setInterval(() => cleanupExpiredRecords(), 10 * 60 * 1000);

module.exports = { rateLimit, loginRateLimit, cleanupExpiredRecords };
