// ==================== 数据大屏公开API ====================
const express = require('express');
const { clampedToday } = require('../utils/helpers');

let database;

/**
 * 初始化数据大屏路由模块
 * @returns {Express.Router}
 */
function init(_db, validateToken) {
  database = _db;
  const router = express.Router();

  /**
   * 中间件：可选 token 解析
   * 带 token 则设置 req.user（用于辅导员/班主任班级隔离），不带则维持公开
   */
  router.use((req, res, next) => {
    if (req.user) return next();
    const token = req.headers['x-auth-token'] || req.query.token;
    if (token) { 
      const validated = validateToken(token); 
      if (validated) req.user = validated; 
    }
    next();
  });

  // 辅助函数：本地日期字符串
  function localDateStr() {
    // "今天"锚定：系统时钟晚于最新完整数据日时，回退到该日，避免模拟数据下"今天"视图空白
    return clampedToday(database);
  }

  function classScopeOf(req) {
    return (req.user && req.user.allowed_classes) || (req.user && req.user.classScope) || [];
  }

  function limitedRole(req) {
    const role = req.user && req.user.role;
    return role === 'counselor' || role === 'teacher';
  }

  function classFilterFor(req, requestedClass) {
    const scope = classScopeOf(req);
    if (limitedRole(req)) {
      if (!scope.length) return { empty: true, where: "1=0", params: [] };
      if (requestedClass && scope.includes(requestedClass)) return { where: 'class_name=?', params: [requestedClass] };
      return { where: `class_name IN (${scope.map(() => '?').join(',')})`, params: scope.slice() };
    }
    return requestedClass ? { where: 'class_name=?', params: [requestedClass] } : { where: '', params: [] };
  }

  function studentSqlFilter(req, requestedClass) {
    const f = classFilterFor(req, requestedClass);
    return f.empty ? { empty: true, where: '1=0', params: [] } : f;
  }

  /**
   * GET /api/classes/public
   * 获取班级列表：辅导员/班主任仅返回所带班级；管理员/院领导未登录返回全部
   */
  router.get('/api/classes/public', (req, res) => {
    try {
      const role = req.user && req.user.role;
      const scope = (req.user && req.user.allowed_classes) || (req.user && req.user.classScope) || [];
      const isFull = !role || role === 'admin' || role === 'super_admin' || role === 'dean';
      if (!isFull) {
        if (!scope.length) return res.json({ code: 0, data: [] });
        const classes = database.exec(
          `SELECT DISTINCT class_name FROM students WHERE class_name IS NOT NULL AND class_name != '' AND class_name IN (${scope.map(() => '?').join(',')}) ORDER BY class_name`,
          scope
        )[0]?.values || [];
        return res.json({ code: 0, data: classes.map(r => r[0]) });
      }
      const classes = database.exec("SELECT DISTINCT class_name FROM students WHERE class_name IS NOT NULL AND class_name != '' ORDER BY class_name")[0]?.values || [];
      res.json({ code: 0, data: classes.map(r => r[0]) });
    } catch (e) {
      res.json({ code: 1, message: e.message });
    }
  });

  router.get('/api/classes/counts', (req, res) => {
    try {
      const scope = classScopeOf(req);
      const isLimited = limitedRole(req);
      if (isLimited && !scope.length) return res.json({ code: 0, data: [] });
      const sql = isLimited
        ? `SELECT class_name, COUNT(*) FROM students WHERE class_name IN (${scope.map(() => '?').join(',')}) GROUP BY class_name ORDER BY class_name`
        : "SELECT class_name, COUNT(*) FROM students GROUP BY class_name ORDER BY class_name";
      const rows = database.exec(sql, isLimited ? scope : undefined)[0]?.values || [];
      res.json({ code: 0, data: rows.map(r => ({ class_name: r[0], count: r[1] })) });
    } catch (e) {
      res.json({ code: 1, message: e.message });
    }
  });

  // 兼容前端旧写�?c.name
  router.get('/api/classes/legacy-counts', (req, res) => {
    try {
      const scope = classScopeOf(req);
      const isLimited = limitedRole(req);
      if (isLimited && !scope.length) return res.json({ code: 0, data: [] });
      const sql = isLimited
        ? `SELECT class_name, COUNT(*) FROM students WHERE class_name IN (${scope.map(() => '?').join(',')}) GROUP BY class_name ORDER BY class_name`
        : "SELECT class_name, COUNT(*) FROM students GROUP BY class_name ORDER BY class_name";
      const rows = database.exec(sql, isLimited ? scope : undefined)[0]?.values || [];
      res.json({ code: 0, data: rows.map(r => ({ name: r[0], count: r[1] })) });
    } catch (e) {
      res.json({ code: 1, message: e.message });
    }
  });

  router.get('/api/students/by-class', (req, res) => {
    try {
      const { class_name } = req.query;
      if (!class_name) return res.json({ code: 1, message: '请指定班级' });
      if (limitedRole(req)) {
        const scope = classScopeOf(req);
        if (!scope.length || !scope.includes(class_name)) {
          return res.json({ code: 1, message: '无权查看该班级数据' });
        }
      }
      const rows = database.exec("SELECT id, name, dorm FROM students WHERE class_name=? ORDER BY name", [class_name])[0]?.values || [];
      res.json({ code: 0, data: rows.map(r => ({ id: r[0], name: r[1], dorm: r[2] })) });
    } catch (e) {
      res.json({ code: 1, message: e.message });
    }
  });

  router.get('/api/dashboard/public', (req, res) => {
    try {
      const { class_name, date: reqDate } = req.query;
      // 支持指定日期查询（前端回退用）；默认“今天”经 clampedToday 锚定，时钟越界时回退到数据冻结日
      const today = reqDate || localDateStr();

      // 辅导员/班主任班级隔离：仅能查所带班级。未指定或越权指定的班级汇总所带全部班级
      const role = req.user && req.user.role;
      const scope = (req.user && req.user.allowed_classes) || (req.user && req.user.classScope) || [];
      let clsCond = '';
      let recJoin = '';
      let stuClsCond = '';
      let stuParams = [];
      let recParams = [];
      let returnedClass = class_name || '';
      if (role && (role === 'counselor' || role === 'teacher')) {
        if (!scope.length) {
          return res.json({ code: 0, data: { total_students: 0, today_present: 0, today_absent: 0, today_leave: 0, pending_leaves: 0, checkin_rate: 0, date: today, class_name: '' } });
        }
        const inList = scope.map(() => '?').join(',');
        if (class_name && scope.includes(class_name)) {
          clsCond = ' AND s.class_name=?'; recJoin = ' JOIN students s ON r.student_id = s.student_id'; stuClsCond = ' WHERE class_name=?';
          stuParams = [class_name]; recParams = [class_name];
        } else {
          clsCond = ` AND s.class_name IN (${inList})`; recJoin = ' JOIN students s ON r.student_id = s.student_id'; stuClsCond = ` WHERE class_name IN (${inList})`;
          stuParams = scope.slice(); recParams = scope.slice();
          returnedClass = '';
        }
      } else if (class_name) {
        clsCond = ' AND s.class_name=?'; recJoin = ' JOIN students s ON r.student_id = s.student_id'; stuClsCond = ' WHERE class_name=?';
        stuParams = [class_name]; recParams = [class_name];
      }

      // 优先级：在寝(1) > 请假(2) > 未归/晚归/不在寝(3) > 缺席(4)
      const totalStudents = database.exec(`SELECT COUNT(*) FROM students${stuClsCond}`, stuParams)[0]?.values?.[0]?.[0] || 0;
      // 取每个学生当日最高优先级的状态
      // [修复·问题4] 原逻辑按 records.class_name（去规范化副本，常为 NULL）过滤，
      // 导致选中班级后"今日课程签到"计数不随班级变化。改为 JOIN students 用真实班级过滤。
      const statusSql=`
        WITH today_status AS (
          SELECT r.student_id, MIN(CASE r.status
            WHEN '在寝' THEN 1
            WHEN '请假' THEN 2
            WHEN '事假' THEN 2
            WHEN '病假' THEN 2
            WHEN '公假' THEN 2
            WHEN '丧假' THEN 2
            WHEN '未归' THEN 3
            WHEN '晚归' THEN 3
            WHEN '不在寝' THEN 3
            WHEN '缺席' THEN 4
            ELSE 5 END) as priority
          FROM records r${recJoin}
          WHERE r.type='checkin' AND r.date=?${clsCond}
          GROUP BY r.student_id
        )
        SELECT
          SUM(CASE WHEN priority=1 THEN 1 ELSE 0 END) as present,
          SUM(CASE WHEN priority=2 THEN 1 ELSE 0 END) as leave_count,
          SUM(CASE WHEN priority IN (3,4) THEN 1 ELSE 0 END) as absent_count
        FROM today_status
      `;
      const statusParams=[today, ...recParams];
      const statusRes=database.exec(statusSql,statusParams)[0]?.values?.[0]||[];
      const todayPresent=statusRes[0]||0;
      const todayLeave=statusRes[1]||0;
      const todayAbsent=statusRes[2]||0;
      const pendingCond = stuClsCond ? stuClsCond.replace(' WHERE ', ' AND s.') : '';
      const pendingLeaves = pendingCond
        ? database.exec(`SELECT COUNT(*) FROM leaves l JOIN students s ON l.student_id=s.student_id WHERE l.status='待审批'${pendingCond}`, stuParams)[0]?.values?.[0]?.[0] || 0
        : database.exec("SELECT COUNT(*) FROM leaves WHERE status='待审批'")[0]?.values?.[0]?.[0] || 0;
      // 签到�?= 在寝人数 / 该班级总学生数
      const checkinRate = totalStudents > 0 ? Math.round((todayPresent / totalStudents) * 100) : 0;

      res.json({
        code: 0,
        data: {
          total_students: totalStudents,
          today_present: todayPresent,
          today_absent: todayAbsent,
          today_leave: todayLeave,
          pending_leaves: pendingLeaves,
          checkin_rate: checkinRate,
          date: today,
          class_name: returnedClass
        }
      });
    } catch (e) {
      res.json({ code: 1, message: e.message });
    }
  });

  router.get('/api/course-checkin/public', (req, res) => {
    try {
      const { date, class_name: qClass } = req.query;
      // 默认"今天"经 clampedToday 锚定；支持指定日期查询
      const courseDate = date || localDateStr();

      // 辅导员/班主任班级隔离
      const scope = classScopeOf(req);
      let class_name = qClass;
      if (limitedRole(req) && scope.length) {
        if (!class_name || !scope.includes(class_name)) class_name = '';
      }
      if (limitedRole(req) && !scope.length) {
        return res.json({ code: 0, data: [] });
      }

      // 统一以 courses.class_name 为过滤/聚合维度（courses 本身已带班级字段，避免 LEFT JOIN students 后空 IN () 问题）
      let where = 'WHERE c.date = ?';
      let groupBy = 'GROUP BY c.class_name, c.id';
      let params = [courseDate, courseDate];
      if (class_name) {
        where += ' AND c.class_name = ?';
        params.push(class_name);
        groupBy = 'GROUP BY c.id';
      } else if (limitedRole(req) && scope.length) {
        const inList = scope.map(() => '?').join(',');
        where += ` AND c.class_name IN (${inList})`;
        params.push(...scope);
      }
      // 管理员/院领导/未登录：不追加班级过滤，即"全部班级"

      const sql = `
        SELECT c.name, c.start_time, c.end_time, c.location, c.class_name,
          COUNT(DISTINCT r.student_id) as checked_in,
          COUNT(DISTINCT CASE WHEN r.status='出勤' THEN r.student_id END) as present,
          (SELECT COUNT(*) FROM students WHERE class_name = c.class_name) as total
        FROM courses c
        LEFT JOIN records r ON c.id = r.course_id AND r.type='class' AND r.date=?
        ${where}
        ${groupBy}`;

      const records = database.exec(sql, params)[0]?.values || [];
      res.json({ code: 0, data: records.map(r => {
        const checkedIn = r[5] || 0;
        const present = r[6] || 0;
        const classTotal = r[7] || 0;
        const total = classTotal || checkedIn || present;
        const rate = total > 0 ? Math.round(present / total * 100) : 0;
        return {
          course_name: r[0],
          start_time: r[1],
          end_time: r[2],
          location: r[3],
          class_name: r[4] || '',
          checked_in: checkedIn,
          present,
          total,
          rate
        };
      })});
    } catch (e) {
      res.json({ code: 1, message: e.message });
    }
  });

  router.get('/api/dorms/public', (req, res) => {
    try {
      const f = studentSqlFilter(req, req.query.class_name);
      if (f.empty) return res.json({ code: 0, data: [] });
      const inCond = f.params.length ? f.where : '';
      const countCond = inCond ? ` AND s2.${inCond}` : '';
      const existsCond = inCond ? ` AND EXISTS (SELECT 1 FROM students s WHERE s.dorm=d.building||d.room AND s.${inCond})` : '';
      const params = [ ...f.params, ...(inCond ? f.params : []) ];
      const rows = database.exec(`
        SELECT d.building, d.room, d.capacity, d.occupied,
          (SELECT COUNT(*) FROM students s2 WHERE s2.dorm = d.building || d.room${countCond}) as count
        FROM dorms d
        WHERE d.building IS NOT NULL AND d.room IS NOT NULL
        ${existsCond}
        ORDER BY d.building, d.room
      `, params)[0]?.values || [];
      res.json({ code: 0, data: rows.map(r => ({ dorm: r[0] + r[1], building: r[0], room: r[1], capacity: r[2], occupied: r[3], count: r[4] })) });
    } catch (e) {
      res.json({ code: 1, message: e.message });
    }
  });

  router.get('/api/class-trend/public', (req, res) => {
    try {
      const days = parseInt(req.query.days) || 7;
      const f = studentSqlFilter(req, req.query.class_name);
      if (f.empty) return res.json({ code: 0, data: [] });
      // 窗口结束于“今天”（clampedToday），起点 = 今天 - (days-1)；按本地日期分量计算避免时区漂移
      const endDateStr = localDateStr();
      const [ty, tm, td] = endDateStr.split('-').map(Number);
      const startD = new Date(ty, tm - 1, td);
      startD.setDate(startD.getDate() - days + 1);
      const startDateStr = `${startD.getFullYear()}-${String(startD.getMonth()+1).padStart(2,'0')}-${String(startD.getDate()).padStart(2,'0')}`;

      // 按班级过滤；records.class_name 存储的是状态/事由而非学生班级，必须 JOIN students 用真实班级
      const clsJoin = f.where ? 'JOIN students s ON r.student_id = s.student_id' : '';
      const clsCond = f.where ? ` AND s.${f.where}` : '';
      // 在寝(总数) | 未归 | 请假；上界锁到"今天"，避免未来日期（如跨冻结日的请假记录）污染趋势
      // 注意：「缺勤」已归类为「课堂缺勤」，改由课堂签到记录(type='class', status='缺勤')统计，见下方 classAbsentMap
      const trend = database.exec(`
        SELECT r.date as date,
          COUNT(DISTINCT r.student_id) as total_count,
          COUNT(DISTINCT CASE WHEN r.status='在寝' THEN r.student_id END) as in_count,
          COUNT(DISTINCT CASE WHEN r.status='未归' THEN r.student_id END) as not_return_count,
          COUNT(DISTINCT CASE WHEN r.status IN ('病假','事假','公假','丧假') THEN r.student_id END) as leave_count
        FROM records r
        ${clsJoin}
        WHERE r.type='checkin' AND r.date >= ? AND r.date <= ?${clsCond}
        GROUP BY r.date
        ORDER BY r.date
      `, [startDateStr, endDateStr, ...f.params])[0]?.values || [];

      // 课堂缺勤：来自课堂签到记录，按日期聚合 status='缺勤' 的去重人数
      const classAbsentRows = database.exec(`
        SELECT r.date as date,
          COUNT(DISTINCT CASE WHEN r.status='缺勤' THEN r.student_id END) as class_absent
        FROM records r
        ${clsJoin}
        WHERE r.type='class' AND r.date >= ? AND r.date <= ?${clsCond}
        GROUP BY r.date
        ORDER BY r.date
      `, [startDateStr, endDateStr, ...f.params])[0]?.values || [];
      const classAbsentMap = {};
      classAbsentRows.forEach(r => { classAbsentMap[r[0]] = r[1] || 0; });

      res.json({
        code: 0,
        data: trend.map(r => ({
          date: r[0],
          total_count: r[1] || 0,
          in_count: r[2] || 0,
          not_return_count: r[3] || 0,
          leave_count: r[4] || 0,
          class_absent: classAbsentMap[r[0]] || 0
        }))
      });
    } catch (e) {
      res.json({ code: 1, message: e.message });
    }
  });

  // 操行评分（公开）——对标教师端「操行量化评分」表
  router.get('/api/stats/conduct/public', (req, res) => {
    try {
      const days = parseInt(req.query.days) || 30;
      const f = studentSqlFilter(req, req.query.class_name);
      if (f.empty) return res.json({ code: 0, data: [] });
      const endDate = localDateStr();
      // 起点 = 今天(clamped) - (days-1)；按本地日期分量计算，避免真实时钟越界导致窗口偏移
      const [ey, em, ed] = endDate.split('-').map(Number);
      const es = new Date(ey, em - 1, ed);
      es.setDate(es.getDate() - days + 1);
      const startDate = `${es.getFullYear()}-${String(es.getMonth()+1).padStart(2,'0')}-${String(es.getDate()).padStart(2,'0')}`;
      const clsWhere = f.where ? `WHERE s.${f.where}` : '';
      const result = database.exec(`
        SELECT s.id, s.student_id, s.name, s.dorm, s.class_name,
          COUNT(DISTINCT CASE WHEN r.status='在寝' THEN r.date END) as normal_days,
          COUNT(DISTINCT CASE WHEN r.status IN ('未归','不在寝') THEN r.date END) as absent_days,
          COUNT(DISTINCT CASE WHEN r.status IN ('病假','事假','公假','丧假') THEN r.date END) as leave_days,
          COUNT(DISTINCT r.date) as checkin_days
        FROM students s
        LEFT JOIN records r ON s.student_id = r.student_id AND r.type='checkin' AND r.date >= ? AND r.date <= ?
        ${clsWhere}
        GROUP BY s.id
        ORDER BY checkin_days DESC, normal_days DESC
      `, [startDate, endDate, ...f.params]);
      const rows = result[0]?.values || [];
      const scores = rows.map(r => {
        const normalDays = r[5] || 0, absentDays = r[6] || 0, leaveDays = r[7] || 0, checkinDays = r[8] || 0;
        // 评分规则：基础100 - 缺勤*5 - 请假*1（与教师端一致）
        let score = 100 - absentDays * 5 - leaveDays * 1;
        score = Math.max(0, Math.min(100, score));
        return {
          id: r[0], student_id: r[1], name: r[2], dorm: r[3]||'', class_name: r[4]||'',
          normal_count: normalDays, absent_count: absentDays, leave_count: leaveDays,
          checkin_days: checkinDays, score: Math.round(score)
        };
      });
      res.json({ code: 0, data: scores });
    } catch (err) {
      res.json({ code: 1, message: err.message });
    }
  });

  // 重点关注学生/风险预警（公开）——对标教师端「重点关注学生」表
  router.get('/api/stats/attention/public', (req, res) => {
    try {
      const days = parseInt(req.query.days) || 30;
      const f = studentSqlFilter(req, req.query.class_name);
      if (f.empty) return res.json({ code: 0, data: [] });
      const endDate = localDateStr();
      // 起点 = 今天(clamped) - (days-1)；按本地日期分量计算，避免真实时钟越界导致窗口偏移
      const [ey, em, ed] = endDate.split('-').map(Number);
      const es = new Date(ey, em - 1, ed);
      es.setDate(es.getDate() - days + 1);
      const startDate = `${es.getFullYear()}-${String(es.getMonth()+1).padStart(2,'0')}-${String(es.getDate()).padStart(2,'0')}`;
      const clsWhere = f.where ? `WHERE s.${f.where}` : '';
      const result = database.exec(`
        SELECT s.id, s.name, s.dorm, s.class_name,
          SUM(CASE WHEN r.status IN ('未归','不在寝') THEN 1 ELSE 0 END) as absent_count,
          SUM(CASE WHEN r.status IN ('病假','事假','公假','丧假') THEN 1 ELSE 0 END) as leave_count
        FROM students s
        LEFT JOIN records r ON s.student_id = r.student_id AND r.type='checkin' AND r.date >= ? AND r.date <= ?
        ${clsWhere}
        GROUP BY s.id
        HAVING absent_count >= 3
        ORDER BY absent_count DESC, leave_count DESC
      `, [startDate, endDate, ...f.params]);
      const rows = result[0]?.values || [];
      const data = rows.map(r => ({
        id: r[0], name: r[1], dorm: r[2]||'', class_name: r[3]||'',
        absent_count: r[4] || 0, leave_count: r[5] || 0
      }));
      res.json({ code: 0, data });
    } catch (err) {
      res.json({ code: 1, message: err.message });
    }
  });

  return router;
}

module.exports = { init };
