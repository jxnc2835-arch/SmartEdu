const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const { localDateStr, beijingDateStr } = require('../utils/helpers');

/** @type {object} */
let database;

/**
 * 初始化统计路由模块
 * @param {object} _db - sql.js Database 实例
 * @param {Function} _scheduleSave - 定时保存函数（本模块未使用，保留参数以对齐 server.js 调用契约）
 * @param {Function} _addLog - 日志记录函数（同上，预留槽位）
 * @param {Function} _broadcast - 广播函数（同上，预留槽位）
 * @param {Function} _sendWebhook - Webhook 发送函数（同上，预留槽位）
 * @returns {Express.Router}
 */
function init(_db, _scheduleSave, _addLog, _broadcast, _sendWebhook) {
  database = _db;
  const router = express.Router();

  // 在所有路由前执行：先 auth，再过滤（只对 /api/* 生效）
  router.use('/api', authMiddleware);
  router.use('/api', applyUserClassFilter);

  // 数据隔离中间件：counselor/teacher 自动按其班级过滤
  // 注：有效班级写入 req.user.effective_class（req.query 在 Express 5 中为只读 getter，不可赋值）
  // 关键：空字符串 cls='' 代表"全部班级"语义，与 undefined 同等对待——回退到 effective_class
  function applyUserClassFilter(req, res, next) {
    if (!req.user) return next();
    const role = req.user.role;
    if (role === 'super_admin' || role === 'admin' || role === 'dean') return next();
    // 将空字符串视为"未指定"，统一走 effective_class 兜底
    const qCls = req.query.class_name;
    if (qCls === undefined || qCls === null || qCls === '') {
      delete req.query.class_name; // 移除空值，避免路由层误判
      if (role === 'counselor' || role === 'teacher') {
        const allowed = req.user.allowed_classes || [];
        if (allowed.length) {
          req.user.effective_class = allowed[0];
        }
      }
    } else {
      const allowed = req.user.allowed_classes || [];
      if (allowed.length && !allowed.includes(qCls)) {
        return res.status(403).json({ code: 1, message: '无权访问其他班级数据' });
      }
      req.user.effective_class = qCls;
    }
    next();
  }

  // ==================== 统计分析 ====================
  router.get('/api/stats', authMiddleware, (req, res) => {
    const days = parseInt(req.query.days) || 7;
    // effective_class: 辅导员/班主任的数据隔离班级（中间件已清理空 cls 并注入 effective_class）
    const class_name = req.query.class_name || req.user?.effective_class || '';
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(endDate.getDate() - days + 1);
    
    // 使用统一的时区处理函数
    const startDateStr = beijingDateStr(startDate);
    const endDateStr = beijingDateStr(endDate);

    // 学生总数
    let studentSql = "SELECT COUNT(*) FROM students";
    const studentParams = [];
    if (class_name) { studentSql += " WHERE class_name=?"; studentParams.push(class_name); }
    const totalStudents = database.exec(studentSql, studentParams)[0]?.values?.[0]?.[0] || 0;

    // 查寝统计
    const checkinStats = database.exec(`
      SELECT 
        COUNT(*) as total_checkins,
        SUM(CASE WHEN status='在寝' THEN 1 ELSE 0 END) as normal_count,
        SUM(CASE WHEN status IN ('未归','不在寝') THEN 1 ELSE 0 END) as absent_count,
        SUM(CASE WHEN status IN ('病假','事假','公假','丧假') THEN 1 ELSE 0 END) as leave_count
      FROM records 
      WHERE type='checkin' AND SUBSTR(time,1,10) >= ? AND SUBSTR(time,1,10) <= ?
      ${class_name ? "AND student_id IN (SELECT id FROM students WHERE class_name=?)" : ""}
    `, [startDateStr, endDateStr, ...(class_name ? [class_name] : [])])[0]?.values?.[0] || [0,0,0,0];

    // 请假统计
    const leaveStats = database.exec(`
      SELECT 
        COUNT(*) as total_leaves,
        SUM(CASE WHEN status IN ('pending','待审批') THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status IN ('approved','已批准') THEN 1 ELSE 0 END) as approved,
        SUM(CASE WHEN status IN ('rejected','已驳回') THEN 1 ELSE 0 END) as rejected
      FROM leaves 
      WHERE created_at >= ? AND created_at <= ?
      ${class_name ? "AND student_id IN (SELECT id FROM students WHERE class_name=?)" : ""}
    `, [startDateStr, endDateStr, ...(class_name ? [class_name] : [])])[0]?.values?.[0] || [0,0,0,0];

    // 出勤率
    const totalCheckins = checkinStats[0];
    const normalCount = checkinStats[1];
    const attendanceRate = totalCheckins > 0 ? Math.round(normalCount / totalCheckins * 100) : 0;

    res.json({
      code: 0,
      data: {
        days,
        class_name: class_name || '全部',
        date_range: `${startDateStr} ~ ${endDateStr}`,
        students: totalStudents,
        checkins: {
          total: totalCheckins,
          normal: normalCount,
          absent: checkinStats[2],
          leave: checkinStats[3],
          rate: attendanceRate
        },
        leaves: {
          total: leaveStats[0],
          pending: leaveStats[1],
          approved: leaveStats[2],
          rejected: leaveStats[3]
        },
        avg_daily_attendance: totalCheckins > 0 ? Math.round(totalCheckins / days) : 0
      }
    });
  });

  // 概览统计
  router.get('/api/stats/overview', authMiddleware, (req, res) => {
    try {
      let now = localDateStr();
      // effective_class: 数据隔离班级（中间件已清理空 cls 并注入 effective_class）
      const class_name = req.query.class_name || req.user?.effective_class || '';
      // 如果今天没有签到记录，自动回退到最近有数据的日期
      const hasToday = database.exec("SELECT COUNT(*) FROM records WHERE type='checkin' AND date=?", [now])[0]?.values?.[0]?.[0] || 0;
      if (!hasToday) {
        const latest = database.exec("SELECT MAX(date) FROM records WHERE type='checkin'")[0]?.values?.[0]?.[0];
        if (latest) now = latest;
      }
      // records 没有 class_name 字段，必须 JOIN students
      const stuCond = class_name ? " WHERE class_name=?" : "";
      const stuParams = class_name ? [class_name] : [];
      // 按状态优先级取主要状态
      const stuCond2 = class_name ? " AND s.class_name=?" : "";
      const stuParams2 = class_name ? [class_name] : [];
      const buildSql = `FROM records r JOIN students s ON r.student_id = s.student_id WHERE r.type='checkin' AND r.date=?${stuCond2}`;
      const buildParams = class_name ? [now, class_name] : [now];
      const todayCheckin = database.exec(`
        WITH today_status AS (
          SELECT r.student_id, MIN(CASE r.status
            WHEN '在寝' THEN 1
            WHEN '事假' THEN 2
            WHEN '病假' THEN 2
            WHEN '公假' THEN 2
            WHEN '丧假' THEN 2
            WHEN '未归' THEN 3
            WHEN '不在寝' THEN 3
            WHEN '缺席' THEN 4
            ELSE 5 END) as priority
          ${buildSql}
          GROUP BY r.student_id
        )
        SELECT COUNT(*) FROM today_status WHERE priority=1
      `, buildParams)[0]?.values?.[0]?.[0] || 0;
      const todayAbsent = database.exec(`
        WITH today_status AS (
          SELECT r.student_id, MIN(CASE r.status
            WHEN '在寝' THEN 1
            WHEN '事假' THEN 2
            WHEN '病假' THEN 2
            WHEN '公假' THEN 2
            WHEN '丧假' THEN 2
            WHEN '未归' THEN 3
            WHEN '不在寝' THEN 3
            WHEN '缺席' THEN 4
            ELSE 5 END) as priority
          ${buildSql}
          GROUP BY r.student_id
        )
        SELECT COUNT(*) FROM today_status WHERE priority IN (3,4)
      `, buildParams)[0]?.values?.[0]?.[0] || 0;
      const todayLeave = database.exec(`
        WITH today_status AS (
          SELECT r.student_id, MIN(CASE r.status
            WHEN '在寝' THEN 1
            WHEN '事假' THEN 2
            WHEN '病假' THEN 2
            WHEN '公假' THEN 2
            WHEN '丧假' THEN 2
            WHEN '未归' THEN 3
            WHEN '不在寝' THEN 3
            WHEN '缺席' THEN 4
            ELSE 5 END) as priority
          ${buildSql}
          GROUP BY r.student_id
        )
        SELECT COUNT(*) FROM today_status WHERE priority=2
      `, buildParams)[0]?.values?.[0]?.[0] || 0;
      const totalStudents = database.exec(`SELECT COUNT(*) FROM students${stuCond}`, stuParams)[0]?.values?.[0]?.[0] || 0;
      const pendingLeaves = class_name
        ? database.exec("SELECT COUNT(*) FROM leaves l JOIN students s ON l.student_id=s.student_id WHERE l.status='待审批' AND s.class_name=?", [class_name])[0]?.values?.[0]?.[0] || 0
        : database.exec("SELECT COUNT(*) FROM leaves WHERE status='待审批'")[0]?.values?.[0]?.[0] || 0;

      res.json({
        code: 0,
        data: {
          date: now,
          today_checkin: todayCheckin,
          today_absent: todayAbsent,
          today_leave: todayLeave,
          total_students: totalStudents,
          total_checkins: todayCheckin + todayAbsent + todayLeave,
          total_attendances: 0,
          pending_leaves: pendingLeaves,
          today_rate: totalStudents > 0 ? Math.round((todayCheckin / totalStudents) * 100) : 0
        }
      });
    } catch (e) {
      res.json({ code: 1, message: e?.message || String(e) });
    }
  });

  return router;
}

module.exports = { init };
