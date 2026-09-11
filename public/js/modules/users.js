/**
 * 用户管理模块
 * 封装用户CRUD、密码重置等功能
 */

// ==================== 用户列表 ====================
window._usersCache = [];

window.loadUsers = async function() {
  const el = document.getElementById('userTable');
  if (!el) return;
  
  try {
    const j = await apiAuth('/api/users');
    if (j.code !== 0) {
      safeSetInnerHTML(el, '<div class="empty">仅超级管理员可访问</div>');
      return;
    }
    window._usersCache = j.data || [];
    window.renderUsers();
  } catch (e) {
    safeSetInnerHTML(el, '<div class="empty">加载失败：' + esc(e.message) + '</div>');
  }
};

window.renderUsers = function() {
  const el = document.getElementById('userTable');
  if (!el) return;
  
  const kw = (document.getElementById('userSearchInput')?.value || '').toLowerCase();
  let rows = window._usersCache || [];
  
  if (kw) {
    rows = rows.filter(u => 
      (u.username || '').toLowerCase().includes(kw) ||
      (u.display_name || '').toLowerCase().includes(kw) ||
      (u.role || '').toLowerCase().includes(kw)
    );
  }
  
  if (!rows.length) {
    safeSetInnerHTML(el, '<div class="empty">暂无用户</div>');
    return;
  }
  
  window.renderPagedTable(rows, 1, 10, (slice) => {
    return `<table>
      <thead><tr><th>用户名</th><th>姓名</th><th>角色</th><th>创建时间</th><th>最后登录</th><th>操作</th></tr></thead>
      <tbody>${slice.map(u => {
        const roleColor = { super_admin: '#7c3aed', admin: '#7c3aed', counselor: '#2563eb', dean: '#0891b2', teacher: '#475569' }[u.role] || '#64748b';
        const roleName = { super_admin: '超级管理员', admin: '超级管理员', counselor: '辅导员', dean: '院系主任', teacher: '教师' }[u.role] || u.role;
        const displayName = u.display_name || '-';
        return `<tr data-uid="${esc(u.id)}" data-uname="${esc(u.username || u.id)}">
          <td><b>${esc(u.username || '-')}</b></td>
          <td>${esc(displayName)}</td>
          <td><span style="background:${roleColor}20;color:${roleColor};padding:2px 8px;border-radius:4px;font-size:12px">${esc(roleName)}</span></td>
          <td style="font-size:11px;color:#64748b">${esc(u.created_at || '-')}</td>
          <td style="font-size:11px;color:#64748b">${esc(u.last_login || '从未')}</td>
          <td style="white-space:nowrap">
            ${!(u.role === 'admin' || u.role === 'super_admin') 
              ? `<button class="btn btn-sm btn-o" onclick="window.editUserDialog('${esc(u.id)}')">编辑</button>` 
              : ''}
            <button class="btn btn-sm btn-w" onclick="window.resetUserPwd(this)">重置密码</button>
            ${u.username !== 'admin' 
              ? `<button class="btn btn-sm btn-d" onclick="window.deleteUser(this)">删除</button>` 
              : ''}
          </td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
  }, 'userPag', 'userTable');
};

window.showAddUserDialog = function() {
  window.showUserFormDialog({});
};

window.editUserDialog = function(id) {
  const u = (window._usersCache || []).find(x => x.id === id);
  if (u) window.showUserFormDialog(u);
};

// ==================== 用户表单弹窗 ====================
window.showUserFormDialog = function(u) {
  const isEdit = !!u.id;
  const userClass = u.class_name || (u.allowed_classes && u.allowed_classes.join(',')) || '';
  
  const html = `<div class="modal-mask show" style="z-index:9999" onclick="if(event.target===this)this.remove()">
    <div class="modal" style="max-width:460px;width:92%;background:#fff;box-shadow:0 20px 60px rgba(0,0,0,.15)" onclick="event.stopPropagation()">
      <h3 style="margin:0 0 16px;font-size:18px;font-weight:700;color:#1e293b">${isEdit ? '编辑' : '添加'}用户</h3>
      <div class="form-row">
        <label style="color:#475569;font-size:13px">账号 <span style="color:#ef4444">*</span></label>
        <input type="text" id="u_username" value="${esc(u.username || u.id || '')}" ${isEdit ? 'disabled' : ''} placeholder="如 zhangls" style="width:100%;padding:9px 12px;border:1px solid #e2e8f0;border-radius:6px;font-size:14px"/>
      </div>
      <div class="form-row">
        <label style="color:#475569;font-size:13px">显示名称</label>
        <input type="text" id="u_realname" value="${esc(u.real_name || u.display_name || '')}" placeholder="如 张老师" style="width:100%;padding:9px 12px;border:1px solid #e2e8f0;border-radius:6px;font-size:14px"/>
      </div>
      ${!isEdit ? `
      <div class="form-row">
        <label style="color:#475569;font-size:13px">密码 <span style="color:#ef4444">*</span></label>
        <input type="text" id="u_password" value="123456" placeholder="默认 123456" style="width:100%;padding:9px 12px;border:1px solid #e2e8f0;border-radius:6px;font-size:14px"/>
      </div>` : ''}
      <div class="form-row">
        <label style="color:#475569;font-size:13px">角色 <span style="color:#ef4444">*</span></label>
        <select id="u_role" onchange="window.onUserRoleChange()" style="width:100%;padding:9px 12px;border:1px solid #e2e8f0;border-radius:6px;font-size:14px;background:#fff">
          <option value="counselor" ${u.role === 'counselor' ? 'selected' : ''}>辅导员（管理本班）</option>
          <option value="teacher" ${u.role === 'teacher' ? 'selected' : ''}>班主任（管理本班）</option>
          <option value="dean" ${u.role === 'dean' ? 'selected' : ''}>院领导（只读）</option>
        </select>
      </div>
      <div class="form-row" id="u_classes_row">
        <label style="color:#475569;font-size:13px">管理班级 <span style="color:#94a3b8;font-size:11px">（输入关键词，从下方列表中选择）</span></label>
        <div id="u_classes_tags" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px"></div>
        <div style="position:relative">
          <input type="text" id="u_classes_input" placeholder="如：测绘2301、地信2301…" style="width:100%;padding:9px 12px;border:1px solid #e2e8f0;border-radius:6px;font-size:14px;box-sizing:border-box"/>
          <div id="u_class_dropdown" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:999;background:#fff;border:1px solid #e2e8f0;border-radius:6px;margin-top:2px;max-height:180px;overflow-y:auto;box-shadow:0 4px 12px rgba(0,0,0,.1)"></div>
        </div>
      </div>
      <div id="u_role_tip" style="margin:8px 0;padding:8px 12px;background:#f0f9ff;border-left:3px solid #3b82f6;border-radius:4px;font-size:12px;color:#1e40af;display:none">
        💡 该角色登录后将自动关联所选班级数据
      </div>
      <div style="margin-top:16px;display:flex;gap:8px;justify-content:flex-end">
        <button class="btn btn-o" onclick="this.closest('.modal-mask').remove()">取消</button>
        <button class="btn btn-p" onclick="window.saveUser(${u.id || 0})">保存</button>
      </div>
    </div>
  </div>`;
  
  document.body.insertAdjacentHTML('beforeend', html);
  
  // 初始化班级标签
  window._uClasses = userClass ? userClass.split(',').map(s => s.trim()).filter(Boolean) : [];
  window.renderUserClassTags();
  
  // 加载所有班级列表供自动补全
  (async () => {
    try {
      const cj = await api('/api/classes/public');
      window._allClasses = (cj.data || []).map(c => c.name || c.class_name || c).filter(Boolean);
    } catch (e) {
      window._allClasses = [];
    }
  })();
  
  // 班级输入事件
  const classInput = document.getElementById('u_classes_input');
  const classDropdown = document.getElementById('u_class_dropdown');
  
  if (classInput && classDropdown) {
    classInput.addEventListener('input', () => {
      const q = classInput.value.trim().toLowerCase();
      if (!q) { classDropdown.style.display = 'none'; return; }
      const matches = (window._allClasses || []).filter(c => 
        c.toLowerCase().includes(q) && !window._uClasses.includes(c)
      );
      if (!matches.length) { classDropdown.style.display = 'none'; return; }
      classDropdown.innerHTML = matches.map(c => 
        `<div style="padding:8px 12px;cursor:pointer;font-size:13px;color:#334155;border-bottom:1px solid #f1f5f9" 
          onmouseover="this.style.background='#f0f9ff'" onmouseout="this.style.background=''" 
          onclick="window.selectUserClass('${esc(c)}')">${esc(c)}</div>`
      ).join('');
      classDropdown.style.display = '';
    });
    
    classInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); const first = classDropdown.querySelector('div'); if (first) first.click(); }
      if (e.key === 'Escape') { classDropdown.style.display = 'none'; }
    });
    
    classInput.addEventListener('blur', () => setTimeout(() => { classDropdown.style.display = 'none'; }, 150));
    classInput.addEventListener('focus', () => { if (classInput.value.trim()) classInput.dispatchEvent(new Event('input')); });
  }
  
  window.onUserRoleChange();
};

window.renderUserClassTags = function() {
  const el = document.getElementById('u_classes_tags');
  if (!el) return;
  el.innerHTML = (window._uClasses || []).map(c => 
    `<span style="display:inline-flex;align-items:center;gap:4px;background:#dbeafe;color:#1d4ed8;padding:3px 8px;border-radius:4px;font-size:12px">${esc(c)}<span style="cursor:pointer;color:#ef4444;font-weight:700" onclick="window.removeUserClass('${esc(c)}')">×</span></span>`
  ).join('');
};

window.removeUserClass = function(c) {
  window._uClasses = (window._uClasses || []).filter(x => x !== c);
  window.renderUserClassTags();
};

window.selectUserClass = function(cname) {
  if (!window._uClasses.includes(cname)) window._uClasses.push(cname);
  document.getElementById('u_classes_input').value = '';
  document.getElementById('u_class_dropdown').style.display = 'none';
  window.renderUserClassTags();
};

window.onUserRoleChange = function() {
  const role = document.getElementById('u_role')?.value;
  const row = document.getElementById('u_classes_row');
  const tip = document.getElementById('u_role_tip');
  
  if (!row || !tip) return;
  
  if (role === 'dean') {
    row.style.display = 'none';
    tip.style.display = 'none';
  } else {
    row.style.display = 'block';
    if (role === 'counselor') {
      tip.style.display = 'block';
      tip.innerHTML = '💡 该辅导员登录后将自动关联所选班级数据，只能管理本班';
    } else if (role === 'teacher') {
      tip.style.display = 'block';
      tip.innerHTML = '💡 该班主任登录后将自动关联所选班级数据，只能管理本班';
    }
  }
};

window.saveUser = async function(id) {
  const username = document.getElementById('u_username')?.value?.trim();
  const real_name = document.getElementById('u_realname')?.value?.trim();
  const role = document.getElementById('u_role')?.value;
  const password = document.getElementById('u_password')?.value;
  
  if (!username) {
    window.showToast('请填写用户名', 'warning');
    return;
  }
  
  if (role === 'super_admin' || role === 'admin') {
    window.showToast('不能创建超级管理员（admin 是系统内置）', 'warning');
    return;
  }
  
  const class_name = (window._uClasses || []).join(',');
  let r;
  
  if (id) {
    r = await apiAuth('/api/users/' + id, { method: 'PUT', body: JSON.stringify({ display_name: real_name, role, class_name }) });
  } else {
    r = await apiAuth('/api/users', { method: 'POST', body: JSON.stringify({ id: username, password: password || '123456', display_name: real_name, role, class_name }) });
  }
  
  if (r.code === 0) {
    document.querySelector('.modal-mask:last-child')?.remove();
    window.showToast(id ? '修改成功' : '添加成功', 'success');
    window.loadUsers();
  } else {
    window.showToast(r.message || '保存失败', 'error');
  }
};

window.resetUserPwd = async function(btn) {
  const tr = btn?.closest('tr');
  const id = tr?.dataset.uid;
  const uname = tr?.dataset.uname;
  
  if (!confirm(`确认重置用户「${uname}」的密码为 123456？`)) return;
  
  const r = await apiAuth('/api/reset-password', { method: 'POST', body: JSON.stringify({ user_id: id, new_password: '123456' }) });
  if (r.code === 0) {
    window.showToast('密码已重置为 123456', 'success');
  } else {
    window.showToast(r.message || '重置失败', 'error');
  }
};

window.deleteUser = async function(btn) {
  const tr = btn?.closest('tr');
  const id = tr?.dataset.uid;
  const uname = tr?.dataset.uname;
  
  if (!confirm(`确认删除用户「${uname}」？此操作不可恢复！`)) return;
  
  const r = await apiAuth('/api/users/' + id, { method: 'DELETE' });
  if (r.code === 0) {
    window.showToast('删除成功', 'success');
    window.loadUsers();
  } else {
    window.showToast(r.message || '删除失败', 'error');
  }
};

// ==================== 密码管理 ====================
window.initPwdMgmtUsers = async function() {
  try {
    const j = await apiAuth('/api/users');
    const sel = document.getElementById('pwdMgmtUserSel');
    if (!sel) return;
    
    const html = '<option value="">-- 请选择用户 --</option>' + 
      (j.data || []).map(u => {
        const dn = u.display_name || u.username;
        return `<option value="${esc(u.username || u.id)}">${esc(u.username || u.id)}（${esc(dn)}）</option>`;
      }).join('');
    safeSetInnerHTML(sel, html);
  } catch (e) {}
};

window.openChangeMyPwdModal = function() {
  document.getElementById('cmOldPwd').value = '';
  document.getElementById('cmNewPwd').value = '';
  document.getElementById('cmNewPwd2').value = '';
  window.showModal('changeMyPwdModal');
  document.getElementById('cmOldPwd')?.focus();
};

window.confirmChangeMyPwd = async function() {
  const oldPwd = document.getElementById('cmOldPwd')?.value;
  const newPwd = document.getElementById('cmNewPwd')?.value;
  const newPwd2 = document.getElementById('cmNewPwd2')?.value;
  
  if (!oldPwd || !newPwd) {
    window.showToast('请填写原密码和新密码', 'warning');
    return;
  }
  if (newPwd.length < 6) {
    window.showToast('新密码至少 6 位', 'warning');
    return;
  }
  if (newPwd !== newPwd2) {
    window.showToast('两次输入的新密码不一致', 'warning');
    return;
  }
  
  const r = await apiAuth('/api/change-password', { method: 'POST', body: JSON.stringify({ oldPwd, newPwd }) });
  if (r.code === 0) {
    window.showToast('密码修改成功，下次登录请使用新密码', 'success');
    window.closeModal('changeMyPwdModal');
  } else {
    window.showToast('修改失败：' + (r.message || '原密码可能错误'), 'error');
  }
};

// ==================== 学生密码重置 ====================
window.loadStuPwdReset = async function() {
  try {
    const cSel = document.getElementById('rpClass');
    const sSel = document.getElementById('rpStudent');
    if (!cSel || !sSel) return;
    
    const cls = await apiAuth('/api/students/classes');
    if (cls.code === 0) {
      safeSetInnerHTML(cSel, '<option value="">全部班级</option>' + 
        cls.data.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join(''));
    }
    
    const loadStudents = async () => {
      const c = cSel.value;
      const r = await apiAuth('/api/students/paged?limit=300' + (c ? ('&class_name=' + encodeURIComponent(c)) : ''));
      if (r.code === 0) {
        safeSetInnerHTML(sSel, '<option value="">选择学生</option>' + 
          r.data.map(s => `<option value="${s.id}">${esc(s.name)}（${esc(s.class_name)}　${esc(s.dorm || '—')}）</option>`).join(''));
      }
    };
    
    cSel.onchange = loadStudents;
    await loadStudents();
  } catch (e) {}
};

window.resetStudentPwd = async function() {
  const sid = document.getElementById('rpStudent')?.value;
  const pwd = document.getElementById('rpNewPwd')?.value?.trim();
  const msg = document.getElementById('rpMsg');
  
  if (!sid) {
    if (msg) { msg.style.color = '#ef4444'; msg.textContent = '请先选择学生'; }
    return;
  }
  
  try {
    const r = await apiAuth('/api/student-reset-password', {
      method: 'POST',
      body: JSON.stringify({ studentId: sid, newPassword: pwd })
    });
    if (msg) {
      msg.style.color = r.code === 0 ? '#22c55e' : '#ef4444';
      msg.textContent = r.message || (r.code === 0 ? '重置成功' : '重置失败');
    }
  } catch (e) {
    if (msg) { msg.style.color = '#ef4444'; msg.textContent = '网络错误：' + e.message; }
  }
};

// ==================== 主题色 ====================
window.initThemeColors = function() {
  const themes = [
    { name: '科技蓝', color: '#4f46e5', primary: '#4f46e5' },
    { name: '翠冷', color: '#10b981', primary: '#10b981' },
    { name: '琥珀橙', color: '#f59e0b', primary: '#f59e0b' },
    { name: '玫瑰红', color: '#ef4444', primary: '#ef4444' },
    { name: '深邃紫', color: '#8b5cf6', primary: '#8b5cf6' },
    { name: '天空青', color: '#06b6d4', primary: '#06b6d4' }
  ];
  
  const el = document.getElementById('themeColorPicker');
  if (!el) return;
  
  const current = localStorage.getItem('wb_theme_color') || '#4f46e5';
  
  const html = themes.map(t => {
    const pSafe = esc(t.primary).replace(/'/g, "\\'");
    const nSafe = esc(t.name).replace(/'/g, "\\'");
    const isActive = current === t.primary;
    return `
    <div onclick="window.setThemeColor('${pSafe}','${nSafe}')" style="display:flex;flex-direction:column;align-items:center;cursor:pointer;gap:6px">
      <div style="width:42px;height:42px;border-radius:50%;background:${t.color};box-shadow:0 2px 8px ${t.color}40;transition:all .25s;${isActive ? 'outline:3px solid ' + t.color + ';outline-offset:2px' : ''}" 
           onmouseover="this.style.transform='scale(1.1)'" 
           onmouseout="this.style.transform='scale(1)'"></div>
      <span style="font-size:12px;color:#475569">${esc(t.name)}</span>
    </div>`;
  }).join('');
  
  safeSetInnerHTML(el, html);
  document.documentElement.style.setProperty('--primary', current);
};

window.setThemeColor = function(color, name) {
  localStorage.setItem('wb_theme_color', color);
  document.documentElement.style.setProperty('--primary', color);
  window.initThemeColors();
  window.showToast('主题色已切换为 ' + name, 'success');
};

// ==================== 通用工具 ====================
window.pageBtns = function(pages, cur) {
  if (pages <= 1) return '';
  const prevDisabled = cur <= 1 ? 'disabled' : '';
  const nextDisabled = cur >= pages ? 'disabled' : '';
  return `<button class="btn btn-sm btn-o" data-page="${cur - 1}" ${prevDisabled}>◀ 上一页</button>
    <button class="btn btn-sm btn-o" data-page="${cur + 1}" ${nextDisabled}>下一页 ▶</button>
    <input type="number" data-paging="input" value="${cur}" min="1" max="${pages}" style="width:64px;height:28px;text-align:center;font-size:12px;border:1px solid #e2e8f0;border-radius:4px">
    <span>/${pages}页</span>
    <button class="btn btn-sm btn-o" data-action="jump">跳转</button>`;
};

window.goPage = function(p) {
  // Override in specific modules
  console.warn('goPage called, please implement in specific module');
};

window.renderPagedTable = function(rows, page, perPage, tableHtml, pageContainerId, tableContainerId) {
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  page = Math.min(Math.max(1, page), pages);
  const start = (page - 1) * perPage;
  const slice = rows.slice(start, start + perPage);
  const html = tableHtml(slice, page, total, pages);
  const pag = document.getElementById(pageContainerId);
  
  if (tableContainerId) {
    const el = document.getElementById(tableContainerId);
    if (el) el.innerHTML = html;
  }
  
  if (pag) {
    const goTo = (p) => {
      p = Math.min(Math.max(1, parseInt(p) || 1), pages);
      if (p !== page) window.renderPagedTable(rows, p, perPage, tableHtml, pageContainerId, tableContainerId);
    };
    
    const pagHtml = `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;font-size:12px;color:#64748b">
        <span>共 <b style="color:#1e293b">${total}</b> 条 · 第 <b style="color:#1e293b">${page}</b>/${pages} 页 · 每页 ${perPage} 条</span>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap" id="${pageContainerId}_btns">${window.pageBtns(pages, page)}</div>
      </div>`;
    safeSetInnerHTML(pag, pagHtml);
    
    const btns = document.getElementById(pageContainerId + '_btns');
    if (btns && !btns.dataset.bound) {
      btns.dataset.bound = '1';
      btns.addEventListener('click', (e) => {
        const t = e.target.closest('button');
        if (!t) return;
        let p;
        if (t.dataset.action === 'jump') {
          const input = btns.querySelector('[data-paging="input"]');
          p = parseInt(input?.value);
        } else {
          p = parseInt(t.dataset.page);
        }
        if (!isNaN(p)) goTo(p);
      });
      btns.addEventListener('keydown', (e) => {
        if (e.target.dataset.paging === 'input' && e.key === 'Enter') {
          goTo(e.target.value);
        }
      });
    }
  }
  
  return html;
};

window.showModal = function(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('show');
};

window.closeModal = function(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('show');
};
