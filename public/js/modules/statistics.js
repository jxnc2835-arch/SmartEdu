/**
 * 统计分析模块
 * 提取自 teacher.html L3371-L3893
 */

// ==================== 统计概览 ====================
window.loadStats = async function() {
  const cls = document.getElementById('stClassFilter')?.value || '';
  
  const [overviewRes, attentionRes, conductRes, dormRankRes] = await Promise.all([
    apiAuth(`/api/stats/overview${cls ? '?class_name=' + encodeURIComponent(cls) : ''}`),
    apiAuth(`/api/stats/attention?days=30${cls ? '&class_name=' + encodeURIComponent(cls) : ''}`),
    apiAuth(`/api/stats/conduct?days=30${cls ? '&class_name=' + encodeURIComponent(cls) : ''}`),
    api(`/api/stats/dorm-rank/public?days=7${cls ? '&class_name=' + encodeURIComponent(cls) : ''}`)
  ]);
  
  // KPI
  if (overviewRes.code === 0) {
    const d = overviewRes.data || {};
    safeSetInnerHTML(document.getElementById('stKpi'), `
      <div class="s-card blue"><div class="n">${d.total_students || 0}</div><div class="l">👥 学生</div></div>
      <div class="s-card green"><div class="n">${(d.total_checkins || 0) + (d.total_attendances || 0)}</div><div class="l">📊 总记录</div></div>
      <div class="s-card red"><div class="n">${d.today_absent || 0}</div><div class="l">⚠️ 未归</div></div>
      <div class="s-card orange"><div class="n">${d.today_leave || 0}</div><div class="l">📝 请假</div></div>
    `);
  }
  
  // 缓存数据
  window._attentionCache = Array.isArray(attentionRes.data) ? attentionRes.data : [];
  window._conductCache = Array.isArray(conductRes.data) ? conductRes.data : [];
  
  // 并行渲染
  loadAbnormalRank(cls);
  loadMonthReport(cls);
  loadConduct(cls);
  loadDormRank(dormRankRes.data?.dorms || []);
  loadAttentionInStats();
  loadDormAnomaly(cls);
};

// ==================== 异常排行 ====================
window.loadAbnormalRank = async function(cls) {
  const el = document.getElementById('abnormalTable');
  const rows = window._attentionCache || [];
  
  if (!rows.length) {
    safeSetInnerHTML(el, '<div class="empty">暂无</div>');
    return;
  }
  
  window._abnormalAll = rows;
  renderPagedTable(rows, 1, 10, (slice) => {
    return `<table>
      <thead><tr><th>姓名</th><th>宿舍</th><th>未归</th><th>请假</th><th>合计</th></tr></thead>
      <tbody>${slice.map(r => {
        const absent = r.absent_count || r.absent_days || r.absent || 0;
        const leave = r.leave_count || r.leave_days || r.leave || 0;
        return `<tr>
          <td>${esc(r.name) || '-'}</td>
          <td>${esc(r.dorm) || '-'}</td>
          <td>${absent}</td>
          <td>${leave}</td>
          <td><b>${absent + leave}</b></td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
  }, 'abnormalPag', 'abnormalTable');
};

// ==================== 月报 ====================
window.monthTab = 'data';

window.switchMonthTab = function(t) {
  window.monthTab = t;
  const dataTab = document.getElementById('monthDataTab');
  const summaryTab = document.getElementById('monthSummaryTab');
  if (dataTab) dataTab.className = 'btn ' + (t === 'data' ? 'btn-p' : 'btn-o') + ' btn-sm';
  if (summaryTab) summaryTab.className = 'btn ' + (t === 'summary' ? 'btn-p' : 'btn-o') + ' btn-sm';
  window.loadMonthReport();
};

window.loadMonthReport = async function() {
  const el = document.getElementById('monthReportTable');
  const days = parseInt(document.getElementById('monthDays')?.value || 30);
  const cls = document.getElementById('stClassFilter')?.value || '';
  
  if (window.monthTab === 'summary') {
    safeSetInnerHTML(el, '<div class="empty">🤖 正在生成 AI 月报简报...</div>');
    try {
      const clsName = cls && cls !== '全部' ? `（${cls}班）` : '';
      const j = await apiAuth('/ai/smart?question=' + encodeURIComponent(`生成${clsName}近${days}天的查寝月报简报`));
      const ans = j.data?.answer || '生成失败';
      safeSetInnerHTML(el, `<div style="padding:24px;background:linear-gradient(135deg,#f0f9ff 0%,#e0e7ff 100%);border-radius:12px;line-height:1.8">${esc(ans).replace(/\n/g, '<br>')}</div>`);
    } catch (e) {
      safeSetInnerHTML(el, '<div class="empty">生成失败：' + esc(e.message) + '</div>');
    }
    return;
  }
  
  safeSetInnerHTML(el, '<div class="empty">加载中...</div>');
  const rows = window._conductCache || [];
  
  if (!rows.length) {
    safeSetInnerHTML(el, '<div class="empty">暂无月报数据</div>');
    return;
  }
  
  // 按班级分组
  const byClass = {};
  rows.forEach(r => {
    const clsName = r.class_name || '-';
    if (!byClass[clsName]) byClass[clsName] = { students: 0, total: 0, absent: 0, leave: 0, alert: 0 };
    byClass[clsName].students++;
    byClass[clsName].total += (r.normal_days || 0) + (r.absent_days || 0) + (r.leave_days || 0);
    byClass[clsName].absent += (r.absent_days || 0);
    byClass[clsName].leave += (r.leave_days || 0);
    if ((r.absent_days || 0) >= 3) byClass[clsName].alert++;
  });
  
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - days);
  const label = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')} ~ ${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`;
  
  const totalClasses = Object.keys(byClass).length;
  const totalStudents = Object.values(byClass).reduce((s, c) => s + c.students, 0);
  const totalAbsent = Object.values(byClass).reduce((s, c) => s + c.absent, 0);
  const totalLeave = Object.values(byClass).reduce((s, c) => s + c.leave, 0);
  const totalAlert = Object.values(byClass).reduce((s, c) => s + c.alert, 0);
  const classList = Object.entries(byClass).map(([c, info]) => ({ c, ...info }));
  
  if (document.getElementById('monthLabel')) {
    document.getElementById('monthLabel').textContent = `（${label}）`;
  }
  
  renderPagedTable(classList, 1, 10, (slice, page, total, pages) => {
    return `<div class="report-summary-bar" style="border-left:4px solid #3b82f6;padding:12px 16px;border-radius:6px;margin-bottom:12px;font-size:13px">
      <div style="font-weight:600;margin-bottom:6px">📊 报告摘要 (${label})</div>
      <div style="display:flex;gap:18px;flex-wrap:wrap">
        <span>👥 总人数：<b>${totalStudents}</b></span>
        <span>🏫 班级数：<b>${totalClasses}</b></span>
        <span>❌ 未归数：<b>${totalAbsent}</b> 次</span>
        <span>📝 请假数：<b>${totalLeave}</b> 次</span>
        <span>⚠️ 待审批：<b>${totalAlert}</b> 条</span>
      </div>
    </div>
    <table>
      <thead><tr><th>班级</th><th>人数</th><th>未归</th><th>请假</th><th>异常率</th><th>预警</th></tr></thead>
      <tbody>${slice.map(({ c, students, absent, leave, total: t, alert }) => {
        const rate = t > 0 ? Math.round(absent / t * 100) : 0;
        return `<tr>
          <td>${esc(c)}</td>
          <td>${students}</td>
          <td>${absent}</td>
          <td>${leave}</td>
          <td>${rate}%</td>
          <td>${alert > 0 ? `<span style="color:#dc2626;font-weight:600">⚠️ ${alert}</span>` : '<span style="color:#10b981">✅ 正常</span>'}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
  }, 'monthReportPag', 'monthReportTable');
};

// ==================== 操行评分 ====================
window.loadConduct = async function(cls) {
  const el = document.getElementById('conductTable');
  const rows = window._conductCache || [];
  
  if (!rows.length) {
    safeSetInnerHTML(el, '<div class="empty">共 0 名学生，评分规则：基础100分，按在寝率换算</div>');
    return;
  }
  
  window._conductCache = rows;
  renderPagedTable(rows, 1, 10, (slice, page, total, pages) => {
    return `<table>
      <thead><tr><th>排名</th><th>姓名</th><th>宿舍</th><th>班级</th><th>签到</th><th>缺勤</th><th>请假</th><th>评分</th><th>等级</th></tr></thead>
      <tbody>${slice.map((r, i) => {
        const rank = (page - 1) * 10 + i + 1;
        const score = r.score ?? 0;
        const level = score >= 100 ? '<span style="color:#10b981;background:#d1fae5;padding:2px 8px;border-radius:10px">优秀</span>' :
                      score >= 80 ? '<span style="color:#3b82f6;background:#dbeafe;padding:2px 8px;border-radius:10px">良好</span>' :
                      score >= 60 ? '<span style="color:#f59e0b;background:#fef3c7;padding:2px 8px;border-radius:10px">一般</span>' :
                                    '<span style="color:#ef4444;background:#fee2e2;padding:2px 8px;border-radius:10px">较差</span>';
        return `<tr>
          <td>${rank}</td>
          <td>${esc(r.name) || '-'}</td>
          <td>${esc(r.dorm) || '-'}</td>
          <td>${esc(r.class_name) || '-'}</td>
          <td>${r.normal_days || 0}</td>
          <td>${r.absent_days || 0}</td>
          <td>${r.leave_days || 0}</td>
          <td><b>${score}</b></td>
          <td>${level}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>
    <div class="sub" style="margin-top:8px;color:#64748b;font-size:12px">共 ${total} 名学生，评分规则：基础100分，按在寝率换算</div>`;
  }, 'conductPag', 'conductTable');
};

// ==================== 宿舍排名 ====================
window.loadDormRank = async function(rows) {
  const el = document.getElementById('dormRankTable');
  
  if (!rows || !rows.length) {
    safeSetInnerHTML(el, '<div class="empty">暂无数据</div>');
    return;
  }
  
  renderPagedTable(rows, 1, 10, (slice, page, total, pages) => {
    return `<table>
      <thead><tr><th>排名</th><th>宿舍</th><th>班级</th><th>人数</th><th>缺勤</th><th>出勤率</th></tr></thead>
      <tbody>${slice.map((r, i) => {
        const rank = (page - 1) * 10 + i + 1;
        let rate = r.attendance_rate;
        if (typeof rate === 'string') rate = parseFloat(rate);
        if (rate == null || isNaN(rate)) {
          rate = r.total_students > 0 ? Math.round((r.normal_count || 0) / r.total_students * 100) : 0;
        } else {
          rate = Math.round(rate);
        }
        return `<tr>
          <td>${rank}</td>
          <td>${esc(r.dorm) || '-'}</td>
          <td>${esc(r.class_name) || '-'}</td>
          <td>${r.total_students || 0}</td>
          <td>${r.absent_count || 0}</td>
          <td><b>${rate}%</b></td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
  }, 'dormRankPag', 'dormRankTable');
};

// ==================== 重点关注 ====================
window.loadAttentionInStats = async function() {
  const el = document.getElementById('attentionInStatsTable');
  const rows = window._attentionCache || [];
  const filtered = rows.filter(r => (r.absent_count || r.absent_days || 0) >= 3);
  
  if (!filtered.length) {
    safeSetInnerHTML(el, '<div style="padding:20px;text-align:center;color:#10b981">✅ 暂无需要关注的学生</div>');
    return;
  }
  
  renderPagedTable(filtered, 1, 10, (slice) => {
    return `<table>
      <thead><tr><th>姓名</th><th>班级</th><th>宿舍</th><th>缺勤</th><th>请假</th><th>风险</th></tr></thead>
      <tbody>${slice.map(r => {
        const absent = r.absent_count || r.absent_days || 0;
        return `<tr>
          <td>${esc(r.name) || '-'}</td>
          <td>${esc(r.class_name) || '-'}</td>
          <td>${esc(r.dorm) || '-'}</td>
          <td>${absent}</td>
          <td>${r.leave_count || r.leave_days || 0}</td>
          <td>${riskLevelTag(absent)}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
  }, 'attentionInStatsPag', 'attentionInStatsTable');
};

// ==================== 宿舍异常 ====================
window.loadDormAnomaly = async function(cls) {
  const el = document.getElementById('dormAnomalyTable');
  safeSetInnerHTML(el, '<div class="empty">加载中...</div>');
  
  try {
    const j = await apiAuth(`/api/stats/attention?days=7${cls ? '&class_name=' + encodeURIComponent(cls) : ''}`);
    const rows = Array.isArray(j.data) ? j.data : (j.data?.students || j.data?.at_risk || []);
    
    // 按宿舍分组
    const byDorm = {};
    rows.forEach(r => {
      if ((r.absent_count || 0) < 2) return;
      const d = r.dorm || '未知';
      if (!byDorm[d]) byDorm[d] = [];
      byDorm[d].push(r);
    });
    
    const anomalies = Object.entries(byDorm).filter(([d, list]) => list.length >= 2);
    
    if (!anomalies.length) {
      safeSetInnerHTML(el, '<div style="padding:20px;text-align:center;color:#10b981">✅ 今日无宿舍异常</div>');
      return;
    }
    
    const html = `<table>
      <thead><tr><th>宿舍</th><th>班级</th><th>未归学生</th><th>人数</th></tr></thead>
      <tbody>${anomalies.map(([d, list]) => {
        const clsName = list[0]?.class_name || '-';
        return `<tr>
          <td><b>${esc(d)}</b></td>
          <td>${esc(clsName)}</td>
          <td>${list.map(s => esc(s.name)).join('、')}</td>
          <td style="color:#dc2626;font-weight:600">${list.length}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
    safeSetInnerHTML(el, html);
  } catch (e) {
    safeSetInnerHTML(el, '<div class="empty">加载失败</div>');
  }
};

// ==================== 请假趋势 ====================
window.loadLeaveTrend = async function() {
  const el = document.getElementById('leaveTrendTable');
  safeSetInnerHTML(el, '<div class="empty">加载中...</div>');
  
  try {
    const j = await apiAuth('/api/stats/leave-trend');
    const rows = Array.isArray(j.data) ? j.data : (j.data?.months || []);
    
    if (!rows.length) {
      safeSetInnerHTML(el, '<div class="empty">暂无请假数据</div>');
      return;
    }
    
    const html = `<table>
      <thead><tr><th>月份</th><th>请假次数</th><th>趋势</th></tr></thead>
      <tbody>${rows.slice(-6).map(r => {
        const month = r.month || r.date || '-';
        const count = r.count || r.total || 0;
        return `<tr>
          <td>${esc(month)}</td>
          <td>${count}</td>
          <td>${count > 5 ? '📈 上升' : count < 2 ? '📉 下降' : '➡️ 平稳'}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
    safeSetInnerHTML(el, html);
  } catch (e) {
    safeSetInnerHTML(el, '<div class="empty">加载失败</div>');
  }
};
