/**
 * 认证模块
 * 封装登录、登出、API 请求等认证相关功能
 */

// ==================== 认证状态 ====================
window.authToken = window.authToken || '';
window.currentUser = window.currentUser || {};

// ==================== Token 管理 ====================
window.getToken = function() {
  return localStorage.getItem('admin_token') || '';
};

window.setToken = function(t) {
  localStorage.setItem('admin_token', t);
  window.authToken = t;
};

const SEC = 'x-auth-token';

// ==================== API 请求封装 ====================
window.api = async function(url, opts = {}) {
  opts.headers = Object.assign({}, opts.headers, { [SEC]: window.authToken });
  const r = await fetch(url, opts);
  return r.json();
};

// token 失效时清除 token 并回到登录框
window.logoutToLogin = function() {
  try { localStorage.removeItem('admin_token'); } catch (e) {}
  window.authToken = '';
  const lw = document.getElementById('loginWrap');
  if (lw) lw.style.display = 'flex';
  const app = document.getElementById('app');
  if (app) app.style.display = 'none';
  const err = document.getElementById('loginErr');
  if (err) err.textContent = '登录已过期，请重新登录';
};

window.apiAuth = async function(url, opts = {}) {
  opts.headers = Object.assign({}, opts.headers, {
    [SEC]: window.authToken,
    'Content-Type': 'application/json'
  });
  if (opts.body && typeof opts.body === 'object') opts.body = JSON.stringify(opts.body);
  try {
    const r = await fetch(url, opts);
    const text = await r.text();
    try {
      const j = JSON.parse(text);
      if (j.code === 1 && (j.message || '').includes('登录')) {
        window.logoutToLogin();
      }
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

// ==================== 登录 ====================
window.doLogin = async function() {
  const u = document.getElementById('loginUser')?.value?.trim() || '';
  const p = document.getElementById('loginPwd')?.value || '';
  document.getElementById('loginErr').textContent = '';
  
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: p })
    });
    const j = await r.json();
    if (j.code === 0) {
      window.setToken(j.token);
      window.currentUser = j.data || {};
      document.getElementById('loginWrap').style.display = 'none';
      document.getElementById('app').style.display = 'flex';
      document.getElementById('userName').textContent = window.currentUser.display_name || '管理员';
      document.getElementById('userAvatar').textContent = (window.currentUser.display_name || 'A').slice(0, 1);
      window.initApp();
    } else {
      document.getElementById('loginErr').textContent = j.message || '登录失败';
    }
  } catch (e) {
    document.getElementById('loginErr').textContent = '网络错误：' + e.message;
  }
};

window.doLogout = function() {
  localStorage.removeItem('admin_token');
  location.reload();
};

// ==================== 静态资源缓存版本 ====================
window.APP_VERSION = 'v3.6.2';
