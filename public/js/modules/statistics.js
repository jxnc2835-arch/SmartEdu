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

// ==================== 心理健康预警 ====================
window.loadMentalAlert = async function(cls) {
  const el = document.getElementById('mentalAlertTable');
  const rows = window._attentionCache || [];
  const highRisk = rows.filter(r => (r.absent_count || r.absent_days || 0) >= 5);
  if (!highRisk.length) {
    safeSetInnerHTML(el, '<div style="padding:20px;text-align:center;color:#10b981">✅ 暂无需重点关注的学生</div>');
    return;
  }
  el.innerHTML = renderPagedTable(highRisk, 1, 10, (slice) => {
    return `<table><thead><tr><th>姓名</th><th>班级</th><th>宿舍</th><th>缺勤</th><th>等级</th></tr></thead><tbody>` +
      slice.map(r => `<tr><td>${esc(r.name || '-')}</td><td>${esc(r.class_name || '-')}</td><td>${esc(r.dorm || '-')}</td><td><b>${r.absent_count || r.absent_days || 0}</b></td><td>${statusTag('高')}</td></tr>`).join('') +
      `</tbody></table>`;
  }, 'mentalAlertPag', 'mentalAlertTable');
};

// ==================== AI预测维度切换 ====================
let aiDim = 'checkin';
window.switchAiDim = function(dim) {
  if (!['checkin', 'class'].includes(dim)) dim = 'checkin';
  aiDim = dim;
  const b1 = document.getElementById('dimCheckin');
  const b2 = document.getElementById('dimClass');
  if (b1) { b1.style.background = dim === 'checkin' ? '#4f46e5' : 'transparent'; b1.style.color = dim === 'checkin' ? '#fff' : '#475569'; }
  if (b2) { b2.style.background = dim === 'class' ? '#4f46e5' : 'transparent'; b2.style.color = dim === 'class' ? '#fff' : '#475569'; }
  const hint = document.getElementById('aiDimHint');
  if (hint) hint.textContent = dim === 'checkin' ? '每晚 22:00 查寝在寝率' : '每日课堂出勤率（每班≥1次签到）';
  loadAiPredictionStats();
};

// ==================== AI预测加载 ====================
async function loadAiPredictionStats() {
  const loadingEl = document.getElementById('aiPredictLoading');
  const contentEl = document.getElementById('aiPredictContent');
  if (!loadingEl || !contentEl) return;

  const cls = document.getElementById('stClassFilter')?.value?.trim() || '';
  const clsParam = cls ? '&class_name=' + encodeURIComponent(cls) : '';
  const cacheKey = 'ai_' + aiDim + '_' + cls;
  const cached = window._aiCache?.[cacheKey];
  if (cached && Date.now() - cached.ts < 5 * 60 * 1000) {
    window._aiLastArima = cached.arima;
    window._aiLastLstm = cached.lstm;
    window._aiLastEval = cached.eval;
    loadingEl.style.display = 'none';
    contentEl.style.display = 'block';
    renderAiPredictionChart(cached.arima, cached.lstm);
    renderAiMetricsTable(cached.eval);
    return;
  }

  loadingEl.style.display = 'block';
  contentEl.style.display = 'none';

  try {
    const [arimaRes, lstmRes, evalRes] = await Promise.all([
      apiAuth('/api/predict/checkin-trend?days=7&model=arima&dim=' + aiDim + clsParam).catch(e => ({ code: 1, message: e.message })),
      apiAuth('/api/predict/checkin-trend?days=7&model=lstm&dim=' + aiDim + clsParam).catch(e => ({ code: 1, message: e.message })),
      apiAuth('/api/predict/evaluate?days=30&lstm=1&dim=' + aiDim + clsParam).catch(e => ({ code: 1, message: e.message }))
    ]);

    loadingEl.style.display = 'none';
    contentEl.style.display = 'block';

    window._aiLastArima = arimaRes.data;
    window._aiLastLstm = lstmRes.data;
    window._aiLastEval = evalRes.data;
    renderAiPredictionChart(arimaRes.data, lstmRes.data);
    renderAiMetricsTable(evalRes.data);

    if (!window._aiCache) window._aiCache = {};
    window._aiCache[cacheKey] = { ts: Date.now(), arima: arimaRes.data, lstm: lstmRes.data, eval: evalRes.data };
  } catch (e) {
    console.error('AI预测模块加载失败:', e);
    const contentEl = document.getElementById('aiPredictContent');
    if (contentEl) contentEl.innerHTML = '<div style="padding:20px;text-align:center;color:#ef4444">AI 预测数据加载失败，请刷新重试</div>';
  }
}
window.loadAiPredictionStats = loadAiPredictionStats;

// ==================== AI预测图表渲染 ====================
window.renderAiPredictionChart = function(arimaData, lstmData) {
  const ctx = document.getElementById('aiPredictionChart');
  if (!ctx) return;
  if (window._aiPredictionChart) window._aiPredictionChart.destroy();

  const arimaHistory = Array.isArray(arimaData?.history) ? arimaData.history : [];
  const arimaPred = Array.isArray(arimaData?.predictions) ? arimaData.predictions : [];
  const lstmPred = Array.isArray(lstmData?.predictions) ? lstmData.predictions : [];

  if (!arimaHistory.length && !arimaPred.length && !lstmPred.length) {
    const lbl = arimaData?.dim_label || '签到';
    const summaryEl = document.getElementById('aiPredictionSummary');
    if (summaryEl) summaryEl.innerHTML = '<span style="color:#94a3b8">暂无足够历史数据用于预测（至少需要 7 天' + lbl + '记录）</span>';
    return;
  }
  const predTitle = document.getElementById('aiPredTitle');
  if (predTitle) predTitle.textContent = (arimaData?.dim_label || '签到率') + ' 趋势预测' + (arimaData?.class_name && arimaData.class_name !== '全部' ? '（' + arimaData.class_name + '）' : '');

  const historyLabels = arimaHistory.map(h => h.date?.slice(5) || '-');
  const historyRates = arimaHistory.map(h => Number(h.rate?.toFixed(2)) || 0);
  const lastRate = historyRates.length ? historyRates[historyRates.length - 1] : null;

  const predLabels = arimaPred.map(p => p.date?.slice(5) || '-');
  const arimaRates = arimaPred.map(p => Number(p.predicted_rate?.toFixed(2)) || 0);
  const lstmRates = lstmPred.map(p => Number(p.predicted_rate?.toFixed(2)) || 0);

  const labels = [...historyLabels, ...predLabels];
  const arimaFull = lastRate != null ? [...historyRates.slice(0, -1), lastRate, ...arimaRates] : [...Array(historyRates.length).fill(null), ...arimaRates];
  const lstmFull = lastRate != null ? [...historyRates.slice(0, -1), lastRate, ...lstmRates] : [...Array(historyRates.length).fill(null), ...lstmRates];

  const isDark = document.documentElement.classList.contains('dark-mode');
  const gridColor = isDark ? '#2d3a4f' : '#f1f5f9';
  const tickColor = isDark ? '#94a3b8' : '#64748b';
  const titleColor = isDark ? '#94a3b8' : '#64748b';

  window._aiPredictionChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        { label: '历史签到率', data: historyRates, borderColor: '#64748b', backgroundColor: '#64748b', borderWidth: 2, pointStyle: 'circle', pointRadius: 4, pointHoverRadius: 6, tension: 0.3 },
        { label: 'ARIMA 预测', data: arimaFull, borderColor: '#4f46e5', backgroundColor: '#4f46e5', borderWidth: 2, borderDash: [6, 4], pointStyle: 'rect', pointRadius: 4, pointHoverRadius: 6, tension: 0.3 },
        { label: 'LSTM 预测', data: lstmFull, borderColor: '#10b981', backgroundColor: '#10b981', borderWidth: 2, borderDash: [3, 3], pointStyle: 'circle', pointRadius: 5, pointHoverRadius: 7, pointBackgroundColor: '#fff', pointBorderWidth: 2, tension: 0.3 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ctx.dataset.label + ': ' + (ctx.parsed.y != null ? ctx.parsed.y + '%' : '-') } } },
      scales: {
        y: { min: 50, max: 100, title: { display: true, text: (arimaData?.dim_label || '签到率') + ' (%)', font: { size: 11 }, color: titleColor }, grid: { color: gridColor }, ticks: { color: tickColor, font: { size: 11 } } },
        x: { grid: { display: false }, ticks: { color: tickColor, font: { size: 11 } } }
      }
    }
  });

  const trend = arimaData?.trend_direction || lstmData?.trend_direction || '平稳';
  const arrow = trend === '上升' ? '📈' : trend === '下降' ? '📉' : '➡️';
  const last = arimaHistory.length ? arimaHistory[arimaHistory.length - 1].rate?.toFixed(2) : '-';
  const predAvg = arimaRates.length ? (arimaRates.reduce((a, b) => a + b, 0) / arimaRates.length).toFixed(2) : '-';
  const summaryEl = document.getElementById('aiPredictionSummary');
  if (summaryEl) summaryEl.innerHTML =
    `<span style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;background:#eef2ff;border-radius:8px;color:#4338ca">${arrow} 未来趋势：${trend}</span>` +
    `<span style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;background:#f0f9ff;border-radius:8px;color:#0369a1">📅 最新历史：${last}%</span>` +
    `<span style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;background:#f0fdf4;border-radius:8px;color:#15803d">🔮 预测均值：${predAvg}%</span>`;
};

// ==================== AI预测指标表格 ====================
window.renderAiMetricsTable = function(evalData) {
  const summaryEl = document.getElementById('aiMetricsSummary');
  const tableBody = document.querySelector('#aiMetricsTable tbody');
  if (!tableBody) return;

  const results = Array.isArray(evalData?.results) ? evalData.results : [];
  if (!results.length) {
    if (summaryEl) summaryEl.innerHTML = '<span style="color:#94a3b8">暂无足够历史数据进行模型回测</span>';
    tableBody.innerHTML = '<tr><td colspan="5" style="color:#94a3b8">数据不足</td></tr>';
    return;
  }

  const best = evalData?.best || '-';
  if (summaryEl) summaryEl.innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;background:#d1fae5;border-radius:8px;color:#047857">🏆 更优模型：${esc(best)} · 回测样本：${evalData?.samples || 0} 天</span>`;

  const colors = { 'ARIMA': '#4f46e5', 'LSTM': '#10b981' };
  tableBody.innerHTML = results.filter(r => r.model !== '朴素基线' && (r.rmse != null || r.mae != null || r.mape != null)).map(r => {
    const isBest = r.model === best;
    const fmt = v => v != null ? Number(v).toFixed(3) : '-';
    return `<tr class="${isBest ? 'best' : ''}"><td style="font-weight:600;color:${colors[r.model] || '#475569'}">${esc(r.model)}</td><td>${fmt(r.rmse)}</td><td>${fmt(r.mae)}</td><td>${fmt(r.mape)}</td><td>${r.samples || evalData.samples || 0}</td></tr>`;
  }).join('');
};

// ==================== AI风险预测 ====================
window.loadAiRisk = async function() {
  const el = document.getElementById('aiRiskTable');
  el.innerHTML = '<div class="empty">加载中...</div>';
  try {
    const [predictRj, trendRj] = await Promise.all([
      apiAuth('/api/predict/at-risk').catch(() => ({ data: {} })),
      apiAuth('/api/stats/leave-trend').catch(() => ({ data: [] }))
    ]);
    const atRisk = Array.isArray(predictRj.data) ? predictRj.data : (predictRj.data?.at_risk || []);
    const trend = Array.isArray(trendRj.data) ? trendRj.data : (trendRj.data?.months || []);

    let html = '';
    if (atRisk.length) {
      html += `<h3 style="font-size:13px;margin:6px 0 8px;color:#6d28d9">📊 高风险学生（基于历史数据 AI 评分）</h3>`;
      html += `<table><thead><tr><th>排名</th><th>姓名</th><th>班级</th><th>缺勤</th><th>晚归</th><th>风险分</th><th>风险等级</th><th>趋势</th></tr></thead><tbody>`;
      atRisk.slice(0, 10).forEach((r, i) => {
        const score = r.risk_score || 0;
        const level = r.risk_level === '高' ? '<span style="color:#dc2626;background:#fee2e2;padding:2px 8px;border-radius:10px">🔴 高</span>' : r.risk_level === '中' ? '<span style="color:#f59e0b;background:#fef3c7;padding:2px 8px;border-radius:10px">🟡 中</span>' : '<span style="color:#10b981;background:#d1fae5;padding:2px 8px;border-radius:10px">🟢 低</span>';
        const trendDir = r.trend === '上升' ? '📈 上升' : r.trend === '下降' ? '📉 下降' : '➡️ 平稳';
        html += `<tr><td>${i + 1}</td><td>${esc(r.name || '-')}</td><td>${esc(r.class_name || '-')}</td><td>${r.absent_count || 0}</td><td>${r.late_count || 0}</td><td><b>${score}</b></td><td>${level}</td><td>${trendDir}</td></tr>`;
      });
      html += `</tbody></table>`;
    }

    if (trend.length) {
      html += `<h3 style="font-size:13px;margin:18px 0 8px;color:#6d28d9">📈 请假趋势预测（最近 6 个月）</h3>`;
      html += `<table><thead><tr><th>月份</th><th>请假次数</th><th>AI 预测</th></tr></thead><tbody>`;
      const counts = trend.map(r => r.count || r.total || 0);
      const n = counts.length;
      const avgX = (n - 1) / 2;
      const avgY = counts.reduce((s, v) => s + v, 0) / n;
      let num = 0, den = 0;
      counts.forEach((c, i) => { num += (i - avgX) * (c - avgY); den += (i - avgX) ** 2; });
      const slope = den !== 0 ? num / den : 0;
      const lastCount = counts[counts.length - 1] || 0;
      const nextPredict = Math.max(0, Math.round(lastCount + slope));
      trend.forEach((r, i) => {
        const month = r.month || r.date || '-';
        const count = r.count || r.total || 0;
        const isLast = i === trend.length - 1;
        const predict = isLast ? `≈ ${nextPredict} 次 (${slope > 0 ? '📈 上升' : slope < 0 ? '📉 下降' : '➡️ 平稳'})` : '-';
        html += `<tr><td>${esc(month)}</td><td>${count}</td><td>${predict}</td></tr>`;
      });
      html += `</tbody></table>`;
    }

    if (!html) el.innerHTML = '<div style="padding:20px;text-align:center;color:#10b981">✅ 暂无风险预警</div>';
    else el.innerHTML = html;
  } catch (e) {
    console.error(e);
    el.innerHTML = '<div class="empty">加载失败</div>';
  }
};

// ==================== 导出与备份 ====================
window.exportAllStats = async function() {
  const token = localStorage.getItem('admin_token');
  try {
    const r = await fetch('/api/export/all?_t=' + Date.now(), { headers: token ? { 'x-auth-token': token } : {} });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = '学管SmartEdu全量数据_' + new Date().toISOString().slice(0, 10) + '.xlsx';
    link.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert('导出失败：' + e.message);
  }
};

window.createQuickBackup = async function() {
  const r = await apiAuth('/api/backup', { method: 'POST' });
  if (r.code === 0) {
    const card = document.querySelector('#stKpi .s-card.purple .n');
    if (card) card.textContent = '✅';
    setTimeout(() => { if (card) card.textContent = '📦'; }, 2000);
  } else alert(r.message || '备份失败');
};

window.exportConduct = function() {
  const rows = window._conductCache || [];
  if (!rows.length) { alert('暂无数据'); return; }
  const headers = ['排名', '姓名', '班级', '宿舍', '签到', '缺勤', '请假', '评分'];
  const data = rows.map((r, i) => [
    i + 1, r.name || '', r.class_name || '', r.dorm || '',
    r.normal_days || 0, r.absent_days || 0, r.leave_days || 0,
    r.score ?? (100 + (r.normal_days || 0) - (r.absent_days || 0) * 5 - (r.leave_days || 0))
  ]);
  const csv = '\ufeff' + headers.join(',') + '\n' + data.map(r => r.map(v => `"${v}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = '操行评分_' + new Date().toISOString().slice(0, 10) + '.csv';
  a.click();
};
