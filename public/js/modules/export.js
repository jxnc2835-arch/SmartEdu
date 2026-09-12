/**
 * 导出功能模块
 * 封装记录导出、报告PDF、请假导出功能
 */

// 通用的认证下载工具函数
window._authDownload = async function(url, filename, contentType) {
  const token = window.authToken || localStorage.getItem('admin_token') || '';
  if (!token) {
    window.showToast('请先登录后再导出', 'warning');
    return false;
  }
  
  try {
    const resp = await fetch(url, { headers: { 'x-auth-token': token } });
    
    if (!resp.ok) {
      if (resp.status === 401) {
        window.showToast('登录已过期，请重新登录', 'error');
        window.doLogout();
      } else {
        let msg = 'HTTP ' + resp.status;
        if (resp.headers.get('content-type')?.includes('application/json')) {
          try { msg = (await resp.json()).message || msg; } catch (e) {}
        }
        window.showToast('导出失败：' + msg, 'error');
      }
      return false;
    }
    
    const blob = await resp.blob();
    const fileUrl = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = fileUrl;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(fileUrl);
    
    return true;
  } catch (err) {
    window.showToast('导出失败：' + err.message, 'error');
    return false;
  }
};

// ==================== 导出查寝记录 ====================
window.exportRecords = async function() {
  const cls = document.getElementById('ovClassFilter')?.value;
  const st = document.getElementById('ciStatusFilter')?.value;
  const from = document.getElementById('ciFrom')?.value;
  const to = document.getElementById('ciTo')?.value;
  
  const params = [];
  if (cls) params.push('class_name=' + encodeURIComponent(cls));
  if (st) params.push('status=' + encodeURIComponent(st));
  if (from) params.push('from=' + from);
  if (to) params.push('to=' + to);
  const paramStr = params.length ? '?' + params.join('&') : '';
  
  await window._authDownload('/api/export/records' + paramStr, '查寝记录.xlsx');
};

// ==================== 导出查寝报告 PDF ====================
window.exportReport = async function() {
  const type = document.getElementById('reportType')?.value || 'month';
  const label = { day: '日报', week: '周报', month: '月报' }[type] || '报告';
  
  await window._authDownload('/api/export/report?type=' + encodeURIComponent(type), `查寝${label}.pdf`);
};

// ==================== 导出请假记录 ====================
window.exportLeaves = async function() {
  const cls = document.getElementById('lvClassFilter')?.value;
  const st = document.getElementById('lvStatusFilter')?.value;
  const from = document.getElementById('lvFrom')?.value;
  const to = document.getElementById('lvTo')?.value;
  
  const params = [];
  if (cls) params.push('class_name=' + encodeURIComponent(cls));
  if (st) params.push('status=' + encodeURIComponent(st));
  if (from) params.push('from=' + from);
  if (to) params.push('to=' + to);
  const paramStr = params.length ? '?' + params.join('&') : '';
  
  await window._authDownload('/api/export/leaves' + paramStr, '请假记录.xlsx');
};

// ==================== 导出学生数据 ====================
window.exportStudents = async function() {
  const cls = document.getElementById('stuClassFilter')?.value;
  const paramStr = cls ? '?class_name=' + encodeURIComponent(cls) : '';
  
  await window._authDownload('/api/export/students' + paramStr, '学生列表.xlsx');
};
