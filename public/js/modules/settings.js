/**
 * 系统设置模块
 * 封装备份、日志、Webhook、公告等功能
 */

// ==================== 备份管理 ====================
window.doBackup = async function() {
  const cls = await window.showBackupDialog('💾 数据备份', '选择班级进行备份，留空则备份全部数据', false);
  if (cls === null) return;
  const r = await apiAuth('/api/backup?class_name=' + encodeURIComponent(cls));
  if (r.code === 0) {
    window.showToast('备份成功', 'success');
    window.loadBackups();
  } else {
    window.showToast(r.message || '备份失败', 'error');
  }
};

window.showBackupDialog = function(title, desc, isClear = false) {
  return new Promise((resolve) => {
    (async () => {
    let classes = [];
    try {
      const r = await apiAuth('/api/classes/public');
      classes = r.data || [];
    } catch (e) {}

    const mask = document.createElement('div');
    mask.className = 'modal-mask show';
    mask.style.zIndex = '9999';
    mask.innerHTML = `
      <div class="modal" style="max-width:420px;width:90%;padding:0;border-radius:14px;overflow:hidden" onclick="event.stopPropagation()">
        <div style="padding:18px 22px;border-bottom:1px solid #f1f5f9">
          <h3 style="margin:0;font-size:16px;font-weight:700;color:#1e293b">${title}</h3>
        </div>
        <div style="padding:18px 22px">
          <p style="margin:0 0 14px;font-size:13px;color:#64748b">${desc}</p>
          <label style="display:block;font-size:13px;color:#475569;margin-bottom:6px;font-weight:600">选择班级</label>
          <select id="dlgClassSel" style="width:100%;padding:10px 12px;border:1px solid #e2e8f0;border-radius:8px;font-size:14px">
            <option value="">全部班级</option>
            ${classes.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}
          </select>
        </div>
        <div style="padding:14px 22px;display:flex;gap:10px;justify-content:flex-end">
          <button class="btn btn-o btn-sm" id="dlgCancel">取消</button>
          <button class="btn btn-p btn-sm" id="dlgOk">确认</button>
        </div>
      </div>
    `;
    document.body.appendChild(mask);
    document.getElementById('dlgCancel').onclick = () => { mask.remove(); resolve(null); };
    document.getElementById('dlgOk').onclick = () => {
      const v = document.getElementById('dlgClassSel').value;
      mask.remove();
      resolve(v);
    };
    mask.onclick = () => { mask.remove(); resolve(null); };
    })();
  });
};

window.clearAllData = async function() {
  const cls = await window.showBackupDialog('🗑️ 清除数据', '此操作不可恢复！选择班级进行清除，留空则清除全部数据', true);
  if (cls === null) return;
  if (!confirm(`⚠️ 真的要清除【${cls || '全部'}】数据吗？\n此操作不可恢复！`)) return;
  const r = await apiAuth('/api/clear-data?class_name=' + encodeURIComponent(cls), { method: 'POST' });
  if (r.code === 0) {
    window.showToast('清除成功', 'success');
  } else {
    window.showToast(r.message || '清除失败', 'error');
  }
};

window.loadBackups = async function() {
  const j = await apiAuth('/api/backups');
  const el = document.getElementById('backupList');
  if (!el) return;
  
  const rows = (j.data || []).filter(r => !(r.filename || r.name || '').startsWith('.deleted_'));
  
  if (!rows.length) {
    safeSetInnerHTML(el, '<div class="empty">暂无备份</div>');
    return;
  }

  const html = `<div style="margin-bottom:10px">
    <select id="backupClassFilter" onchange="window.filterBackups()" style="padding:6px 10px;border-radius:6px;border:1px solid #e2e8f0">
      <option value="">全部班级</option>
    </select>
  </div>
  <table>
    <thead><tr><th style="width:30px"><input type="checkbox" id="backupSelectAll" /></th><th>名称</th><th>类型</th><th>班级</th><th>时间</th><th>大小</th><th>操作</th></tr></thead>
    <tbody>${rows.map(r => {
      const size = r.size || (r.students ? Math.round(JSON.stringify(r).length / 1024) : 0);
      const sizeStr = size > 1024 ? (size / 1024).toFixed(1) + 'MB' : size + 'KB';
      const fn = esc(r.filename || r.name || '-');
      return `<tr>
        <td><input type="checkbox" class="backup-cb" value="${fn}" /></td>
        <td>${fn}</td>
        <td><span style="color:#3b82f6">●</span> 全量</td>
        <td>${esc(r.class_name) || '全部'}</td>
        <td style="font-size:11px;white-space:nowrap">${fmtBJ(r.created_at)}</td>
        <td>${sizeStr}</td>
        <td style="white-space:nowrap">
          <button class="btn btn-sm btn-o" onclick="window.restoreBackup('${fn.replace(/'/g, "\\'")}')">🔄 恢复</button>
          <button class="btn btn-sm btn-d" onclick="window.deleteBackup('${fn.replace(/'/g, "\\'")}')">🗑️ 删除</button>
        </td>
      </tr>`;
    }).join('')}</tbody>
  </table>`;
  safeSetInnerHTML(el, html);

  // 全选
  const sa = document.getElementById('backupSelectAll');
  if (sa) {
    sa.onclick = () => {
      document.querySelectorAll('.backup-cb').forEach(cb => cb.checked = sa.checked);
    };
  }
};

window.deleteBackup = async function(name) {
  if (!confirm('确认删除该备份？')) return;
  const r = await apiAuth('/api/delete-backup', { method: 'POST', body: JSON.stringify({ name }) });
  if (r.code === 0) {
    window.showToast('删除成功', 'success');
    window.loadBackups();
  } else {
    window.showToast(r.message || '删除失败', 'error');
  }
};

window.restoreBackup = async function(name) {
  if (!confirm('确认恢复该备份？当前数据将被覆盖')) return;
  const r = await apiAuth('/api/restore', { method: 'POST', body: JSON.stringify({ name }) });
  if (r.code === 0) {
    window.showToast('恢复成功', 'success');
  } else {
    window.showToast(r.message || '恢复失败', 'error');
  }
};

// ==================== 日志管理 ====================
window.loadLogs = async function() {
  const el = document.getElementById('logList');
  if (!el) return;
  
  safeSetInnerHTML(el, '<div class="empty">加载中...</div>');
  
  try {
    const level = document.getElementById('logLevel')?.value || '';
    const action = document.getElementById('logAction')?.value || '';
    const detail = document.getElementById('logDetail')?.value || '';
    
    let url = '/api/logs?limit=200';
    if (level) url += '&level=' + encodeURIComponent(level);
    if (action) url += '&action=' + encodeURIComponent(action);
    if (detail) url += '&detail=' + encodeURIComponent(detail);
    
    const rj = await apiAuth(url);
    const rows = rj.data || [];
    
    if (!rows.length) {
      safeSetInnerHTML(el, '<div class="empty">暂无日志</div>');
      return;
    }
    
    const html = `<table>
      <thead><tr><th>级别</th><th>时间</th><th>操作人</th><th>操作</th><th>详情</th><th>操作</th></tr></thead>
      <tbody>${rows.slice(0, 50).map(l => {
        const level = l.level || 'info';
        const levelTag = level === 'error' 
          ? '<span style="display:inline-block;width:18px;height:18px;background:#fee2e2;color:#dc2626;border-radius:4px;text-align:center;line-height:18px">!</span>'
          : level === 'warn'
            ? '<span style="display:inline-block;width:18px;height:18px;background:#fef3c7;color:#f59e0b;border-radius:4px;text-align:center;line-height:18px">!</span>'
            : '<span style="display:inline-block;width:18px;height:18px;background:#dbeafe;color:#3b82f6;border-radius:4px;text-align:center;line-height:18px">i</span>';
        return `<tr>
          <td>${levelTag}</td>
          <td style="font-size:11px;white-space:nowrap">${fmtBJ(l.time || l.created_at)}</td>
          <td>${esc(l.user) || '系统'}</td>
          <td>${esc(l.action) || '-'}</td>
          <td style="font-size:12px">${esc(l.detail || l.message || '')}</td>
          <td><button class="btn btn-sm btn-d" onclick="window.deleteLog('${esc(l.id)}')">🗑️</button></td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
    safeSetInnerHTML(el, html);
  } catch (e) {
    safeSetInnerHTML(el, '<div class="empty">加载失败</div>');
  }
};

window.deleteLog = async function(id) {
  if (!confirm('确认删除该日志？')) return;
  const r = await apiAuth('/api/logs/' + id, { method: 'DELETE' });
  if (r.code === 0) {
    window.loadLogs();
  } else {
    window.showToast(r.message || '删除失败', 'error');
  }
};

window.clearLogs = async function() {
  if (!confirm('确认清空所有日志？')) return;
  const r = await apiAuth('/api/logs', { method: 'DELETE' });
  if (r.code === 0) {
    window.showToast('清空成功', 'success');
    window.loadLogs();
  } else {
    window.showToast(r.message || '清空失败', 'error');
  }
};

// ==================== Webhook 管理 ====================
window.loadWebhookConfig = async function() {
  try {
    const el = document.getElementById('webhookEnabled');
    if (!el) return;
    const j = await apiAuth('/api/settings/webhook');
    if (j.code === 0 && j.data) {
      const d = j.data;
      el.checked = !!d.enabled;
      document.getElementById('webhookType').value = d.type || 'wechat';
      document.getElementById('webhookUrl').value = d.url || '';
    }
  } catch (e) {
    console.error('loadWebhookConfig', e);
  }
};

window.saveWebhook = async function() {
  const data = {
    enabled: document.getElementById('webhookEnabled').checked,
    type: document.getElementById('webhookType').value,
    url: document.getElementById('webhookUrl').value.trim()
  };
  if (data.enabled && !data.url) {
    window.showToast('请填写 Webhook 地址', 'warning');
    return;
  }
  const r = await apiAuth('/api/settings/webhook', { method: 'POST', body: data });
  if (r.code === 0) {
    window.showToast('保存成功', 'success');
    window.loadWebhookHistory();
  } else {
    window.showToast(r.message || '保存失败', 'error');
  }
};

window.testWebhook = async function() {
  const data = {
    type: document.getElementById('webhookType').value,
    url: document.getElementById('webhookUrl').value.trim()
  };
  if (!data.url) {
    window.showToast('请填写 Webhook 地址', 'warning');
    return;
  }
  const r = await apiAuth('/api/settings/webhook/test', { method: 'POST', body: data });
  if (r.code === 0) {
    window.showToast('测试消息已发送', 'success');
  } else {
    window.showToast(r.message || '发送失败', 'error');
  }
};

window.loadWebhookHistory = async function() {
  const el = document.getElementById('webhookHistoryList');
  if (!el) return;
  
  safeSetInnerHTML(el, '<div class="empty">暂无记录</div>');
  
  try {
    const j = await apiAuth('/api/settings/webhook/history');
    const rows = j.data || [];
    
    if (!rows.length) {
      safeSetInnerHTML(el, '<div class="empty">暂无记录</div>');
      return;
    }
    
    const html = `<table>
      <thead><tr><th>时间</th><th>类型</th><th>状态</th><th>内容</th></tr></thead>
      <tbody>${rows.slice(0, 20).map(r => `
        <tr>
          <td>${fmtBJ(r.created_at)}</td>
          <td>${esc(r.type) || '-'}</td>
          <td>${r.success 
            ? '<span style="color:#10b981">✅ 成功</span>' 
            : '<span style="color:#ef4444">❌ 失败</span>'}</td>
          <td>${esc((r.message || '').slice(0, 50))}</td>
        </tr>
      `.trim()).join('')}</tbody>
    </table>`;
    safeSetInnerHTML(el, html);
  } catch (e) {
    safeSetInnerHTML(el, '<div class="empty">加载失败</div>');
  }
};

// ==================== 公告管理 ====================
window.publishAnnouncement = async function() {
  const title = document.getElementById('announceTitle')?.value?.trim();
  const content = document.getElementById('announceContent')?.value?.trim();
  
  if (!title || !content) {
    window.showToast('请填写标题和内容', 'warning');
    return;
  }
  
  const r = await apiAuth('/api/announcements', { method: 'POST', body: { title, content } });
  if (r.code === 0) {
    window.showToast('公告已发布', 'success');
    document.getElementById('announceTitle').value = '';
    document.getElementById('announceContent').value = '';
  } else {
    window.showToast(r.message || '发布失败', 'error');
  }
};

// ==================== 预警规则 ====================
window.loadAlertRules = async function() {
  try {
    const j = await apiAuth('/api/settings/alert-rules');
    if (j.code === 0 && j.data) {
      const d = j.data;
      const enabled = document.getElementById('alertEnabled');
      const absentDays = document.getElementById('alertAbsentDays');
      const dormCount = document.getElementById('alertDormCount');
      const consecutive = document.getElementById('alertConsecutive');
      
      if (enabled) enabled.checked = !!d.enabled;
      if (absentDays) absentDays.value = d.absent_days || 3;
      if (dormCount) dormCount.value = d.dorm_count || 2;
      if (consecutive) consecutive.value = d.consecutive_days || 3;
    }
  } catch (e) {
    console.error('loadAlertRules', e);
  }
};

window.saveAlertRules = async function() {
  const data = {
    enabled: document.getElementById('alertEnabled')?.checked,
    absent_days: parseInt(document.getElementById('alertAbsentDays')?.value) || 3,
    dorm_count: parseInt(document.getElementById('alertDormCount')?.value) || 2,
    consecutive_days: parseInt(document.getElementById('alertConsecutive')?.value) || 3
  };
  const r = await apiAuth('/api/settings/alert-rules', { method: 'POST', body: data });
  if (r.code === 0) {
    window.showToast('保存成功', 'success');
  } else {
    window.showToast(r.message || '保存失败', 'error');
  }
};

// ==================== 语音签到 ====================
window.loadVoiceRecords = async function() {
  const table = document.getElementById('voiceRecordsTable');
  if (!table) return;
  
  safeSetInnerHTML(table, '<div class="empty">加载中…</div>');
  
  const j = await apiAuth('/api/records?type=voice&_t=' + Date.now());
  if (j.code !== 0) {
    safeSetInnerHTML(table, '<div class="empty">⚠️ 加载失败：' + esc(j.message || '未知错误') + '</div>');
    return;
  }
  
  if (!j.data || !j.data.length) {
    safeSetInnerHTML(table, '<div class="empty">暂无语音签到记录</div>');
    return;
  }
  
  const html = `<table style="width:100%;font-size:13px">
    <thead><tr><th>学号</th><th>转写文本</th><th>日期</th><th>时间</th><th>状态</th></tr></thead>
    <tbody>${j.data.slice(0, 20).map(r => `
      <tr>
        <td>${esc(r.student_id)}</td>
        <td>${esc(r.note) || '-'}</td>
        <td>${esc(r.date)}</td>
        <td>${esc(r.time)}</td>
        <td><span class="tag tag-green">${esc(r.status)}</span></td>
      </tr>
    `.trim()).join('')}</tbody>
  </table>`;
  safeSetInnerHTML(table, html);
};

// ==================== GPS 围栏 ====================
window.loadGeofenceRules = async function() {
  const table = document.getElementById('geofenceRulesTable');
  if (!table) return;
  
  safeSetInnerHTML(table, '<div class="empty">加载中…</div>');
  
  const j = await apiAuth('/api/geofence/rules?_t=' + Date.now());
  if (j.code !== 0) {
    safeSetInnerHTML(table, '<div class="empty">⚠️ 加载失败：' + esc(j.message || '未知错误') + '</div>');
    return;
  }
  
  if (!j.data || !j.data.length) {
    safeSetInnerHTML(table, '<div class="empty">暂无围栏规则，请添加</div>');
    return;
  }
  
  const typeMap = { teaching: '教学区', gate: '校门', dorm: '宿舍', classroom: '教学楼', campus: '校园' };
  
  const html = `<table style="width:100%;font-size:13px">
    <thead><tr><th>名称</th><th>类型</th><th>纬度</th><th>经度</th><th>半径(m)</th><th>操作</th></tr></thead>
    <tbody>${j.data.map(r => {
      const label = typeMap[r.type] || r.type || '宿舍';
      return `<tr>
        <td>${esc(r.name)}</td>
        <td>${esc(label)}</td>
        <td>${r.latitude}</td>
        <td>${r.longitude}</td>
        <td>${r.radius_meters}</td>
        <td><button class="btn btn-o btn-sm" onclick="window.deleteGeofenceRule(${r.id})">删除</button></td>
      </tr>`;
    }).join('')}</tbody>
  </table>`;
  safeSetInnerHTML(table, html);
};

window.addGeofenceRule = async function() {
  const name = document.getElementById('gfName')?.value?.trim();
  const lat = parseFloat(document.getElementById('gfLat')?.value);
  const lon = parseFloat(document.getElementById('gfLon')?.value);
  const radius = parseFloat(document.getElementById('gfRadius')?.value) || 200;
  const type = document.getElementById('gfType')?.value;

  if (!name || isNaN(lat) || isNaN(lon)) {
    window.showToast('⚠️ 请填写完整信息：围栏名称、纬度、经度为必填项', 'warning');
    return;
  }

  try {
    const j = await apiAuth('/api/geofence/rules', {
      method: 'POST',
      body: JSON.stringify({ name, latitude: lat, longitude: lon, radius_meters: radius, type })
    });
    if (j.code === 0) {
      window.showToast('✅ 围栏规则已添加', 'success');
      document.getElementById('gfName').value = '';
      document.getElementById('gfLat').value = '';
      document.getElementById('gfLon').value = '';
      document.getElementById('gfRadius').value = '200';
      document.getElementById('gfType').value = 'dorm';
    } else {
      window.showToast('⚠️ ' + (j.message || '添加失败'), 'error');
    }
  } catch (e) {
    console.error('[addGeofenceRule] 异常:', e);
    window.showToast('⚠️ 添加请求异常: ' + e.message, 'error');
  }
  
  await window._refreshGeofenceList();
};

window.deleteGeofenceRule = async function(id) {
  if (!confirm('确定要删除此围栏规则吗？')) return;
  try {
    const j = await apiAuth(`/api/geofence/rules/${id}`, { method: 'DELETE' });
    if (j.code === 0) {
      window.showToast('✅ 已删除', 'success');
    } else {
      window.showToast('⚠️ ' + (j.message || '删除失败'), 'error');
    }
  } catch (e) {
    console.error('[deleteGeofenceRule] 异常:', e);
    window.showToast('⚠️ 删除请求异常: ' + e.message, 'error');
  }
  await window._refreshGeofenceList();
};

window._refreshGeofenceList = async function(retryCount = 0) {
  await new Promise(r => setTimeout(r, 150));
  try {
    await window.loadGeofenceRules();
  } catch (e) {
    if (retryCount < 1) {
      await new Promise(r => setTimeout(r, 1000));
      await window._refreshGeofenceList(retryCount + 1);
    }
  }
};
