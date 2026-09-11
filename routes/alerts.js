// ==================== 异常闭环告警路由模块 ====================
// 未归自动建单 → 推送辅导员 → 跟进登记 → 销号闭环
const express = require('express');
const {
  generateAlerts,
  listAlerts,
  alertStats,
  closeAlertById,
  CLOSE_REASONS
} = require('../utils/alert-generator');
const { clampedToday } = require('../utils/helpers');

/**
 * 生成班级过滤 SQL WHERE 子句
 */
function whereInClasses(allowed) {
  if (!allowed || !allowed.length) return { clause: '', params: [] };
  return { clause: ' AND class_name IN (' + allowed.map(() => '?').join(',') + ')', params: allowed.slice() };
}

// ==================== 路由封装 ====================

function init(opts) {
  const { db, authMiddleware, scheduleSave, addLog } = opts || {};
  const router = express.Router();

  router.get('/api/alerts/reasons', authMiddleware, (req, res) => {
    res.json({ code: 0, data: { reasons: CLOSE_REASONS } });
  });

  router.post('/api/alerts/generate', authMiddleware, async (req, res) => {
    try {
      const date = (req.body && req.body.date) ? req.body.date : clampedToday(db);
      const result = await generateAlerts(db, date, { scheduleSave });
      addLog('ALERT_GENERATE', `生成 ${result.created} 条未归告警（${date}）`, 'WARNING', req.user.userId);
      res.json({
        code: 0,
        message: `已生成 ${result.created} 条告警${result.pushed ? '，已推送辅导员' : ''}`,
        created: result.created, total: result.total, pushed: result.pushed, push_detail: result.pushDetail, list: result.list
      });
    } catch (e) {
      res.json({ code: 1, message: '生成告警失败：' + e.message });
    }
  });

  router.get('/api/alerts', authMiddleware, (req, res) => {
    try {
      const status = req.query.status || 'open';
      const date = req.query.date || '';
      const allowed = req.user.allowed_classes || [];
      const data = listAlerts(db, { status, date, allowed });
      res.json({ code: 0, data });
    } catch (e) {
      res.json({ code: 1, message: '查询告警失败：' + e.message });
    }
  });

  router.get('/api/alerts/stats', authMiddleware, (req, res) => {
    try {
      const allowed = req.user.allowed_classes || [];
      res.json({ code: 0, data: alertStats(db, allowed) });
    } catch (e) {
      res.json({ code: 1, message: '统计失败：' + e.message });
    }
  });

  router.post('/api/alerts/:id/close', authMiddleware, (req, res) => {
    try {
      const { reason, note } = req.body || {};
      const result = closeAlertById(db, req.params.id, {
        reason, note, userId: req.user.userId, role: req.user.role, allowed: req.user.allowed_classes || []
      });
      if (result.code === 0) {
        scheduleSave();
        addLog('ALERT_CLOSE', `销号告警 ${req.params.id}（${reason}）`, 'INFO', req.user.userId);
      }
      res.json(result);
    } catch (e) {
      res.json({ code: 1, message: '销号失败：' + e.message });
    }
  });

  return router;
}

module.exports = { init, CLOSE_REASONS };
