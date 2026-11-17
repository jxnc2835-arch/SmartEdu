/**
 * AI 数据分析模块（真实数据版）
 * 接入 sql.js 内存库，所有分析函数返回真实统计；无 db 时安全降级为空数据（供测试）。
 */
const { fmtDate } = require('./date-utils');

let DB = null;
function setDb(db) { DB = db; }

// ===== 低层查询封装（sql.js）=====
function query(sql, params) {
  if (!DB) return [];
  try {
    const stmt = DB.prepare(sql);
    if (params && params.length) stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  } catch (e) {
    console.warn('[AI-DB] query err:', e.message);
    return [];
  }
}
function queryOne(sql, params) {
  const r = query(sql, params);
  return r && r.length ? r[0] : null;
}

// 出勤状态分类
const PRESENT = ['在寝', '出勤', '迟到'];  // 到勤（迟到算到勤）
const LEAVE   = ['事假', '病假', '请假'];  // 请假
const ABSENT  = ['未归', '缺勤'];          // 缺勤/未归

function currentDate() {
  const r = queryOne("SELECT MAX(date) AS d FROM records WHERE type='checkin'");
  return (r && r.d) ? r.d : fmtDate(new Date());
}
function shiftDays(iso, delta) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + delta);
  return d.toISOString().slice(0, 10);
}
function classify(rows) {
  let present = 0, leave = 0, absent = 0, total = 0;
  for (const x of rows) {
    total += x.c;
    if (PRESENT.includes(x.s)) present += x.c;
    else if (LEAVE.includes(x.s)) leave += x.c;
    else if (ABSENT.includes(x.s)) absent += x.c;
  }
  return { present, leave, absent, total, rate: total ? Math.round(present / total * 1000) / 10 : 0 };
}

// ===== 各意图真实实现 =====
function analyzeTodayCheckin(classFilter, dateOverride) {
  const today = dateOverride || currentDate();
  const cls = classFilter ? ' AND r.class_name=?' : '';
  const rows = query(
    `SELECT r.status AS s, COUNT(*) AS c FROM records r WHERE r.type='checkin' AND r.date=? ${cls} GROUP BY r.status`,
    cls ? [today, classFilter] : [today]
  );
  const c = classify(rows);
  return { date: today, attendance_rate: c.rate, present: c.present, leave: c.leave, absent: c.absent, total_students: c.total };
}

function analyzeAbsentList(classFilter, dateOverride) {
  const today = dateOverride || currentDate();
  const cls = classFilter ? ' AND s.class_name=?' : '';
  const rows = query(
    `SELECT s.name AS name, s.class_name AS class_name, s.dorm AS dorm
     FROM records r JOIN students s ON s.student_id=r.student_id
     WHERE r.type='checkin' AND r.date=? AND r.status IN ('未归','缺勤') ${cls}`,
    cls ? [today, classFilter] : [today]
  );
  return { count: rows.length, students: rows, date: today };
}

function analyzeHighRisk(classFilter, endDateOverride, daysOverride) {
  const days = daysOverride || 30;
  const today = endDateOverride || currentDate();
  const cutoff = shiftDays(today, -days);
  const cls = classFilter ? ' AND s.class_name=?' : '';
  const rows = query(
    `SELECT s.name AS name, s.class_name AS class_name, s.dorm AS dorm,
            SUM(CASE WHEN r.status IN ('未归','缺勤') THEN 1 ELSE 0 END) AS absent,
            SUM(CASE WHEN r.status IN ('在寝','出勤','迟到') THEN 1 ELSE 0 END) AS present
     FROM records r JOIN students s ON s.student_id=r.student_id
     WHERE r.type='checkin' AND r.date>=? ${cls}
     GROUP BY s.student_id HAVING absent>0 ORDER BY absent DESC, present ASC LIMIT 15`,
    cls ? [cutoff, classFilter] : [cutoff]
  );
  return { count: rows.length, students: rows, end_date: today, days };
}

function analyzeAbsentTrend(daysOverride, studentName) {
  const days = daysOverride || 30;
  const today = currentDate();
  const cutoff = shiftDays(today, -days);
  const rows = query(
    `SELECT r.date AS date,
            SUM(CASE WHEN r.status IN ('在寝','出勤','迟到') THEN 1 ELSE 0 END) AS present,
            COUNT(*) AS total
     FROM records r WHERE r.type='checkin' AND r.date>=? GROUP BY r.date ORDER BY r.date`,
    [cutoff]
  );
  return {
    daily: rows.map(x => ({ date: x.date, rate: x.total ? Math.round(x.present / x.total * 1000) / 10 : 0, present: x.present, total: x.total })),
    total: rows.length
  };
}

function analyzeClassCompare(classFilter) {
  const rows = query(
    `SELECT r.class_name AS class_name,
            SUM(CASE WHEN r.status IN ('在寝','出勤','迟到') THEN 1 ELSE 0 END) AS present,
            COUNT(*) AS total
     FROM records r WHERE r.type='checkin' GROUP BY r.class_name ORDER BY class_name`
  );
  return rows.map(x => ({ class_name: x.class_name, rate: x.total ? Math.round(x.present / x.total * 1000) / 10 : 0, present: x.present, total: x.total }));
}

function searchStudent(keyword) {
  const rows = query(
    `SELECT s.student_id AS sid, s.name AS name, s.class_name AS class_name, s.dorm AS dorm, s.gender AS gender, s.phone AS phone
     FROM students s WHERE s.name LIKE ? ORDER BY s.class_name, s.name`,
    ['%' + (keyword || '') + '%']
  );
  return { count: rows.length, students: rows };
}

function analyzeStudentPeriodSummary(studentId, daysOverride) {
  const days = daysOverride || 30;
  const today = currentDate();
  const cutoff = shiftDays(today, -days);
  const rows = query(
    `SELECT r.status AS s, COUNT(*) AS c FROM records r
     WHERE r.student_id=? AND r.type='checkin' AND r.date>=? GROUP BY r.status`,
    [studentId, cutoff]
  );
  const c = classify(rows);
  const recent = query(
    `SELECT r.date AS date, r.status AS status, r.type AS type FROM records r
     WHERE r.student_id=? AND r.type='checkin' ORDER BY r.date DESC LIMIT 8`,
    [studentId]
  );
  return { total: c.total, present: c.present, leave: c.leave, absent: c.absent, rate: c.rate, days, recent, end_date: today };
}

function analyzeDormAbsence(building, classFilter, dateOverride) {
  const today = dateOverride || currentDate();
  const rows = query(
    `SELECT s.name AS name, s.class_name AS class_name, s.dorm AS dorm
     FROM records r JOIN students s ON s.student_id=r.student_id
     WHERE r.type='checkin' AND r.date=? AND r.status IN ('未归','缺勤') AND s.dorm LIKE ?`,
    [today, (building || '') + '%']
  );
  const existsRow = queryOne("SELECT COUNT(*) AS c FROM students WHERE dorm LIKE ?", [(building || '') + '%']);
  const exists = !!(existsRow && existsRow.c > 0);
  return { count: rows.length, students: rows, building: building || '', date: today, found: exists };
}

function getAlertSummary() {
  const open = queryOne("SELECT COUNT(*) AS c FROM absence_alerts WHERE status='open'");
  const today = currentDate();
  const closedToday = queryOne("SELECT COUNT(*) AS c FROM absence_alerts WHERE status='closed' AND date=?", [today]);
  return { open: open ? open.c : 0, closed_today: closedToday ? closedToday.c : 0 };
}

function getFullDataSnapshot(classFilter) {
  return {
    today: analyzeTodayCheckin(classFilter),
    absent: analyzeAbsentList(classFilter),
    risk: analyzeHighRisk(classFilter),
    trend: analyzeAbsentTrend(7),
    class_compare: analyzeClassCompare(classFilter)
  };
}

// ===== 以下为旧版占位函数（保留导出，避免破坏其它调用；智能问答主链路已走上面真实实现）=====
function analyzeAbsentRange(classFilter, start, end) { return { count: 0, students: [], start, end }; }
function analyzeStudentPeriodSummaryStub() { return { student: null, stats: {}, checkinRecords: [], courseRecords: [], leaveRecords: [] }; }
function analyzePeriodOverview(classFilter, start, end) { return { start, end, days: 0, total: 0, present: 0, absent: 0, leave: 0, attendance_rate: 0 }; }
function analyzeClassCompareRange(classFilter, start, end) { return []; }
function analyzeLeave(classFilter, param = '') {
  // 计数同样按班级过滤（join students），与名单口径一致
  const joinS = classFilter ? ' JOIN students s ON s.student_id=l.student_id' : '';
  const clsC = classFilter ? ' AND s.class_name=?' : '';
  const cp = classFilter ? [classFilter] : [];
  const pending = queryOne(`SELECT COUNT(*) AS c FROM leaves l${joinS} WHERE l.status NOT IN ('approved','rejected','closed')${clsC}`, cp);
  const total = queryOne(`SELECT COUNT(*) AS c FROM leaves l${joinS}${clsC}`, clsC ? cp : []);
  const approved = queryOne(`SELECT COUNT(*) AS c FROM leaves l${joinS} WHERE l.status='approved'${clsC}`, cp);
  const rejected = queryOne(`SELECT COUNT(*) AS c FROM leaves l${joinS} WHERE l.status='rejected'${clsC}`, cp);
  const today = currentDate();
  const cls = classFilter ? ' AND s.class_name=?' : '';
  const todayOnLeave = query(
    `SELECT COUNT(*) AS c FROM records r JOIN students s ON s.student_id=r.student_id
     WHERE r.type='checkin' AND r.date=? AND r.status IN ('事假','病假','请假') ${cls}`,
    cls ? [today, classFilter] : [today]
  );
  const tol = todayOnLeave.length ? todayOnLeave[0].c : 0;
  // 待审批名单明细（join 学生信息，最多 20 条；供本地渲染与 LLM 数据上下文使用）
  const pendingList = query(
    `SELECT s.name AS name, s.class_name AS class_name, s.dorm AS dorm,
            l.type AS type, l.reason AS reason, l.start_date AS start_date,
            l.end_date AS end_date, l.created_at AS created_at
     FROM leaves l JOIN students s ON s.student_id=l.student_id
     WHERE l.status NOT IN ('approved','rejected','closed') ${cls}
     ORDER BY l.created_at ASC LIMIT 20`,
    cls ? [classFilter] : []
  );
  const byType = query(
    `SELECT l.type AS type, COUNT(*) AS c FROM leaves l JOIN students s ON s.student_id=l.student_id
     WHERE l.status NOT IN ('approved','rejected','closed') ${cls} GROUP BY l.type ORDER BY c DESC`,
    cls ? [classFilter] : []
  );
  return {
    pending: pending ? pending.c : 0,
    today_on_leave: tol,
    total: total ? total.c : 0,
    approved: approved ? approved.c : 0,
    rejected: rejected ? rejected.c : 0,
    pending_list: pendingList,
    pending_list_shown: pendingList.length,
    pending_by_type: byType,
    date: today
  };
}

function analyzeCourseAttendance(classFilter, courseFilter = '', daysOverride) {
  const days = daysOverride || 7;
  const today = currentDate();
  const cutoff = shiftDays(today, -days);
  const cls = classFilter ? ' AND r.class_name=?' : '';
  const course = courseFilter ? ' AND r.course_name=?' : '';
  const params = cls && course ? [cutoff, classFilter, courseFilter]
    : cls ? [cutoff, classFilter]
    : course ? [cutoff, courseFilter]
    : [cutoff];
  const rows = query(
    `SELECT
        SUM(CASE WHEN r.status IN ('出勤','迟到') THEN 1 ELSE 0 END) AS present,
        SUM(CASE WHEN r.status NOT IN ('出勤','迟到') THEN 1 ELSE 0 END) AS absent,
        COUNT(*) AS total,
        COUNT(DISTINCT r.course_name) AS course_count
     FROM records r WHERE r.type='class' AND r.date>=? ${cls} ${course}`,
    params
  );
  const x = rows.length ? rows[0] : { present: 0, absent: 0, total: 0, course_count: 0 };
  return {
    recent_7d_rate: x.total ? Math.round(x.present / x.total * 1000) / 10 : 0,
    recent_7d_present: x.present || 0,
    recent_7d_absent: x.absent || 0,
    recent_7d_total: x.total || 0,
    course_count: x.course_count || 0,
    date_end: today
  };
}
function analyzeDormAnomaly() { return []; }
function analyzeDormMates(dormLike, classFilter) { return { currentStudent: null, dorm: dormLike, students: [] }; }
function analyzeClassCourseStats(classFilter = '', courseFilter = '', days = 7) { return []; }
function analyzeLateStudents(classFilter, dateOverride) { return { count: 0, students: [] }; }
function getStudentProfile(nameOrId, classFilter) { return null; }
function getRecentRecords(limit) { return []; }

/**
 * 根据意图加载数据（真实版）
 */
function loadDataForIntent(intentResult, sessionCtx) {
  const intent = intentResult.intent;
  const classFilter = intentResult.classFilter || '';
  const dateRef = intentResult.dateRef || { kind: 'today', date: currentDate() };
  const result = { intent, classFilter, dateRef, dataEnd: currentDate() };

  switch (intent) {
    case 'today':
      result.today = analyzeTodayCheckin(classFilter);
      break;
    case 'absent_list':
      result.absent = analyzeAbsentList(classFilter);
      break;
    case 'high_risk':
      result.risk = analyzeHighRisk(classFilter);
      break;
    case 'trend':
      result.trend = analyzeAbsentTrend(30);
      break;
    case 'class_compare':
      result.classes = analyzeClassCompare(classFilter);
      break;
    case 'dorm': {
      const b = (intentResult.param || '').trim();
      result.dormBuilding = b;
      result.dorm = b ? analyzeDormAbsence(b, classFilter) : { count: 0, students: [], building: '', date: currentDate(), found: false };
      break;
    }
    case 'search': {
      const name = (intentResult.param || '').trim();
      let search = searchStudent(name);
      // 重名时若用户同时指定了班级，用班级进一步消歧
      if (classFilter && search.count > 1) {
        const filtered = search.students.filter(s => s.class_name === classFilter);
        if (filtered.length >= 1) search = { count: filtered.length, students: filtered };
      }
      result.search = search;
      if (search.count === 1) {
        result.student = search.students[0];
        result.summary = analyzeStudentPeriodSummary(search.students[0].sid, 30);
      } else if (search.count > 1) {
        result.candidates = search.students;
      } else {
        result.notFound = true;
      }
      break;
    }
    case 'leave': {
      result.leave = analyzeLeave(classFilter);
      // 若问题中指定了学生（如"张三请假了吗/他最近有请假吗"），带出该生请假记录
      const nm = (intentResult.param || '').trim();
      if (nm) {
        const search = searchStudent(nm);
        if (search.count === 1) {
          result.student = search.students[0];
          result.studentLeaves = query(
            `SELECT type, reason, start_date, end_date, status FROM leaves
             WHERE student_id=? ORDER BY start_date DESC LIMIT 10`,
            [search.students[0].sid]
          );
        }
      }
      break;
    }
    case 'course':
      result.course = analyzeCourseAttendance(classFilter);
      break;
    case 'alerts':
      result.alerts = getAlertSummary();
      break;
    case 'advice':
      // 管理建议：聚合今日 / 高风险 / 班级对比
      result.today = analyzeTodayCheckin(classFilter);
      result.risk = analyzeHighRisk(classFilter);
      result.classes = analyzeClassCompare(classFilter);
      break;
    case 'general':
      // 通用模式返回空数据，交由 LLM 或兜底文案处理
      break;
    default:
      result.today = analyzeTodayCheckin(classFilter);
  }
  return result;
}

module.exports = {
  setDb,
  analyzeTodayCheckin,
  analyzeAbsentList,
  analyzeHighRisk,
  analyzeAbsentTrend,
  analyzeAbsentRange,
  analyzeStudentPeriodSummary,
  analyzePeriodOverview,
  analyzeClassCompare,
  analyzeClassCompareRange,
  analyzeLeave,
  analyzeDormAnomaly,
  analyzeDormAbsence,
  analyzeDormMates,
  analyzeCourseAttendance,
  analyzeClassCourseStats,
  analyzeLateStudents,
  searchStudent,
  getStudentProfile,
  getFullDataSnapshot,
  getRecentRecords,
  getAlertSummary,
  loadDataForIntent
};
