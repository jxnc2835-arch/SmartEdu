// ==================== 监控仪表盘路由 ====================
// 为前端提供实时系统指标（CPU、内存、负载）
// 通过 /api/metrics/status 返回 JSON，适配 Grafana、Prometheus 或前端 Chart.js

const express = require('express');
const os = require('os');

/**
 * 初始化监控指标路由
 * @param {Object} opts - 依赖注入对象
 * @param {Function} opts.authMiddleware - 认证中间件
 * @returns {express.Router}
 */
function init(opts) {
  const { authMiddleware } = opts || {};
  const router = express.Router();

  /**
   * GET /api/metrics/status
   * 获取系统实时监控指标（内存、CPU、负载）
   */
  router.get('/api/metrics/status', authMiddleware, (req, res) => {
    try {
      const memory = process.memoryUsage();
      const cpuInfo = os.cpus();
      const load = os.loadavg(); // [1,5,15] 分钟负载
      const uptime = os.uptime();

      const data = {
        timestamp: Date.now(),
        memory: {
          rss: Math.round(memory.rss / 1024 / 1024), // MB
          heapTotal: Math.round(memory.heapTotal / 1024 / 1024),
          heapUsed: Math.round(memory.heapUsed / 1024 / 1024),
          external: Math.round(memory.external / 1024 / 1024)
        },
        cpu: {
          count: cpuInfo.length,
          model: cpuInfo[0]?.model || '',
          speedMHz: cpuInfo[0]?.speed || 0
        },
        loadAvg: {
          '1min': load[0].toFixed(2),
          '5min': load[1].toFixed(2),
          '15min': load[2].toFixed(2)
        },
        uptimeSeconds: Math.round(uptime)
      };
      res.json({ code: 0, data });
    } catch (e) {
      res.json({ code: 1, message: e.message });
    }
  });

  return router;
}

module.exports = { init };
