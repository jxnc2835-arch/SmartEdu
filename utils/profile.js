// 学生行为画像模块
// 综合近 N 天考勤(未归/晚归)与请假数据，生成多维风险评分、风险等级、趋势与关注因素。
// 纯函数、零外部依赖，便于单元测试与路由复用。

/**
 * 格式化日期为 YYYY-MM-DD
 * @param {Date} d - 日期对象
 * @returns {string} 格式化后的日期字符串
 */
function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 根据分数确定风险等级
 * @param {number} score - 风险分数
 * @returns {string} 风险等级（'高'|'中'|'低'）
 */
function levelOf(score) {
  if (score >= 60) return '高';
  if (score >= 30) return '中';
  return '低';
}

/**
 * 趋势判定：基于后半段(近期)与前半段(前期)未归次数的比较
 * @param {number} recent - 近期未归次数
 * @param {number} prev - 前期未归次数
 * @returns {string} 趋势（'上升'|'下降'|'平稳'）
 */
function trendOf(recent, prev) {
  if (recent > prev * 1.3 + 0.5) return '上升';
  if (recent < prev * 0.7 - 0.5) return '下降';
  return '平稳';
}

/**
 * 评分权重（满分 100，超出截断）
 * @constant {number} W_ABSENT - 每次未归权重
 * @constant {number} W_LATE - 每次晚归(23:00 后签到)权重
 * @constant {number} W_LEAVE - 每次已批准请假权重（频繁请假反映不稳定）
 * @constant {number} W_CONSEC - 连续未归每多 1 天权重
 */
const W_ABSENT = 12;      // 每次未归
const W_LATE = 6;         // 每次晚归(23:00 后签到)
const W_LEAVE = 3;        // 每次已批准请假（频繁请假反映不稳定）
const W_CONSEC = 5;       // 连续未归每多 1 天

/**
 * 构建全体学生的行为画像
 * @param {object} db sql.js Database 实例
 * @param {object} [opts]
 * @param {number} [opts.days=30] 统计窗口天数
 * @returns {{profiles: Array, summary: object}}
 */
function buildStudentProfiles(db, opts = {}) {
  const days = Math.max(7, parseInt(opts.days) || 30);
  const today = new Date();
  const since = new Date(today);
  since.setDate(since.getDate() - (days - 1));
  const sinceStr = fmtDate(since);

  const half = Math.floor(days / 2);
  const mid = new Date(today);
  mid.setDate(mid.getDate() - (half - 1));
  const midStr = fmtDate(mid);

  const students = db.exec("SELECT id, student_id, name, class_name FROM students ORDER BY class_name, name")[0]?.values || [];

  // 近 days 天签到记录（含日期、状态、时间）
  const recRows = db.exec(
    `SELECT student_id, SUBSTR(time,1,10) AS d, status, SUBSTR(time,12,8) AS t
     FROM records WHERE type='checkin' AND SUBSTR(time,1,10) >= ?`,
    [sinceStr]
  )[0]?.values || [];

  // 近 days 天已批准请假
  const leaveRows = db.exec(
    `SELECT student_id FROM leaves WHERE status='已批准' AND start_date >= ?`,
    [sinceStr]
  )[0]?.values || [];

  const map = {};
  students.forEach(s => {
    map[s[1]] = {
      id: s[0], student_id: s[1], name: s[2], class_name: s[3],
      dates: {}, late_dates: {}, leave_count: 0, halfAbsent: 0, prevAbsent: 0
    };
  });

  recRows.forEach(r => {
    const stu = map[r[0]];
    if (!stu) return;
    const d = r[1], status = r[2], t = r[3];
    if (status === '未归') {
      stu.dates[d] = (stu.dates[d] || 0) + 1;
      if (d >= midStr) stu.halfAbsent++; else stu.prevAbsent++;
    } else if (status === '在寝' && t && parseInt(t.slice(0, 2), 10) >= 23) {
      stu.late_dates[d] = (stu.late_dates[d] || 0) + 1;
    }
  });

  leaveRows.forEach(r => {
    const stu = map[r[0]];
    if (stu) stu.leave_count++;
  });

  const profiles = Object.values(map).map(stu => {
    const absentDates = Object.keys(stu.dates).sort();
    const absent_count = absentDates.reduce((a, d) => a + stu.dates[d], 0);
    const late_count = Object.values(stu.late_dates).reduce((a, b) => a + b, 0);

    // 连续未归天数（在 since..today 连续日期窗口上计算）
    const dateSet = new Set(absentDates);
    let run = 0, maxConsec = 0;
    for (let i = 0; i < days; i++) {
      const dd = new Date(since);
      dd.setDate(dd.getDate() + i);
      if (dateSet.has(fmtDate(dd))) { run++; maxConsec = Math.max(maxConsec, run); }
      else run = 0;
    }

    let score = absent_count * W_ABSENT + late_count * W_LATE + stu.leave_count * W_LEAVE + Math.max(0, maxConsec - 1) * W_CONSEC;
    score = Math.min(100, score);

    const factors = [];
    if (absent_count > 0) factors.push({ type: 'absent', label: `近${days}天未归 ${absent_count} 次`, contribute: absent_count * W_ABSENT });
    if (late_count > 0) factors.push({ type: 'late', label: `晚归 ${late_count} 次`, contribute: late_count * W_LATE });
    if (stu.leave_count > 0) factors.push({ type: 'leave', label: `已批准请假 ${stu.leave_count} 次`, contribute: stu.leave_count * W_LEAVE });
    if (maxConsec >= 2) factors.push({ type: 'consecutive', label: `连续未归 ${maxConsec} 天`, contribute: Math.max(0, maxConsec - 1) * W_CONSEC });
    factors.sort((a, b) => b.contribute - a.contribute);

    return {
      student_id: stu.student_id,
      id: stu.id,
      name: stu.name,
      class_name: stu.class_name,
      absent_count,
      late_count,
      leave_count: stu.leave_count,
      max_consecutive_absent: maxConsec,
      risk_score: score,
      risk_level: levelOf(score),
      trend: trendOf(stu.halfAbsent, stu.prevAbsent),
      factors,
      recent_dates: absentDates.slice(-5)
    };
  });

  const levels = { 高: 0, 中: 0, 低: 0 };
  const trends = { 上升: 0, 下降: 0, 平稳: 0 };
  profiles.forEach(p => { levels[p.risk_level]++; trends[p.trend]++; });
  const summary = { total_students: profiles.length, levels, trends };

  return { profiles, summary };
}

module.exports = { buildStudentProfiles, levelOf, trendOf, fmtDate };
