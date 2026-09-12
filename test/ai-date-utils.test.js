// routes/ai/date-utils.js 单元测试
const { parseDateStr, fmtDate, shiftDate, dateDiffDays, weekRange, resolveDateRef } = require('../routes/ai/date-utils');

describe('date-utils', () => {
  test('parseDateStr 解析日期字符串', () => {
    const d = parseDateStr('2026-09-12');
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(8); // 0-indexed
    expect(d.getDate()).toBe(12);
  });

  test('fmtDate 格式化日期', () => {
    expect(fmtDate(new Date(2026, 8, 12))).toBe('2026-09-12');
    expect(fmtDate(new Date(2026, 0, 1))).toBe('2026-01-01');
  });

  test('shiftDate 日期偏移', () => {
    const d = shiftDate('2026-09-12', 1);
    expect(d).toBe('2026-09-13');
    const d2 = shiftDate('2026-09-12', -1);
    expect(d2).toBe('2026-09-11');
  });

  test('dateDiffDays 计算天数差', () => {
    expect(dateDiffDays('2026-09-01', '2026-09-12')).toBe(12);
  });

  test('weekRange 计算本周范围', () => {
    const range = weekRange('2026-09-12'); // 周六
    expect(range.start).toBe('2026-09-07');
    expect(range.end).toBe('2026-09-13');
  });

  test('resolveDateRef 解析日期引用', () => {
    expect(resolveDateRef('今天').kind).toBe('today');
    expect(resolveDateRef('本周').kind).toBe('week');
    expect(resolveDateRef('本月').kind).toBe('month');
    expect(resolveDateRef('最近7天').kind).toBe('recentN');
    expect(resolveDateRef('最近7天').days).toBe(7);
  });
});
