// ==================== 高级统计分析 ====================
const express = require('express');
const { localDateStr, beijingDateStr } = require('../utils/helpers');

/** @type {object} */
let db, scheduleSave, addLog;

/**
 * 初始化高级统计模块
 * @param {object} _db - sql.js Database 实例
 * @param {Function} _scheduleSave - 延迟保存函数
 * @param {Function} _addLog - 日志记录函数
 * @param {Function} authMiddleware - 认证中间件
 * @param {Function} requireRole - 角色验证中间件
 * @param {Function} localDateStrFn - 本地日期字符串函数
 * @param {Function} formatDateFn - 日期格式化函数
 * @param {Function} nowTimestampFn - 当前时间戳函数
 */
function init(_db, _scheduleSave, _addLog, authMiddleware, requireRole, localDateStrFn, formatDateFn, nowTimestampFn) {
  db = _db;
  scheduleSave = _scheduleSave;
  addLog = _addLog;

  const router = express.Router();

  // 根据辅导员/班主任 classScope 解析有效班级：空 scope 默认第一个；越界返回 null（触发 403）
  // 注：middleware/auth.js 写入 req.user.allowed_classes，此处优先读该字段
  function resolveScopedClass(req, className) {
    const sc = (req.user && (req.user.allowed_classes || req.user.classScope)) || [];
    if (!sc || !sc.length) return className || '';
    if (className && !sc.includes(className)) return null;
    return className || sc[0];
  }

  /**
   * GET /api/stats/conduct
   * 获取操行量化评分列表（需认证）
   */
  router.get('/api/stats/conduct', authMiddleware, (req, res) => {
    try {
      const days = parseInt(req.query.days) || 30;
      let { class_name } = req.query;
      class_name = resolveScopedClass(req, class_name);
      if (class_name === null) return res.status(403).json({ code: 1, message: '无权访问其他班级数据' });
      const endDate = localDateStr();
      // 起点 = 今天(clamped) - (days-1)；按本地日期分量回退，与公开版(dashboard.js)口径一致。
      // 旧版 beijingDateStr(今天-30) 因该函数忽略参数恒返回"今天"→ 窗口塌缩成 1 天 → 全 0。
      const [ey, em, ed] = endDate.split('-').map(Number);
      const es = new Date(ey, em - 1, ed);
      es.setDate(es.getDate() - days + 1);
      const startDate = `${es.getFullYear()}-${String(es.getMonth()+1).padStart(2,'0')}-${String(es.getDate()).padStart(2,'0')}`;
      const sql = `
        SELECT s.id, s.name, s.dorm, s.class_name,
          COUNT(DISTINCT CASE WHEN r.status='在寝' THEN r.date END) as normal_days,
          COUNT(DISTINCT CASE WHEN r.status IN ('未归','不在寝') THEN r.date END) as absent_days,
          COUNT(DISTINCT CASE WHEN r.status IN ('病假','事假','公假','丧假') THEN r.date END) as leave_days,
          COUNT(DISTINCT r.date) as checkin_days
        FROM students s
        LEFT JOIN records r ON s.student_id = r.student_id AND r.type='checkin' AND r.date >= ? AND r.date <= ?
        ${class_name ? 'WHERE s.class_name = ?' : ''}
        GROUP BY s.id
        ORDER BY checkin_days DESC, normal_days DESC
      `;
      const params = [startDate, endDate];
      if (class_name) params.push(class_name);
      const result = db.exec(sql, params);
      const rows = result[0]?.values || [];
      const cols = result[0]?.columns || [];
      
      const scores = rows.map(r => {
        const obj = {};
        cols.forEach((col, i) => { obj[col.toLowerCase()] = r[i]; });
        const normalDays = obj['normal_days'] || 0;
        const absentDays = obj['absent_days'] || 0;
        const leaveDays = obj['leave_days'] || 0;
        const checkinDays = obj['checkin_days'] || 0;
        // 分数 = (在寝天数 / 有记录的天数) * 100
        const score = checkinDays > 0 ? Math.round((normalDays / checkinDays) * 100) : 0;
        return {
          id: obj['id'] || r[0],
          name: obj['name'] || r[1],
          dorm: obj['dorm'] || r[2] || '',
          class_name: obj['class_name'] || r[3] || '',
          normal_days: normalDays,
          absent_days: absentDays,
          leave_days: leaveDays,
          checkin_days: checkinDays,
          score: score
        };
      });
      res.json({ code: 0, data: scores });
    } catch (err) {
      res.json({ code: 1, message: err.message });
    }
  });

  // 宿舍排名（公开接口，供数据大屏使用）
  router.get('/api/stats/dorm-rank/public', (req, res) => {
    try {
      const days = parseInt(req.query.days) || 30;
      const { class_name } = req.query;
      const endDate = localDateStr();
      // 起点 = 今天(clamped) - (days-1)；按本地日期分量回退，与 conduct/公开版口径一致
      const [py, pm, pd] = endDate.split('-').map(Number);
      const ps = new Date(py, pm - 1, pd);
      ps.setDate(ps.getDate() - days + 1);
      const startDate = `${ps.getFullYear()}-${String(ps.getMonth()+1).padStart(2,'0')}-${String(ps.getDate()).padStart(2,'0')}`;
      const result = db.exec(`
        SELECT s.dorm, s.class_name,
          COUNT(DISTINCT s.id) as total_students,
          SUM(CASE WHEN r.status='在寝' THEN 1 ELSE 0 END) as normal_count,
          SUM(CASE WHEN r.status IN ('未归','不在寝') THEN 1 ELSE 0 END) as absent_count,
          SUM(CASE WHEN r.status IN ('病假','事假','公假','丧假') THEN 1 ELSE 0 END) as leave_count,
          ROUND(
            SUM(CASE WHEN r.status='在寝' THEN 1 ELSE 0 END) * 100.0 /
            NULLIF(SUM(CASE WHEN r.status IS NOT NULL THEN 1 ELSE 0 END), 0)
            , 1
          ) as attendance_rate
        FROM students s
        LEFT JOIN records r ON s.student_id = r.student_id AND r.type='checkin' AND r.date >= ? AND r.date <= ?
        ${class_name ? 'WHERE s.class_name = ?' : ''}
        GROUP BY s.dorm
        ORDER BY attendance_rate ASC
      `, [startDate, endDate, ...(class_name ? [class_name] : [])])[0]?.values || [];

      res.json({ code: 0, data: result.map(r => ({
        dorm: r[0],
        class_name: r[1],
        total_students: r[2],
        normal_count: r[3] || 0,
        absent_count: r[4] || 0,
        leave_count: r[5] || 0,
        attendance_rate: r[6] != null ? (typeof r[6]==='string'?parseFloat(r[6]):r[6]) : 0
      }))});
    } catch (err) {
      res.json({ code: 1, message: err.message });
    }
  });

  // 宿舍排名
  router.get('/api/stats/dorm-rank', authMiddleware, (req, res) => {
    try {
      const days = parseInt(req.query.days) || 30;
      let { class_name } = req.query;
      class_name = resolveScopedClass(req, class_name);
      if (class_name === null) return res.status(403).json({ code: 1, message: '无权访问其他班级数据' });
      const endDate = localDateStr();
      // 起点 = 今天(clamped) - (days-1)；按本地日期分量回退，与 conduct/公开版口径一致
      const [py, pm, pd] = endDate.split('-').map(Number);
      const ps = new Date(py, pm - 1, pd);
      ps.setDate(ps.getDate() - days + 1);
      const startDate = `${ps.getFullYear()}-${String(ps.getMonth()+1).padStart(2,'0')}-${String(ps.getDate()).padStart(2,'0')}`;
      const result = db.exec(`
        SELECT s.dorm, s.class_name, 
          COUNT(DISTINCT s.id) as total_students,
          SUM(CASE WHEN r.status='在寝' THEN 1 ELSE 0 END) as normal_count,
          SUM(CASE WHEN r.status IN ('未归','不在寝') THEN 1 ELSE 0 END) as absent_count,
          SUM(CASE WHEN r.status IN ('病假','事假','公假','丧假') THEN 1 ELSE 0 END) as leave_count,
          ROUND(
            SUM(CASE WHEN r.status='在寝' THEN 1 ELSE 0 END) * 100.0 /
            NULLIF(SUM(CASE WHEN r.status IS NOT NULL THEN 1 ELSE 0 END), 0)
            , 1
          ) as attendance_rate
        FROM students s 
        LEFT JOIN records r ON s.student_id = r.student_id AND r.type='checkin' AND r.date >= ? AND r.date <= ?
        ${class_name ? 'WHERE s.class_name = ?' : ''}
        GROUP BY s.dorm
        ORDER BY attendance_rate ASC
      `, [startDate, endDate, ...(class_name ? [class_name] : [])])[0]?.values || [];
      
      res.json({ code: 0, data: result.map(r => ({
        dorm: r[0],
        class_name: r[1],
        total_students: r[2],
        normal_count: r[3] || 0,
        absent_count: r[4] || 0,
        leave_count: r[5] || 0,
        attendance_rate: r[6] != null ? (typeof r[6]==='string'?parseFloat(r[6]):r[6]).toFixed(1) : '0.0'
      }))});
    } catch (err) {
      res.json({ code: 1, message: err.message });
    }
  });

  // 重点关注学生
  router.get('/api/stats/attention', authMiddleware, (req, res) => {
    try {
      const days = parseInt(req.query.days) || 30;
      let { class_name } = req.query;
      class_name = resolveScopedClass(req, class_name);
      if (class_name === null) return res.status(403).json({ code: 1, message: '无权访问其他班级数据' });
      const endDate = localDateStr();
      // 起点 = 今天(clamped) - (days-1)；按本地日期分量回退，与 conduct/公开版口径一致
      const [py, pm, pd] = endDate.split('-').map(Number);
      const ps = new Date(py, pm - 1, pd);
      ps.setDate(ps.getDate() - days + 1);
      const startDate = `${ps.getFullYear()}-${String(ps.getMonth()+1).padStart(2,'0')}-${String(ps.getDate()).padStart(2,'0')}`;
      const sql = `
        SELECT s.id, s.name, s.dorm, s.class_name,
          COUNT(CASE WHEN r.status IN ('未归','不在寝') THEN 1 END) as absent_count,
          COUNT(CASE WHEN r.status IN ('病假','事假','公假','丧假') THEN 1 END) as leave_count
        FROM records r
        INNER JOIN students s ON r.student_id = s.student_id
        WHERE r.type='checkin' AND r.date >= ? AND r.date <= ?
        ${class_name ? 'AND s.class_name = ?' : ''}
        GROUP BY s.id
        HAVING absent_count >= 3
        ORDER BY absent_count DESC, leave_count DESC
        LIMIT 50
      `;
      const params = [startDate, endDate];
      if (class_name) params.push(class_name);
      const result = db.exec(sql, params);
      const rows = result[0]?.values || [];
      const cols = result[0]?.columns || [];
      
      const data = rows.map(r => {
        const obj = {};
        cols.forEach((col, i) => { obj[col.toLowerCase()] = r[i]; });
        return {
          id: obj['id'] || r[0],
          name: obj['name'] || r[1],
          dorm: obj['dorm'] || r[2] || '',
          class_name: obj['class_name'] || r[3] || '',
          absent_count: obj['absent_count'] || r[4] || 0,
          leave_count: obj['leave_count'] || r[5] || 0
        };
      });
      res.json({ code: 0, data });
    } catch (err) {
      res.json({ code: 1, message: err.message });
    }
  });

  // 宿舍异常检测
  router.get('/api/stats/dorm-anomaly', authMiddleware, (req, res) => {
    try {
      let { class_name } = req.query;
      class_name = resolveScopedClass(req, class_name);
      if (class_name === null) return res.status(403).json({ code: 1, message: '无权访问其他班级数据' });
      const today = localDateStr();
      const sql = `
        SELECT s.dorm, COUNT(DISTINCT r.student_id) as count, GROUP_CONCAT(DISTINCT s.name) as names
        FROM students s
        LEFT JOIN records r ON s.student_id = r.student_id AND r.date = ? AND r.type='checkin' AND r.status IN ('未归','不在寝')
        ${class_name ? 'AND s.class_name = ?' : ''}
        GROUP BY s.dorm
        HAVING count > 0
        ORDER BY count DESC
      `;
      const params = class_name ? [today, class_name] : [today];
      const result = db.exec(sql, params);
      const rows = result[0]?.values || [];
      const cols = result[0]?.columns || [];
      
      const data = rows.map(r => {
        const obj = {};
        cols.forEach((col, i) => { obj[col] = r[i]; });
        return {
          dorm: obj['dorm'] || r[0],
          count: obj['count'] || r[1] || 0,
          names: obj['names'] || r[2] || ''
        };
      });
      res.json({ code: 0, data });
    } catch (err) {
      res.json({ code: 1, message: err.message });
    }
  });

  // 宿舍异常检测（公开接口）
  router.get('/api/stats/dorm-anomaly/public', (req, res) => {
    try {
      const { class_name } = req.query;
      const today = localDateStr();
      const sql = `
        SELECT s.dorm, COUNT(DISTINCT r.student_id) as count, GROUP_CONCAT(DISTINCT s.name) as names
        FROM students s
        LEFT JOIN records r ON s.student_id = r.student_id AND r.date = ? AND r.type='checkin' AND r.status IN ('未归','不在寝')
        ${class_name ? 'AND s.class_name = ?' : ''}
        GROUP BY s.dorm
        HAVING count > 0
        ORDER BY count DESC
      `;
      const params = class_name ? [today, class_name] : [today];
      const result = db.exec(sql, params);
      const rows = result[0]?.values || [];
      const cols = result[0]?.columns || [];
      
      const data = rows.map(r => {
        const obj = {};
        cols.forEach((col, i) => { obj[col] = r[i]; });
        return {
          dorm: obj['dorm'] || r[0],
          count: obj['count'] || r[1] || 0,
          names: obj['names'] || r[2] || ''
        };
      });
      res.json({ code: 0, data });
    } catch (err) {
      res.json({ code: 1, message: err.message });
    }
  });

  // 请假趋势
  router.get('/api/stats/leave-trend', authMiddleware, (req, res) => {
    try {
      let { class_name } = req.query;
      class_name = resolveScopedClass(req, class_name);
      if (class_name === null) return res.status(403).json({ code: 1, message: '无权访问其他班级数据' });
      const sql = `
        SELECT strftime('%Y-%m', l.start_date) as month,
          COALESCE(SUM(CASE WHEN l.type='事假' THEN 1 ELSE 0 END),0) as 事假,
          COALESCE(SUM(CASE WHEN l.type='病假' THEN 1 ELSE 0 END),0) as 病假,
          COALESCE(SUM(CASE WHEN l.type='公假' THEN 1 ELSE 0 END),0) as 公假,
          COALESCE(SUM(CASE WHEN l.type='其他' THEN 1 ELSE 0 END),0) as 其他,
          COUNT(*) as total
        FROM leaves l
        WHERE l.status IN ('approved','已批准') AND l.start_date >= date('now', '-6 months')
        ${class_name ? 'AND l.student_id IN (SELECT id FROM students WHERE class_name=?)' : ''}
        GROUP BY strftime('%Y-%m', l.start_date)
        ORDER BY month DESC
      `;
      const params = class_name ? [class_name] : [];
      const result = db.exec(sql, params);
      const rows = result[0]?.values || [];
      res.json({ code: 0, data: rows.map(r => ({ month: r[0], '事假': r[1]||0, '病假': r[2]||0, '公假': r[3]||0, '其他': r[4]||0, total: r[5]||0 })) });
    } catch (err) {
      res.json({ code: 1, message: err.message });
    }
  });

  return router;
}

module.exports = { init };
