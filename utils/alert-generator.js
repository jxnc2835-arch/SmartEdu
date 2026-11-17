/**
 * 告警生成核心逻辑（独立工具模块）
 * 避免 routes/alerts.js ↔ utils/alerts-sync.js 循环依赖
 * 
 * 设计原则：
 * - 纯业务逻辑在此模块
 * - routes/alerts.js 只负责 HTTP 路由封装
 * - utils/alerts-sync.js 只负责定时同步调用
 */
const { sendToWebhook, getSetting, pushPlus } = require('../routes/notify');
const { clampedToday } = require('./helpers');

/**
 * 允许的销号原因
 * @constant {string[]}
 */
const CLOSE_REASONS = ['已联系家长确认安全', '病假补登', '误报-已归寝', '其他原因'];

/**
 * 判断是否为管理员角色
 */
function isAdminRole(role) {
  return role === 'admin' || role === 'super_admin';
}

/**
 * 生成班级过滤 SQL WHERE 子句
 */
function whereInClasses(allowed) {
  if (!allowed || !allowed.length) return { clause: '', params: [] };
  return { clause: ' AND class_name IN (' + allowed.map(() => '?').join(',') + ')', params: allowed.slice() };
}

/**
 * 当前时间戳（北京时间 YYYY-MM-DD HH:mm:ss）
 */
function nowStamp() {
  const utc = Date.now() + new Date().getTimezoneOffset() * 60000;
  const bj = new Date(utc + 8 * 3600 * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${bj.getFullYear()}-${pad(bj.getMonth() + 1)}-${pad(bj.getDate())} ${pad(bj.getHours())}:${pad(bj.getMinutes())}:${pad(bj.getSeconds())}`;
}

/**
 * 生成今日告警并保存
 * @param {object} db - sql.js Database 实例
 * @param {Function} scheduleSave - 延迟保存函数
 */
function syncAlertsForToday(db, scheduleSave) {
  try {
    const today = clampedToday(db);
    generateAlerts(db, today, { scheduleSave }).catch(() => {});
  } catch (e) {}
}

/**
 * 扫描某日未归签到记录，去重建档；返回创建结果
 */
async function generateAlerts(db, date, { scheduleSave = () => {}, getWebhook = getSetting } = {}) {
  const rows = db.exec(
    `SELECT r.student_id, s.name, s.class_name, s.dorm
     FROM records r LEFT JOIN students s ON s.student_id = r.student_id
     WHERE (r.date = ? OR SUBSTR(r.time, 1, 10) = ?) AND r.type = 'checkin' AND r.status IN ('未归','晚归','不在寝','缺席')`,
    [date, date]
  )[0]?.values || [];

  if (!rows.length) {
    return { created: 0, total: 0, list: [], pushed: false, pushDetail: '' };
  }

  const existing = db.exec("SELECT student_id FROM absence_alerts WHERE date = ? AND status = 'open'", [date])[0]?.values?.map(v => v[0]) || [];
  const existingSet = new Set(existing);

  const created = [];
  rows.forEach(([sid, name, cls, dorm]) => {
    if (!sid || existingSet.has(sid)) return;
    const id = 'alert_' + date + '_' + sid;
    db.run(
      "INSERT OR IGNORE INTO absence_alerts(id, student_id, student_name, class_name, date, status, created_at) VALUES(?, ?, ?, ?, ?, 'open', ?)",
      [id, sid, name || sid, cls || '未知班级', date, nowStamp()]
    );
    created.push({ id, student_id: sid, student_name: name || sid, class_name: cls || '未知班级', dorm: dorm || '', date });
  });
  scheduleSave();

  let pushed = false;
  let pushDetail = '';
  if (created.length) {
    const byClass = {};
    created.forEach(a => { (byClass[a.class_name] = byClass[a.class_name] || []).push(a); });
    const lines = Object.keys(byClass).map(cls => {
      const items = byClass[cls].map((a, i) => `${i + 1}. ${a.student_name}（宿舍 ${a.dorm || '未知'}）`).join('\n');
      return `${cls}：\n${items}`;
    }).join('\n\n');
    const content = `【查寝系统】异常闭环告警 · ${date}\n以下学生未归，请辅导员跟进核实：\n\n${lines}\n\n（请在教师端「异常闭环」中登记跟进结果并销号）`;
    const enabled = getWebhook(db, 'notify_enabled') === '1';
    const url = getWebhook(db, 'notify_webhook');
    if (enabled && url) {
      const r = await sendToWebhook(url, content);
      pushed = !!r.ok;
      pushDetail = r.ok ? '' : (r.error || ('HTTP ' + r.status));
    } else {
      pushDetail = '未配置群机器人 Webhook';
    }
    // [新增] 个人微信（PushPlus）双通道推送，即使未配置群机器人也推
    const pp = await pushPlus(db, content);
    if (pp.sent) { pushed = true; if (!pushDetail || pushDetail === '未配置群机器人 Webhook') pushDetail = '已推送 PushPlus'; }
  }
  return { created: created.length, total: rows.length, list: created, pushed, pushDetail };
}

// 列表查询
function listAlerts(db, { status = 'open', date = '', allowed = [] } = {}) {
  let sql = 'SELECT id, student_id, student_name, class_name, date, status, reason, note, created_at, closed_at, closed_by FROM absence_alerts WHERE 1=1';
  const params = [];
  if (status !== 'all') { sql += ' AND status = ?'; params.push(status); }
  if (date) { sql += ' AND date = ?'; params.push(date); }
  const cls = whereInClasses(allowed);
  sql += cls.clause;
  params.push(...cls.params);
  sql += ' ORDER BY date DESC, created_at DESC';
  const rows = db.exec(sql, params)[0]?.values || [];
  const list = rows.map(r => ({
    id: r[0], student_id: r[1], student_name: r[2], class_name: r[3], date: r[4],
    status: r[5], reason: r[6], note: r[7], created_at: r[8], closed_at: r[9], closed_by: r[10]
  }));
  return { list, count: list.length };
}

// 统计
function alertStats(db, allowed = []) {
  const today = clampedToday(db);
  const cls = whereInClasses(allowed);
  const baseWhere = cls.clause.replace(/^ AND/, ' WHERE');
  const open = db.exec('SELECT COUNT(*) FROM absence_alerts' + baseWhere + (cls.clause ? ' AND' : ' WHERE') + " status = 'open'", cls.params)[0]?.values?.[0]?.[0] || 0;
  const openToday = db.exec('SELECT COUNT(*) FROM absence_alerts' + baseWhere + (cls.clause ? ' AND' : ' WHERE') + " status = 'open' AND date = ?", cls.params.concat([today]))[0]?.values?.[0]?.[0] || 0;
  const closed = db.exec('SELECT COUNT(*) FROM absence_alerts' + baseWhere + (cls.clause ? ' AND' : ' WHERE') + " status = 'closed'", cls.params)[0]?.values?.[0]?.[0] || 0;
  return { open, open_today: openToday, closed, today };
}

// 销号
function closeAlertById(db, id, { reason, note = '', userId = '', role = 'admin', allowed = [] } = {}) {
  if (!CLOSE_REASONS.includes(reason)) {
    return { code: 1, message: '销号原因不在允许范围' };
  }
  const row = db.exec('SELECT id, status, class_name FROM absence_alerts WHERE id = ?', [id])[0]?.values?.[0];
  if (!row) return { code: 1, message: '告警不存在' };
  if (row[1] !== 'open') return { code: 1, message: '该告警已销号' };
  if (!isAdminRole(role) && allowed.length && !allowed.includes(row[2])) {
    return { code: 1, message: '无权限操作其他班级的告警' };
  }
  db.run(
    "UPDATE absence_alerts SET status = 'closed', reason = ?, note = ?, closed_at = ?, closed_by = ? WHERE id = ? AND status = 'open'",
    [reason, note, nowStamp(), userId, id]
  );
  return { code: 0, message: '已销号并归档' };
}

module.exports = {
  generateAlerts,
  listAlerts,
  alertStats,
  closeAlertById,
  syncAlertsForToday,
  CLOSE_REASONS
};
