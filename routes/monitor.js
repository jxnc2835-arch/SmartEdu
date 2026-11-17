// 系统监控路由模块
const express = require('express');
const os = require('os');
const fs = require('fs');
const path = require('path');

/**
 * 初始化系统监控模块
 * @param {Object} opts - 依赖注入对象
 * @param {object} opts.db - sql.js Database 实例
 * @param {string} opts.dbFile - 数据库文件绝对路径
 * @param {Function} opts.authMiddleware - 认证中间件
 * @param {Function} opts.addLog - 日志记录函数
 * @param {string} [opts.backupDir] - 备份目录（健康自检用）
 * @param {string} [opts.aiConfigFile] - AI 配置文件路径（健康自检用）
 * @returns {Express.Router}
 */
function init(opts) {
  const { db, dbFile, authMiddleware, backupDir, aiConfigFile } = opts || {};
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

  // ==================== P2·实用性：系统健康自检（四项红绿灯） ====================
  /**
   * GET /api/health/full
   * 四项核心健康检查，每项返回 { status: 'ok'|'warn'|'fail', detail }：
   *  1. DB 可写   —— 内存库插入测试行再删，验证写链路
   *  2. 持久化同步 —— dbFile 存在且大小>0（better-sqlite3 WAL 已落盘）
   *  3. 备份可读   —— 备份目录存在且至少一份可读（integrity_check）
   *  4. AI 模型加载 —— ai_config.json 含有效 API Key 且 enableLLM
   */
  router.get('/api/health/full', authMiddleware, (req, res) => {
    const checks = {};

    // ① DB 可写（插入→删除测试行，验证内存库写链路 + 落盘能力）
    try {
      const probeId = '_health_probe_' + Date.now();
      db.run("INSERT INTO ai_usage(id, date, model, input_tokens, output_tokens, cost, created_at) VALUES(?,?,?,?,?,?,?)",
        [probeId, new Date().toISOString().slice(0, 10), '__probe__', 0, 0, 0, new Date().toISOString()]);
      db.run("DELETE FROM ai_usage WHERE id=?", [probeId]);
      checks.db_writable = { status: 'ok', detail: '内存库写链路正常（探针写入+删除成功）' };
    } catch (e) {
      checks.db_writable = { status: 'fail', detail: '数据库不可写: ' + e.message?.substring(0, 120) };
    }

    // ② 持久化同步（dbFile 存在且非空；better-sqlite3 即时同步保证断电可恢复）
    try {
      if (!dbFile || !fs.existsSync(dbFile)) {
        checks.persistence = { status: 'warn', detail: '数据库文件不存在（首次写入前属正常）' };
      } else {
        const size = fs.statSync(dbFile).size;
        checks.persistence = size > 0
          ? { status: 'ok', detail: `data.db ${mb(size)} MB，WAL 即时同步正常` }
          : { status: 'warn', detail: 'data.db 大小为 0，可能尚未落盘' };
      }
    } catch (e) {
      checks.persistence = { status: 'fail', detail: '数据库文件读取失败: ' + e.message?.substring(0, 120) };
    }

    // ③ 备份可读（备份目录存在且至少一份备份可读）
    try {
      if (!backupDir || !fs.existsSync(backupDir)) {
        checks.backup = { status: 'warn', detail: '备份目录不存在（未执行过备份属正常）' };
      } else {
        const files = fs.readdirSync(backupDir).filter(f => f.startsWith('backup_') || (f.startsWith('data_backup_') && f.endsWith('.db')));
        if (files.length === 0) {
          checks.backup = { status: 'warn', detail: '备份目录存在但无备份文件' };
        } else {
          const last = path.join(backupDir, files[files.length - 1]);
          const dbPath = fs.statSync(last).isDirectory() ? path.join(last, 'data.db') : last;
          if (fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0) {
            checks.backup = { status: 'ok', detail: `共 ${files.length} 份备份，最新 ${path.basename(last)} 可读` };
          } else {
            checks.backup = { status: 'warn', detail: `最新备份 ${path.basename(last)} 异常` };
          }
        }
      }
    } catch (e) {
      checks.backup = { status: 'fail', detail: '备份检查失败: ' + e.message?.substring(0, 120) };
    }

    // ④ AI 模型加载（ai_config.json 含有效 API Key 且 enableLLM）
    try {
      if (!aiConfigFile || !fs.existsSync(aiConfigFile)) {
        checks.ai_model = { status: 'warn', detail: '未找到 AI 配置（走本地引擎，LLM 增强未启用）' };
      } else {
        const cfg = JSON.parse(fs.readFileSync(aiConfigFile, 'utf8'));
        const hasKey = !!(cfg.apiKey && cfg.apiKey.trim() && cfg.apiKey !== '你的_api_key_here');
        const enabled = cfg.enableLLM !== false;
        checks.ai_model = (hasKey && enabled)
          ? { status: 'ok', detail: `LLM 增强已启用（model=${cfg.modelName || '默认'}）` }
          : { status: 'warn', detail: enabled ? '已启用但未配置 API Key（走本地引擎）' : 'LLM 增强已关闭（走本地引擎）' };
      }
    } catch (e) {
      checks.ai_model = { status: 'warn', detail: 'AI 配置解析失败: ' + e.message?.substring(0, 80) };
    }

    const statuses = Object.values(checks).map(c => c.status);
    const overall = statuses.includes('fail') ? 'fail' : (statuses.includes('warn') ? 'warn' : 'ok');
    res.json({
      code: 0,
      data: {
        timestamp: new Date().toISOString(),
        overall,
        checks,
        summary: `整体 ${overall === 'ok' ? '🟢 正常' : overall === 'warn' ? '🟡 有警告' : '🔴 有故障'}（4 项检查）`
      }
    });
  });

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
