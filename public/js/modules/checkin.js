/**
 * 查寝管理模块
 * 封装签到查询、状态标签、渲染等核心功能
 */

// ==================== 状态标签生成器 ====================
window.statusTag = function(s) {
  if (!s) return '<span class="tag gray">—</span>';
  
  const tagMap = {
    '在寝': { cls: 'green', icon: '✅', text: '在寝' },
    '未归': { cls: 'red', icon: '❌', text: '未归' },
    '不在寝': { cls: 'red', icon: '❌', text: '未归' },
    '晚归': { cls: 'red', icon: '❌', text: '未归' },
    '出勤': { cls: 'green', icon: '✅', text: '已到' },
    '请假': { cls: 'yellow', icon: '📝', text: '请假' },
    '病假': { cls: 'yellow', icon: '📝', text: '病假' },
    '事假': { cls: 'yellow', icon: '📝', text: '事假' },
    '公假': { cls: 'yellow', icon: '📝', text: '公假' },
    '丧假': { cls: 'yellow', icon: '📝', text: '丧假' },
    'approved': { cls: 'green', icon: '✅', text: '已批准' },
    '已批准': { cls: 'green', icon: '✅', text: '已批准' },
    'pending': { cls: 'yellow', icon: '⏳', text: '待审批' },
    '待审批': { cls: 'yellow', icon: '⏳', text: '待审批' },
    'rejected': { cls: 'red', icon: '❌', text: '已驳回' },
    '已驳回': { cls: 'red', icon: '❌', text: '已驳回' },
    '迟到': { cls: 'yellow', icon: '🕐', text: '迟到' }
  };
  
  const tag = tagMap[s];
  if (tag) {
    return `<span class="tag ${tag.cls}">${tag.icon}${tag.text}</span>`;
  }
  return `<span class="tag gray">${esc(s)}</span>`;
};

window.riskLevelTag = function(absent) {
  const level = absent >= 5 ? '高' : absent >= 3 ? '中' : '低';
  const color = level === '高' ? 'red' : level === '中' ? 'yellow' : 'green';
  const icon = level === '高' ? '🔴' : level === '中' ? '🟡' : '🟢';
  return `<span class="tag ${color}">${icon}${level}</span>`;
};

// ==================== 分页按钮生成器 ====================
window.pageBtns = function(totalPages, currentPage) {
  if (totalPages <= 1) return '';
  
  let btns = '';
  const maxVisible = 5;
  let start = Math.max(1, currentPage - Math.floor(maxVisible / 2));
  let end = Math.min(totalPages, start + maxVisible - 1);
  if (end - start < maxVisible - 1) start = Math.max(1, end - maxVisible + 1);
  
  if (currentPage > 1) {
    btns += `<button data-page="${currentPage - 1}" class="btn-paging">‹</button>`;
  }
  
  for (let i = start; i <= end; i++) {
    btns += `<button data-page="${i}" class="${i === currentPage ? 'active' : ''}">${i}</button>`;
  }
  
  if (currentPage < totalPages) {
    btns += `<button data-page="${currentPage + 1}" class="btn-paging">›</button>`;
  }
  
  return btns;
};

// ==================== 概览数据加载 ====================
window.loadOverview = async function() {
  const cls = document.getElementById('ovClassFilter')?.value || '';
  let d = {};
  const dashUrl = cls 
    ? `/api/dashboard/public?class_name=${encodeURIComponent(cls)}`
    : '/api/dashboard/public';
  
  try {
    const j = await api(dashUrl);
    if (j.code === 0) d = j.data;
  } catch (e) {
    console.error('loadOverview error:', e);
  }
  
  // KPI日期回退
  if (d && ((d.today_present || 0) + (d.today_absent || 0) + (d.today_leave || 0) === 0) && (d.total_students || 0) > 0) {
    for (let offset = 1; offset <= 30; offset++) {
      const bd = new Date(beijingNow());
      bd.setDate(bd.getDate() - offset);
      const p = n => String(n).padStart(2, '0');
      const fd = `${bd.getFullYear()}-${p(bd.getMonth() + 1)}-${p(bd.getDate())}`;
      try {
        const fj = await api(dashUrl + (dashUrl.includes('?') ? '&' : '?') + 'date=' + encodeURIComponent(fd));
        if (fj.code === 0 && ((fj.data.today_present || 0) + (fj.data.today_absent || 0) + (fj.data.today_leave || 0) > 0)) {
          d = fj.data;
          break;
        }
      } catch (ex) {}
    }
  }
  
  // 更新显示
  const todayEl = document.getElementById('ovToday');
  if (todayEl) {
    todayEl.textContent = '日期：' + (d.date || todayStr()) + (cls ? ('　班级：' + cls) : '');
  }
  window._overviewDate = d.date || todayStr();
  
  // 渲染统计卡片
  const statsEl = document.getElementById('ovStats');
  if (statsEl) {
    safeSetInnerHTML(statsEl, `
      <div class="s-card blue"><div class="n">${d.total_students || 0}</div><div class="l"><i class="ic">👥</i> 学生总数</div></div>
      <div class="s-card teal"><div class="n">${d.today_present || 0}</div><div class="l"><i class="ic">🏠</i> 今日在寝</div></div>
      <div class="s-card red"><div class="n">${d.today_absent || 0}</div><div class="l"><i class="ic">⚠️</i> 今日未归</div></div>
      <div class="s-card orange"><div class="n">${d.today_leave || 0}</div><div class="l"><i class="ic">📝</i> 今日请假</div></div>
      <div class="s-card purple"><div class="n">${d.checkin_rate || 0}%</div><div class="l"><i class="ic">📊</i> 签到率</div></div>
    `);
  }
  
  // 加载实时动态
  loadLiveFeed(d.date || todayStr(), cls);
};

// ==================== 实时动态加载 ====================
window.loadLiveFeed = async function(queryDate, cls) {
  try {
    let rj = await api(`/api/records?date=${queryDate}&type=checkin&limit=5000${cls ? '&class_name=' + encodeURIComponent(cls) : ''}`);
    
    // 如果今天没有数据，往前找
    if ((!rj.data || !rj.data.length) && rj.pagination && rj.pagination.total === 0) {
      for (let offset = 1; offset <= 30; offset++) {
        const bd = new Date(beijingNow());
        bd.setDate(bd.getDate() - offset);
        const p = n => String(n).padStart(2, '0');
        queryDate = `${bd.getFullYear()}-${p(bd.getMonth() + 1)}-${p(bd.getDate())}`;
        rj = await api(`/api/records?date=${queryDate}&type=checkin&limit=12${cls ? '&class_name=' + encodeURIComponent(cls) : ''}`);
        if (rj.data && rj.data.length) break;
      }
    }
    
    const feed = document.getElementById('ovFeed');
    if (!feed) return;
    
    if (rj.data && rj.data.length) {
      safeSetInnerHTML(feed, '');
      rj.data.slice(0, 24).forEach(r => {
        addLiveItem(r);
      });
    } else {
      safeSetInnerHTML(feed, '<div class="empty">暂无查寝动态</div>');
    }
    startFeedAutoPlay();
  } catch (e) {
    console.error('loadLiveFeed error:', e);
  }
};

// ==================== 周趋势图 ====================
window.loadWeeklyTrend = async function() {
  const cls = document.getElementById('ovClassFilter')?.value || '';
  const days = [];
  const now = beijingNow();
  
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const p = n => String(n).padStart(2, '0');
    days.push(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`);
  }
  
  const labels = days.map(ds => ds.slice(5));
  let counts = [0, 0, 0, 0, 0, 0, 0];
  
  try {
    const j = await api('/api/class-trend/public?days=7' + (cls ? '&class_name=' + encodeURIComponent(cls) : ''));
    if (j.code === 0 && j.data) {
      const m = {};
      j.data.forEach(r => { m[r.date] = r.in_count || 0; });
      days.forEach((d, i) => { counts[i] = m[d] || 0; });
    }
  } catch (e) {
    // 回退：逐日请求
    for (let i = 0; i < days.length; i++) {
      try {
        const rj = await api(`/api/records?date=${days[i]}&type=checkin${cls ? '&class_name=' + encodeURIComponent(cls) : ''}`);
        counts[i] = rj.data ? rj.data.length : 0;
      } catch (ex) {}
    }
  }
  
  const labelEl = document.getElementById('ovWeekLabel');
  if (labelEl) labelEl.textContent = days[0].slice(5) + ' ~ ' + days[6].slice(5);
  
  if (window._ovChart) window._ovChart.destroy();
  const ctx = document.getElementById('ovChart')?.getContext('2d');
  if (ctx) {
    window._ovChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: '在寝人数',
          data: counts,
          borderColor: '#4f46e5',
          backgroundColor: 'rgba(79,70,229,.12)',
          fill: true,
          tension: 0.4,
          pointRadius: 5,
          pointHoverRadius: 7
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: { beginAtZero: true, grid: { color: 'rgba(148,163,184,.15)' } },
          x: { grid: { display: false } }
        }
      }
    });
  }
};

// ==================== 宿舍统计 ====================
window.loadDormStats = async function() {
  const el = document.getElementById('dormStats');
  if (!el) return;
  
  const cls = document.getElementById('ovClassFilter')?.value || '';
  try {
    let queryDate = window._overviewDate;
    if (!queryDate) {
      try {
        const clsParam = cls ? '?class_name=' + encodeURIComponent(cls) : '';
        const dj = await api('/api/dashboard/public' + clsParam);
        if (dj.code === 0 && dj.data && dj.data.date) queryDate = dj.data.date;
      } catch (e) {}
    }
    queryDate = queryDate || todayStr();
    
    let dj = await api(`/api/records?date=${queryDate}&type=checkin&limit=5000${cls ? '&class_name=' + encodeURIComponent(cls) : ''}`);
    
    // 今天无数据则回退
    if (!dj.data || !dj.data.length) {
      for (let offset = 1; offset <= 30; offset++) {
        const bd = new Date(beijingNow());
        bd.setDate(bd.getDate() - offset);
        const p = n => String(n).padStart(2, '0');
        const qd = `${bd.getFullYear()}-${p(bd.getMonth() + 1)}-${p(bd.getDate())}`;
        dj = await api(`/api/records?date=${qd}&type=checkin&limit=5000${cls ? '&class_name=' + encodeURIComponent(cls) : ''}`);
        if (dj.data && dj.data.length) break;
      }
    }
    
    // 按宿舍分组统计
    const map = {};
    (dj.data || []).forEach(r => {
      const dorm = r.dorm || '未知';
      if (!map[dorm]) map[dorm] = { total: 0, present: 0 };
      map[dorm].total++;
      if (r.status === '在寝') map[dorm].present++;
    });
    
    const rows = Object.entries(map).map(([dorm, data]) => ({
      dorm,
      total: data.total,
      present: data.present
    })).sort((a, b) => b.total - a.total);
    
    if (!rows.length) {
      safeSetInnerHTML(el, '<div class="empty">暂无宿舍数据</div>');
      return;
    }
    
    const html = `<div class="dorm-table-inner"><table>
      <thead><tr><th>宿舍</th><th>在寝人数</th><th>签到率</th></tr></thead>
      <tbody>${rows.map(r => {
        const pct = r.total ? Math.min(100, Math.round(r.present / r.total * 100)) : 0;
        const cls = pct >= 90 ? 'green' : pct >= 70 ? 'yellow' : 'red';
        return `<tr><td>${esc(r.dorm)}</td><td>${r.present}/${r.total}</td><td><span class="tag ${cls}">${pct}%</span></td></tr>`;
      }).join('')}</tbody>
    </table></div>`;
    safeSetInnerHTML(el, html);
  } catch (e) {
    console.error('loadDormStats error:', e);
    safeSetInnerHTML(el, '<div class="empty">加载失败</div>');
  }
};

// ==================== 查寝记录列表 ====================
window.ciAllRows = [];
window.ciPage = 1;

window.loadCheckin = async function() {
  const cls = document.getElementById('ovClassFilter')?.value || '';
  const st = document.getElementById('ciStatusFilter')?.value || '';
  const from = document.getElementById('ciFrom')?.value || '';
  const to = document.getElementById('ciTo')?.value || '';
  
  let url = '/api/records?type=checkin&limit=200';
  if (cls) url += `&class_name=${encodeURIComponent(cls)}`;
  if (st) url += `&status=${encodeURIComponent(st)}`;
  if (from) url += `&from=${from}`;
  if (to) url += `&to=${to}`;
  
  const j = await apiAuth(url);
  window.ciAllRows = j.data || [];
  window.ciPage = 1;
  renderCheckin(window.ciAllRows);
};

window.filterCheckin = function(allRows) {
  window.ciAllRows = allRows || window.ciAllRows;
  const keyword = document.getElementById('ciSearchInput')?.value.trim().toLowerCase();
  let filtered = window.ciAllRows;
  
  if (keyword) {
    filtered = window.ciAllRows.filter(r => {
      const name = (r.student_name || '').toLowerCase();
      const dorm = (r.dorm || '').toLowerCase();
      const clsName = (r.class_name || '').toLowerCase();
      return name.includes(keyword) || dorm.includes(keyword) || clsName.includes(keyword);
    });
  }
  
  renderCheckin(filtered);
  
  const countEl = document.getElementById('ciCount');
  if (countEl) countEl.textContent = `（共 ${filtered.length} 条）`;
};

window.renderCheckin = function(rows) {
  const el = document.getElementById('ciTable');
  if (!el) return;
  
  if (!rows.length) {
    safeSetInnerHTML(el, '<div class="empty">暂无查寝记录</div>');
    return;
  }
  
  const curPage = window.ciPage || 1;
  const start = (curPage - 1) * 10;
  const pageRows = rows.slice(start, start + 10);
  const totalPages = Math.max(1, Math.ceil(rows.length / 10));
  
  const html = `<table>
    <thead><tr><th>学生</th><th>班级</th><th>宿舍</th><th>状态</th><th>活体</th><th>时间</th><th>位置</th></tr></thead>
    <tbody>${pageRows.map(r => {
      const showTimeAndAddr = r.status === '在寝' || r.status === '晚归';
      const livenessBadge = !showTimeAndAddr
        ? '<span class="tag gray">—</span>'
        : (r.liveness_passed === 1 || r.liveness_passed === '1')
          ? '<span class="tag green">✅真人</span>'
          : (r.photo_path ? '<span class="tag red">⚠️未验证</span>' : '<span class="tag gray">—</span>');
      return `<tr>
        <td>${esc(r.student_name) || '-'}</td>
        <td>${esc(r.class_name) || '-'}</td>
        <td>${esc(r.dorm) || '-'}</td>
        <td>${statusTag(r.status)}</td>
        <td>${livenessBadge}</td>
        <td>${showTimeAndAddr ? fmtBJ(r.time, r.date) : '-'}</td>
        <td>${showTimeAndAddr ? (esc(r.address) || '-') : '-'}</td>
      </tr>`;
    }).join('')}</tbody>
  </table>
  <div style="margin-top:12px;display:flex;justify-content:space-between;align-items:center;font-size:12px;color:#64748b">
    <span>共 <b>${rows.length}</b> 条 · 第 <b>${curPage}</b>/${totalPages} 页 · 每页 10 条</span>
    <div id="ciPager_btns">${pageBtns(totalPages, curPage)}</div>
  </div>`;
  
  safeSetInnerHTML(el, html);
  
  // 绑定分页事件
  const btns = document.getElementById('ciPager_btns');
  if (btns && !btns.dataset.bound) {
    btns.dataset.bound = '1';
    btns.addEventListener('click', (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      const p = parseInt(t.dataset.page);
      if (!isNaN(p)) {
        window.ciPage = p;
        filterCheckin();
      }
    });
  }
};

// ==================== 实时动态项目 ====================
window.addLiveItem = function(r) {
  const feed = document.getElementById('ovFeed');
  if (!feed) return;
  
  let icon = '✅', bg = '#d1fae5', action = '查寝签到';
  if (r.status === '在寝') { icon = '✅'; bg = '#d1fae5'; action = '在寝'; }
  else if (r.status === '未归' || r.status === '不在寝' || r.status === '晚归') { icon = '❌'; bg = '#fee2e2'; action = '未归'; }
  else if (['病假', '事假', '公假', '丧假', '请假'].includes(r.status)) { icon = '📝'; bg = '#fef3c7'; action = '请假'; }
  else if (r.status === '迟到') { icon = '🕐'; bg = '#dbeafe'; action = '迟到'; }
  else if (r.type === 'class') { icon = '📚'; bg = '#dbeafe'; action = '课堂签到 (' + (r.status || '') + ')'; }
  
  const ts = fmtBJ(r.time) || '';
  const addrPart = r.address ? ` · 📍${esc(r.address)}` : '';
  
  const wrapper = document.createElement('div');
  wrapper.className = 'feed-item';
  wrapper.innerHTML = `<div class="fi-left"><div class="feed-ic" style="background:${bg}">${esc(icon)}</div><span class="fi-name">${esc(r.student_name || '未知')}</span></div><div class="fi-center"><span class="fi-action">${esc(action)}</span></div><div class="fi-right"><span class="fi-time">${esc(ts)}</span></div>`;
  
  feed.appendChild(wrapper);
  
  // 超过100条清理
  while (feed.children.length > 100) feed.removeChild(feed.firstChild);
  startFeedAutoPlay();
};

// ==================== 实时动态自动播放 ====================
window.feedAutoPlayTimer = null;
window.feedAutoPlayPaused = false;

window.startFeedAutoPlay = function() {
  const feed = document.getElementById('ovFeed');
  if (!feed) return;
  
  if (window.feedAutoPlayTimer) {
    clearInterval(window.feedAutoPlayTimer);
    window.feedAutoPlayTimer = null;
  }
  
  feed.onmouseenter = () => { window.feedAutoPlayPaused = true; };
  feed.onmouseleave = () => { window.feedAutoPlayPaused = false; };
  
  if (feed.scrollHeight <= feed.clientHeight) return;
  
  const itemHeight = feed.children[0]?.offsetHeight || 46;
  window.feedAutoPlayTimer = setInterval(() => {
    if (window.feedAutoPlayPaused) return;
    const max = feed.scrollHeight - feed.clientHeight;
    if (max <= 0) return;
    
    if (feed.scrollTop + itemHeight >= max - 2) {
      feed.style.scrollBehavior = 'auto';
      feed.scrollTop = 0;
      void feed.offsetHeight;
      feed.style.scrollBehavior = '';
    } else {
      feed.scrollBy({ top: itemHeight, behavior: 'smooth' });
    }
  }, 1000);
};
