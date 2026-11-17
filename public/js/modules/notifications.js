/**
 * 通知推送模块
 * 封装 toast、loading、error boundary 等通用 UI 能力
 */

// ==================== Toast 提示 ====================
window.showToast = function(message, type = 'info', duration = 3000) {
  const colors = {
    success: '#10b981',
    error: '#ef4444',
    warning: '#f59e0b',
    info: '#3b82f6'
  };
  
  const toast = document.createElement('div');
  toast.style.cssText = `
    position: fixed;
    top: 20px;
    left: 50%;
    transform: translateX(-50%);
    padding: 12px 24px;
    border-radius: 8px;
    color: #fff;
    font-size: 14px;
    z-index: 9999;
    background: ${colors[type] || colors.info};
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    animation: slideDown 0.3s ease;
    max-width: 90%;
    word-break: break-all;
  `;
  toast.textContent = message;
  document.body.appendChild(toast);
  
  setTimeout(() => {
    toast.style.animation = 'slideUp 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, duration);
};

// ==================== Loading 状态 ====================
window.showLoading = function(el, show) {
  if (!el) return;
  if (show) {
    el.dataset.originalContent = el.innerHTML;
    el.innerHTML = '<div style="text-align:center;padding:20px;color:#94a3b8">加载中...</div>';
  } else {
    if (el.dataset.originalContent !== undefined) {
      el.innerHTML = el.dataset.originalContent;
      delete el.dataset.originalContent;
    }
  }
};

// ==================== Error Boundary ====================
// 从 unhandledrejection 的 e.reason 提取人类可读原因（Error 对象 / 字符串 / 其它 reject 值）
window.extractRejectionReason = function(reason) {
  try {
    if (!reason) return '未知原因';
    if (reason instanceof Error) return reason.name + ': ' + reason.message;
    if (typeof reason === 'string') return reason.slice(0, 120);
    if (typeof reason === 'object') {
      // 常见 reject 值：带 message 的对象 / axios error(有 status/response)
      if (reason.message) return String(reason.message).slice(0, 120);
      if (reason.code) return 'code=' + reason.code;
      if (reason.status) return 'HTTP ' + reason.status;
      try { return JSON.stringify(reason).slice(0, 120); } catch (_) { return '未知原因'; }
    }
    return String(reason).slice(0, 120);
  } catch (_) {
    return '未知原因';
  }
};
window.addErrorBoundary = function() {
  window.addEventListener('error', (e) => {
    console.error('[JS Error]', e.message, e.filename, e.lineno);
    showToast('页面运行异常：' + (e.message || '未知错误') + '，请刷新重试', 'error', 6000);
  });

  window.addEventListener('unhandledrejection', (e) => {
    console.error('[Unhandled Rejection]', e.reason);
    const reason = window.extractRejectionReason(e.reason);
    showToast('操作失败：' + reason + '，请重试', 'error', 6000);
  });
};

// ==================== 刷新按钮增强 ====================
window.refreshBtn = async function(el, fnName) {
  const fn = typeof fnName === 'function' ? fnName : (window[fnName] || function(){});
  if (!fn || typeof fn !== 'function') return;
  if (el) {
    el.classList.add('spin');
    el.disabled = true;
  }
  try {
    await fn();
    showToast('刷新成功', 'success');
  } catch (e) {
    console.error('refresh error', e);
    showToast('刷新失败: ' + (e.message || '未知错误'), 'error');
  } finally {
    if (el) {
      setTimeout(() => {
        el.classList.remove('spin');
        el.disabled = false;
      }, 400);
    }
  }
};

// ==================== 数字动画 ====================
window.animateNum = function(id, target) {
  const el = document.getElementById(id);
  if (!el) return;
  const start = parseInt(el.textContent) || 0;
  if (start === target) return;
  const diff = target - start;
  const dur = 800;
  const t0 = performance.now();
  
  function upd(now) {
    const p = Math.min((now - t0) / dur, 1);
    const e = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.floor(start + diff * e);
    if (p < 1) requestAnimationFrame(upd);
  }
  requestAnimationFrame(upd);
};

// ==================== 表单验证 ====================
window.validateRequired = function(fields) {
  for (const { id, name } of fields) {
    const el = document.getElementById(id);
    if (!el || !el.value.trim()) {
      showToast(`${name} 不能为空`, 'warning');
      el?.focus();
      return false;
    }
  }
  return true;
};

// ==================== CSRF Token 管理 ====================
window.csrfToken = '';

window.refreshCsrfToken = async function() {
  if (!window.authToken) return;
  try {
    const r = await fetch('/api/csrf-token', { 
      headers: { 'x-auth-token': window.authToken } 
    });
    const j = await r.json();
    if (j.code === 0) window.csrfToken = j.data.token;
  } catch (e) {
    console.warn('获取 CSRF token 失败:', e);
  }
};

// 页面加载时自动获取
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', window.refreshCsrfToken);
} else {
  window.refreshCsrfToken();
}

// 注册全局错误边界
window.addErrorBoundary();
