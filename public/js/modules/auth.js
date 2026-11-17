/**
 * 认证模块
 * 封装登录、登出等认证逻辑
 * 注：getToken/setToken/api/apiAuth/logoutToLogin 等基础函数由 base.js 提供
 */

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
      // 标记本标签页会话为已登录，允许刷新、从数据大屏返回时恢复会话
      try { window.sessionStorage.setItem('teacher_session_active', '1'); } catch (e) {}
      document.getElementById('loginWrap').style.display = 'none';
      document.getElementById('app').style.display = 'flex';
      // 按真实身份显示：优先 display_name，否则用角色标识；非管理员绝不回退为"管理员"
      const _name = window.currentUser.display_name || window.currentUser.role || '用户';
      document.getElementById('userName').textContent = _name;
      document.getElementById('userAvatar').textContent = (_name || 'U').slice(0, 1);
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
  try { window.sessionStorage.removeItem('teacher_session_active'); } catch (e) {}
  location.reload();
};

// ==================== 静态资源缓存版本 ====================
window.APP_VERSION = 'v3.8.0';
