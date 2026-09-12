// 系统监控路由模块
const express = require('express');
const os = require('os');

/**
 * 初始化系统监控模块
 * @param {Object} opts - 依赖注入对象
 * @param {object} opts.db - sql.js Database 实例
 * @param {string} opts.dbFile - 数据库文件绝对路径
 * @param {Function} opts.authMiddleware - 认证中间件
 * @param {Function} opts.addLog - 日志记录函数
 * @returns {Express.Router}
 */
function init(opts) {
  const { db, dbFile, authMiddleware, addLog } = opts || {};
  const router = express.Router();

  // 统计行数（忽略错误，返回 0）
  const count = (sql) => {
    try {
      const r = db.exec(sql);
      return r[0]?.values?.[0]?.[0] ?? 0;
    } catch (e) {
      return 0;
    }
  };

  // 格式化字节数为 MB（保留 1 位小数）
  const mb = (bytes) => Math.round(bytes / 1024 / 1024 * 10) / 10;

  // ==================== 系统运行状态概览 ====================
  /**
   * GET /api/monitor/status
   * 获取系统运行状态概览（学生数、记录数、内存、CPU、数据库、网络）
   */
  router.get('/api/monitor/status', authMiddleware, (req, res) => {
    try {
      const mem = process.memoryUsage();
      const cpu = os.loadavg();

      const stats = {
        students: count("SELECT COUNT(*) FROM students"),
        records: count("SELECT COUNT(*) FROM records"),
        courses: count("SELECT COUNT(*) FROM courses"),
        leaves: count("SELECT COUNT(*) FROM leaves"),
        visitors: count("SELECT COUNT(*) FROM visitors"),
        uptime: Math.floor(process.uptime()),
        memoryMB: Math.round(mem.rss / 1024 / 1024),
        memoryDetails: {
          heapUsedMB: mb(mem.heapUsed),
          heapTotalMB: mb(mem.heapTotal),
          rssMB: mb(mem.rss)
        },
        cpu: {
          load1: cpu[0] || 0,
          load5: cpu[1] || 0,
          load15: cpu[2] || 0
        },
        db: {
          file: dbFile || '',
          sizeMB: (() => {
            try {
              return dbFile ? mb(require('fs').statSync(dbFile).size) : 0;
            } catch (e) {
              return 0;
            }
          })()
        },
        network: {
          // 占位字段，后续可按需扩展
          activeWebSockets: 'unknown'
        }
      };

      res.json({ code: 0, data: stats });
    } catch (e) {
      res.json({ code: 1, message: e.message });
    }
  });

  return router;
}

module.exports = { init };
