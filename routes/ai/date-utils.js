/**
 * AI 日期工具模块
 * 从 routes/ai-chat.js 中提取的日期相关工具函数
 */

function parseDateStr(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, m - 1, d);
}

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${da}`;
}

function shiftDate(s, delta) {
  const d = parseDateStr(s);
  d.setDate(d.getDate() + delta);
  return fmtDate(d);
}

function dateDiffDays(a, b) {
  return Math.round((parseDateStr(b) - parseDateStr(a)) / 86400000) + 1;
}

function weekRange(s) {
  const d = parseDateStr(s);
  const day = d.getDay() || 7;
  const start = shiftDate(s, -(day - 1));
  const end = shiftDate(s, 7 - day);
  return { start, end };
}

function resolveDateRef(q) {
  const today = fmtDate(new Date());
  const qLow = (q || '').toLowerCase();
  
  // 精确日期
  const exactMatch = qLow.match(/(\d{4})[年\-](\d{1,2})[月\-](\d{1,2})日?/);
  if (exactMatch) {
    const [_, y, m, d] = exactMatch;
    return { kind: 'exact', date: `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}` };
  }
  
  // 最近N天
  const recentMatch = qLow.match(/最近(\d+)天/);
  if (recentMatch) {
    const days = parseInt(recentMatch[1]);
    const end = new Date();
    end.setDate(end.getDate() + 1);
    const start = new Date();
    start.setDate(start.getDate() - days + 1);
    return {
      kind: 'recentN',
      days,
      start: fmtDate(start),
      end: fmtDate(end)
    };
  }
  
  // 本周
  if (/本周|这周/.test(qLow)) {
    const now = new Date();
    const day = now.getDay() || 7;
    const start = shiftDate(fmtDate(now), -(day - 1));
    const end = shiftDate(start, 6);
    return { kind: 'week', start, end };
  }
  
  // 本月
  if (/本月|这个月/.test(qLow)) {
    const now = new Date();
    const start = fmtDate(new Date(now.getFullYear(), now.getMonth(), 1));
    const end = fmtDate(now);
    return { kind: 'month', start, end };
  }
  
  // 默认今天
  return { kind: 'today', date: today };
}

function dateRefDate(ir) {
  const d = ir && ir.dateRef;
  if (d && d.date) return d.date;
  return fmtDate(new Date());
}

function dateRefEnd(ir) {
  const d = ir && ir.dateRef;
  if (d && d.date) return d.date;
  return fmtDate(new Date());
}

function dateRefDays(ir) {
  const d = ir && ir.dateRef;
  if (d && d.kind === 'recentN' && d.days) return d.days;
  return 30;
}

function dateRefRange(ir) {
  const d = ir && ir.dateRef;
  if (!d) return null;
  if ((d.kind === 'week' || d.kind === 'month') && d.start && d.end) {
    return { start: d.start, end: d.end };
  }
  if (d.kind === 'recentN' && d.days) {
    const end = fmtDate(new Date());
    const start = shiftDate(end, -(d.days - 1));
    return { start, end };
  }
  return null;
}

module.exports = {
  parseDateStr,
  fmtDate,
  shiftDate,
  dateDiffDays,
  weekRange,
  resolveDateRef,
  dateRefDate,
  dateRefEnd,
  dateRefDays,
  dateRefRange
};
