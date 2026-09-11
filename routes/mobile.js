// ==================== 微信/支付宝小程序端路由 ====================
// 为移动端（小程序）提供简化的 API，复用已有业务逻辑。
// 目前实现：
//   1. 人脸比对（含活体） -> /api/mobile/face-compare (委托给 ai.js 的 faceCompareHandler)
//   2. 大屏数据（只返回关键统计） -> /api/mobile/dashboard
// 未来可扩展更多小程序专属接口。

const express = require('express');
const { localDateStr } = require('../utils/helpers');

/**
 * 初始化移动端路由模块
 * @param {Object} opts - 依赖注入对象
 * @param {object} opts.db - sql.js Database 实例
 * @param {Function} opts.scheduleSave - 延迟保存函数
 * @param {Function} opts.authMiddleware - 认证中间件
 * @param {object} opts.upload - multer 上传中间件
 * @param {Function} opts.faceCompare - 人脸比对处理函数（来自 ai.js）
 * @returns {Express.Router}
 */
function init(opts) {
  const { db, scheduleSave, authMiddleware, upload, faceCompare: faceCompareHandler } = opts;
  const router = express.Router();

  // 人脸比对（含活体）- 委托给 ai.js 的实现
  router.post('/api/mobile/face-compare', authMiddleware, async (req, res) => {
    try {
      if (!faceCompareHandler) {
        return res.json({ code: 1, message: '人脸比对服务未初始化' });
      }
      return faceCompareHandler(req, res);
    } catch (err) {
      console.error('移动端人脸比对错误:', err);
      res.json({ code: 1, message: err.message });
    }
  });

  // 简化版大屏数据，仅返回关键统计信息，适配小程序 UI
  router.get('/api/mobile/dashboard', async (req, res) => {
    try {
      const { class_name } = req.query;
      const today = localDateStr(db);

      // 统计总学生数、今日在寝、请假、未归
      const totalStudents = db.exec(`SELECT COUNT(*) FROM students${class_name ? ' WHERE class_name=?' : ''}`,
        class_name ? [class_name] : [])[0]?.values?.[0]?.[0] || 0;

      const statusSql = `SELECT
        SUM(CASE WHEN status='在寝' THEN 1 ELSE 0 END) as present,
        SUM(CASE WHEN status IN ('病假','事假','公假','丧假') THEN 1 ELSE 0 END) as leave,
        SUM(CASE WHEN status IN ('未归','缺席') THEN 1 ELSE 0 END) as absent
        FROM records WHERE type='checkin' AND SUBSTR(time,1,10)=?${class_name ? ' AND class_name=?' : ''}`;
      const params = class_name ? [today, class_name] : [today];
      const stats = db.exec(statusSql, params)[0]?.values?.[0] || [];
      const present = stats[0] || 0;
      const leave = stats[1] || 0;
      const absent = stats[2] || 0;

      const checkinRate = totalStudents > 0 ? Math.round((present / totalStudents) * 100) : 0;

      res.json({ code: 0, data: { total_students: totalStudents, today_present: present, today_leave: leave, today_absent: absent, checkin_rate: checkinRate, date: today, class_name: class_name || '' } });
    } catch (e) {
      res.json({ code: 1, message: e.message });
    }
  });

  return router;
}

module.exports = { init };
