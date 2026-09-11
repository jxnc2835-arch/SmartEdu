/**
 * 教学管理系统模块化架构规划
 * 
 * 当前状态:
 * - teacher.html: 4911 行，269KB，单文件架构
 * - 已提取: public/js/modules/base.js (工具函数、认证、API 客户端)
 * 
 * 模块化目标:
 * 将 teacher.html 拆分为独立模块，提升可维护性
 */

// ============================================================
// 模块划分方案
// ============================================================

const MODULES = {
  // 1. 基础工具层（已提取）
  base: {
    file: 'public/js/modules/base.js',
    functions: ['esc', 'pad2', 'beijingNow', 'fmtCN', 'todayStr', 'fmtDateOnly'],
    status: 'DONE'
  },
  
  // 2. 通知与 UI 层（已提取）
  notifications: {
    file: 'public/js/modules/notifications.js',
    functions: ['showToast', 'showLoading', 'refreshBtn', 'animateNum', 'validateRequired'],
    status: 'DONE'
  },
  
  // 3. 认证模块（待提取）
  auth: {
    file: 'public/js/modules/auth.js',
    functions: ['getToken', 'setToken', 'api', 'apiAuth', 'logoutToLogin', 'doLogin', 'doLogout'],
    status: 'PENDING'
  },
  
  // 4. 导航模块（待提取）
  navigation: {
    file: 'public/js/modules/navigation.js',
    functions: ['loadSection', 'switchTab', 'updateTitle'],
    status: 'PENDING'
  },
  
  // 5. 查寝管理模块（待提取）
  checkin: {
    file: 'public/js/modules/checkin.js',
    functions: ['loadCheckin', 'loadRecords', 'handleCheckin'],
    status: 'PENDING'
  },
  
  // 6. 学生管理模块（待提取）
  students: {
    file: 'public/js/modules/students.js',
    functions: ['loadStudents', 'handleAddStudent', 'handleEditStudent', 'handleDeleteStudent'],
    status: 'PENDING'
  },
  
  // 7. 统计模块（待提取）
  statistics: {
    file: 'public/js/modules/statistics.js',
    functions: ['loadStats', 'renderChart', 'loadConduct'],
    status: 'PENDING'
  },
  
  // 8. AI 模块（待提取）
  ai: {
    file: 'public/js/modules/ai.js',
    functions: ['initAI', 'askAI', 'loadPrediction'],
    status: 'PENDING'
  },
  
  // 9. 设置模块（待提取）
  settings: {
    file: 'public/js/modules/settings.js',
    functions: ['loadBackups', 'loadLogs', 'loadWebhookConfig'],
    status: 'PENDING'
  }
};

// ============================================================
// 技术债务清单
// ============================================================

const TECHNICAL_DEBT = [
  {
    id: 'TD-001',
    area: 'teacher.html',
    issue: '单文件过大（4911行/269KB）',
    impact: '高',
    suggestion: '按 MODULES 定义逐步拆分'
  },
  {
    id: 'TD-002',
    area: '前端',
    issue: '无 CDN 缓存策略',
    impact: '中',
    suggestion: '添加 content-hash 文件名 + maxAge: 31536000'
  },
  {
    id: 'TD-003',
    area: '前端',
    issue: '无错误边界',
    impact: '中',
    suggestion: '添加 try-catch + fallback UI'
  },
  {
    id: 'TD-004',
    area: 'API',
    issue: '部分接口缺少分页',
    impact: '低',
    suggestion: '统一分页参数: page, pageSize, total'
  }
];

// ============================================================
// 执行计划
// ============================================================

const EXECUTION_PLAN = [
  {
    phase: 1,
    title: '提取认证模块',
    tasks: ['提取 doLogin/doLogout/api/apiAuth', '测试登录流程', '更新 teacher.html 引用']
  },
  {
    phase: 2,
    title: '提取导航模块',
    tasks: ['提取 loadSection/switchTab', '测试页面切换', '更新 teacher.html 引用']
  },
  {
    phase: 3,
    title: '提取查寝模块',
    tasks: ['提取 checkin 相关函数', '测试签到流程', '更新 teacher.html 引用']
  },
  {
    phase: 4,
    title: '提取学生管理模块',
    tasks: ['提取 students CRUD', '测试增删改查', '更新 teacher.html 引用']
  },
  {
    phase: 5,
    title: '提取统计/AI/设置模块',
    tasks: ['批量提取剩余模块', '集成测试', '性能优化']
  }
];

module.exports = { MODULES, TECHNICAL_DEBT, EXECUTION_PLAN };
