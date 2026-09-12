/**
 * SmartEdu 前端基础工具模块
 * 所有 HTML 页面共享的工具函数
 */

// ==================== HTML 转义工具（防 XSS）====================
window.esc = function(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
};

// ==================== 北京时间工具 ====================
window.pad2 = function(n) {
  return String(n).padStart(2, '0');
};

window.beijingNow = function() {
  const utc = Date.now() + new Date().getTimezoneOffset() * 60000;
  return new Date(utc + 8 * 3600 * 1000);
};

window.fmtCN = function(d) {
  if (!d) return '-';
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d)) {
    const parts = d.split(/[- :]/);
    return `${parseInt(parts[0])}年${parseInt(parts[1])}月${parseInt(parts[2])}日`;
  }
  if (typeof d === 'string') d = new Date(d);
  if (isNaN(d?.getTime())) return String(d);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${window.pad2(d.getHours())}:${window.pad2(d.getMinutes())}:${window.pad2(d.getSeconds())}`;
};

window.todayStr = function() {
  const b = window.beijingNow();
  return `${b.getFullYear()}-${window.pad2(b.getMonth() + 1)}-${window.pad2(b.getDate())}`;
};

// ==================== 认证基础函数（供 auth.js 等模块调用）====================
// 注意：登录/登出逻辑在 auth.js，此处仅提供 token 存取和 API 请求封装
window.authToken = window.authToken || '';
window.currentUser = window.currentUser || {};
window.getToken = function() { return localStorage.getItem('admin_token') || ''; };
window.setToken = function(t) { localStorage.setItem('admin_token', t); window.authToken = t; };
const SEC = 'x-auth-token';
window.logoutToLogin = function() {
  try { localStorage.removeItem('admin_token'); } catch (e) {}
  window.authToken = '';
  const lw = document.getElementById('loginWrap'); if (lw) lw.style.display = 'flex';
  const app = document.getElementById('app'); if (app) app.style.display = 'none';
  const err = document.getElementById('loginErr'); if (err) err.textContent = '登录已过期，请重新登录';
};
window.api = async function(url, opts = {}) {
  opts.headers = Object.assign({}, opts.headers, { [SEC]: window.authToken });
  const r = await fetch(url, opts);
  return r.json();
};
window.apiAuth = async function(url, opts = {}) {
  opts.headers = Object.assign({}, opts.headers, { [SEC]: window.authToken, 'Content-Type': 'application/json' });
  if (opts.body && typeof opts.body === 'object') opts.body = JSON.stringify(opts.body);
  try {
    const r = await fetch(url, opts);
    const text = await r.text();
    try {
      const j = JSON.parse(text);
      if (j.code === 1 && (j.message || '').includes('登录')) { window.logoutToLogin(); }
      return j;
    } catch (e) {
      console.error('API返回非JSON:', text.slice(0, 200));
      return { code: 1, message: '服务器返回错误: ' + (r.status || '未知') };
    }
  } catch (e) {
    console.error('API请求失败:', e);
    return { code: 1, message: '网络错误: ' + e.message };
  }
};

// ==================== Toast 提示 ====================
window.toast = function(msg, type = 'info') {
  const toast = document.createElement('div');
  toast.style.cssText = `
    position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
    padding: 12px 24px; border-radius: 8px; color: #fff; font-size: 14px;
    z-index: 9999; animation: fadeIn 0.3s;
    background: ${type === 'success' ? '#10b981' : type === 'error' ? '#ef4444' : '#3b82f6'};
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
  `;
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
};

// ==================== 加载状态 ====================
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

// ==================== CSRF Token 管理 ====================
window.csrfToken = '';

window.refreshCsrfToken = async function() {
  try {
    const r = await fetch('/api/csrf-token', { headers: { 'x-auth-token': window.authToken } });
    const j = await r.json();
    if (j.code === 0) window.csrfToken = j.data.token;
  } catch (e) {
    console.warn('获取 CSRF token 失败:', e);
  }
};

// 页面加载时获取 CSRF token
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', window.refreshCsrfToken);
} else {
  window.refreshCsrfToken();
}
