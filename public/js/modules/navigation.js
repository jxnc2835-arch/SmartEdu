/**
 * 导航模块
 * 封装页面切换、标题更新等导航相关功能
 */

// ==================== 导航配置 ====================
const NAV_TITLES = {
  overview: '查寝管理',
  leave: '请假管理', 
  course: '课程考勤',
  students: '学生管理',
  dorms: '宿舍管理',
  stats: '统计分析',
  ai: 'AI 智能助手',
  settings: '系统设置',
  users: '用户管理',
  alerts: '异常告警'
};

// ==================== 导航初始化 ====================
window.initNavigation = function() {
  document.querySelectorAll('.nav-item').forEach(it => {
    it.addEventListener('click', async () => {
      if (it.classList.contains('nav-ext')) return;
      
      const sec = it.dataset.sec;
      if (sec === 'dashboard') {
        window.location.href = './dashboard.html';
        return;
      }
      
      // 更新激活状态
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      it.classList.add('active');
      
      // 切换页面
      document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
      const secEl = document.getElementById('sec-' + sec);
      if (secEl) secEl.classList.add('active');
      
      // 更新标题
      const titleEl = document.getElementById('pageTitle');
      if (titleEl) titleEl.textContent = NAV_TITLES[sec] || sec;
      
      // 加载内容
      await window.loadSection(sec);
    });
  });
};

// ==================== 页面加载调度 ====================
window.loadSection = async function(sec) {
  const sectionMap = {
    overview: () => Promise.all([
      window.loadOverview ? window.loadOverview() : Promise.resolve(),
      window.loadDormStats ? window.loadDormStats() : Promise.resolve(),
      window.loadCheckin ? window.loadCheckin() : Promise.resolve()
    ]),
    leave: () => window.loadLeaves ? window.loadLeaves() : Promise.resolve(),
    course: () => Promise.all([
      window.loadCourses ? window.loadCourses() : Promise.resolve(),
      window.loadClassRecords ? window.loadClassRecords() : Promise.resolve(),
      window.loadCoursesList ? window.loadCoursesList() : Promise.resolve()
    ]),
    students: () => window.loadStudents ? window.loadStudents() : Promise.resolve(),
    dorms: () => window.loadDorms ? window.loadDorms() : Promise.resolve(),
    stats: () => window.loadStats ? window.loadStats() : Promise.resolve(),
    ai: () => window.initAI ? window.initAI() : Promise.resolve(),
    alerts: () => window.loadAlerts ? window.loadAlerts() : Promise.resolve(),
    settings: () => Promise.all([
      window.loadBackups ? window.loadBackups() : Promise.resolve(),
      window.loadLogs ? window.loadLogs() : Promise.resolve(),
      window.loadWebhookConfig ? window.loadWebhookConfig() : Promise.resolve(),
      window.loadAlertRules ? window.loadAlertRules() : Promise.resolve(),
      window.loadWebhookHistory ? window.loadWebhookHistory() : Promise.resolve(),
      window.loadVoiceRecords ? window.loadVoiceRecords() : Promise.resolve(),
      window.loadGeofenceRules ? window.loadGeofenceRules() : Promise.resolve(),
      window.loadWebhookSettings ? window.loadWebhookSettings() : Promise.resolve()
    ]),
    users: () => Promise.all([
      window.loadUsers ? window.loadUsers() : Promise.resolve(),
      window.initPwdMgmtUsers ? window.initPwdMgmtUsers() : Promise.resolve(),
      window.initThemeColors ? window.initThemeColors() : Promise.resolve()
    ])
  };
  
  const loader = sectionMap[sec];
  if (loader) {
    try {
      await loader();
    } catch (e) {
      console.error(`[Navigation] 加载 ${sec} 失败:`, e);
      window.showToast(`加载「${NAV_TITLES[sec] || sec}」失败`, 'error');
    }
  }
};

// ==================== 初始化 ====================
document.addEventListener('DOMContentLoaded', () => {
  if (window.authToken) {
    window.initNavigation();
  }
});
