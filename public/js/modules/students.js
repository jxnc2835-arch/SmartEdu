/**
 * 学生管理模块
 * 封装学生CRUD、导入导出等核心功能
 */

// ==================== 学生列表加载 ====================
window.studentsPage = 1;
window._stuCurrentRows = [];

window.loadStudents = async function() {
  const cls = document.getElementById('stuClassFilter')?.value || '';
  const dorm = document.getElementById('stuDormFilter')?.value || '';
  const search = document.getElementById('stuSearchInput')?.value || '';
  
  let url = '/api/students?limit=500';
  if (cls) url += `&class_name=${encodeURIComponent(cls)}`;
  if (dorm) url += `&dorm=${encodeURIComponent(dorm)}`;
  if (search) url += `&search=${encodeURIComponent(search)}`;
  
  const j = await apiAuth(url);
  if (j.code === 0 && j.data) {
    window._stuCurrentRows = j.data;
    window.studentsPage = 1;
    renderStudents(j.data);
  }
};

window.renderStudents = function(rows) {
  const el = document.getElementById('stuTable');
  if (!el) return;
  
  if (!rows || !rows.length) {
    safeSetInnerHTML(el, '<div class="empty">暂无学生</div>');
    return;
  }
  
  const curPage = window.studentsPage || 1;
  const pageSize = 10;
  const start = (curPage - 1) * pageSize;
  const pageRows = rows.slice(start, start + pageSize);
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  
  const html = `<table>
    <thead><tr><th>姓名</th><th>性别</th><th>学号</th><th>宿舍</th><th>班级</th><th>电话</th><th>人脸</th><th>操作</th></tr></thead>
    <tbody>${pageRows.map(s => `
      <tr>
        <td>${esc(s.name) || '-'}</td>
        <td>${esc(s.gender) || '-'}</td>
        <td>${esc(s.student_id) || '-'}</td>
        <td>${esc(s.dorm) || '-'}</td>
        <td>${esc(s.class_name) || '-'}</td>
        <td>${esc(s.phone) || '-'}</td>
        <td>${s.face_hash ? '<span class="tag green">✓已注册</span>' : '<span class="tag gray">未注册</span>'}</td>
        <td>
          <button onclick="editStudent(${s.id})" class="btn-sm">编辑</button>
          <button onclick="deleteStudent(${s.id})" class="btn-sm btn-danger">删除</button>
        </td>
      </tr>
    `).join('')}</tbody>
  </table>
  <div style="margin-top:12px;display:flex;justify-content:space-between;align-items:center;font-size:12px;color:#64748b">
    <span>共 <b>${rows.length}</b> 名学生</span>
    <div>${pageBtns(totalPages, curPage)}</div>
  </div>`;
  
  safeSetInnerHTML(el, html);
  
  // 绑定分页事件
  const pager = el.querySelector('[id$="_pager"]') || el;
  if (pager && !pager.dataset.bound) {
    pager.dataset.bound = '1';
    pager.addEventListener('click', (e) => {
      const t = e.target.closest('button[data-page]');
      if (t) {
        window.studentsPage = parseInt(t.dataset.page);
        renderStudents(window._stuCurrentRows);
      }
    });
  }
};

// ==================== 学生编辑/保存 ====================
window.editStudent = async function(id) {
  const el = document.getElementById('stuForm');
  if (!el) return;
  
  // 加载学生详情
  const j = await api(`/api/students/${id}`);
  if (j.code !== 0 || !j.data) {
    showToast('加载学生信息失败', 'error');
    return;
  }
  
  const s = j.data;
  document.getElementById('stuId').value = s.id;
  document.getElementById('stuName').value = s.name || '';
  document.getElementById('stuGender').value = s.gender || '男生';
  document.getElementById('stuStudentId').value = s.student_id || '';
  document.getElementById('stuDorm').value = s.dorm || '';
  document.getElementById('stuClass').value = s.class_name || '';
  document.getElementById('stuPhone').value = s.phone || '';
  
  showModal('stuFormModal');
};

window.saveStudent = async function() {
  const id = document.getElementById('stuId')?.value;
  const name = document.getElementById('stuName')?.value?.trim();
  const gender = document.getElementById('stuGender')?.value;
  const studentId = document.getElementById('stuStudentId')?.value?.trim();
  const dorm = document.getElementById('stuDorm')?.value?.trim();
  const className = document.getElementById('stuClass')?.value?.trim();
  const phone = document.getElementById('stuPhone')?.value?.trim();
  
  if (!name || !studentId) {
    showToast('姓名和学号不能为空', 'warning');
    return;
  }
  
  const method = id ? 'PUT' : 'POST';
  const url = id ? `/api/students/${id}` : '/api/students';
  const body = { name, gender, student_id: studentId, dorm, class_name: className, phone };
  
  const j = await apiAuth(url, { method, body });
  if (j.code === 0) {
    showToast(id ? '学生信息已更新' : '学生添加成功', 'success');
    closeModal('stuFormModal');
    window.loadStudents();
  } else {
    showToast(j.message || '操作失败', 'error');
  }
};

window.deleteStudent = async function(id) {
  if (!confirm('确定要删除该学生吗？此操作不可恢复。')) return;
  
  const j = await apiAuth(`/api/students/${id}`, { method: 'DELETE' });
  if (j.code === 0) {
    showToast('学生已删除', 'success');
    window.loadStudents();
  } else {
    showToast(j.message || '删除失败', 'error');
  }
};

// ==================== 学生导入 ====================
window.importStudents = async function(file) {
  if (!file) {
    showToast('请先选择Excel文件', 'warning');
    return;
  }
  
  const formData = new FormData();
  formData.append('file', file);
  
  const j = await apiAuth('/api/students/import-excel', {
    method: 'POST',
    body: formData,
    headers: {} // 不设置Content-Type，让浏览器自动设置
  });
  
  if (j.code === 0) {
    showToast(`导入成功，新增 ${j.data?.added || 0} 名学生`, 'success');
    window.loadStudents();
  } else {
    showToast(j.message || '导入失败', 'error');
  }
};

// ==================== 宿舍管理 ====================
window.loadDorms = async function() {
  const cls = document.getElementById('dormClassFilter')?.value || '';
  const j = await apiAuth(`/api/dorms?limit=500${cls ? '&class_name=' + encodeURIComponent(cls) : ''}`);
  
  const el = document.getElementById('dormTable');
  if (!el) return;
  
  if (!j.data || !j.data.length) {
    safeSetInnerHTML(el, '<div class="empty">暂无宿舍数据</div>');
    return;
  }
  
  const rows = j.data;
  const html = `<table>
    <thead><tr><th>楼栋</th><th>房间</th><th>容量</th><th>已住</th><th>性别</th><th>操作</th></tr></thead>
    <tbody>${rows.map(d => `
      <tr>
        <td>${esc(d.building) || '-'}</td>
        <td>${esc(d.room) || '-'}</td>
        <td>${d.capacity || '-'}</td>
        <td>${d.occupied || 0}</td>
        <td>${d.gender || '-'}</td>
        <td>
          <button onclick="editDorm(${d.id})" class="btn-sm">编辑</button>
        </td>
      </tr>
    `).join('')}</tbody>
  </table>`;
  
  safeSetInnerHTML(el, html);
};

window.editDorm = function(id) {
  showToast('宿舍编辑功能开发中', 'info');
};
