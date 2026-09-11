const client = require('prom-client');

/**
 * Prometheus 指标模块
 * - 收集默认系统指标（CPU、内存、事件循环延迟等）
 * - 记录 HTTP 请求计数
 */

// 创建全局注册表，收集默认指标（CPU、内存、事件循环延迟等）
const register = new client.Registry();
client.collectDefaultMetrics({ register });

/**
 * HTTP 请求计数器
 * @type {client.Counter<string[]>}
 */
const httpRequestCounter = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status'],
  registers: [register],
});

module.exports = {
  register,
  httpRequestCounter,
};
