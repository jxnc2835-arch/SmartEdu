/**
 * AI 智能问答引擎 - 模块化版本
 * 
 * 架构说明：
 * - routes/ai/date-utils.js    : 日期工具函数
 * - routes/ai/session.js       : 会话管理（内存+持久化）
 * - routes/ai/data-analyzer.js : 数据分析函数
 * - routes/ai/llm-client.js    : LLM 调用（askZhipu/callLLM）
 * - routes/ai/prompt-builder.js: 意图路由 + 提示词构建
 * 
 * 本文件作为统一入口，负责：
 * 1. 依赖注入（db, fs, authMiddleware 等）
 * 2. 会话初始化与定时清理
 * 3. 路由注册
 */

const express = require('express');
const path = require('path');
const fs = require('fs');

// 导入模块化组件
const dateUtils = require('./ai/date-utils');
const sessionMgr = require('./ai/session');
const dataAnalyzer = require('./ai/data-analyzer');
const llmClient = require('./ai/llm-client');
const promptBuilder = require('./ai/prompt-builder');

// 合并日期工具到全局方便使用
const { 
  parseDateStr, fmtDate, shiftDate, dateDiffDays, weekRange,
  resolveDateRef, dateRefDate, dateRefEnd, dateRefDays, dateRefRange
} = dateUtils;

/**
 * 初始化 AI 子路由
 * @param {Object} deps - 依赖注入
 * @returns {Express.Router}
 */
function initChatSubRouter(deps) {
  const { db, fs: fsDep, ROOT_DIR, authMiddleware, localDateStr, addLog, broadcast, STUDENT_TOKENS, sendWebhook, scheduleSave } = deps;

  // ===== 类名/课程名缓存 =====
  let CLASS_NAMES = [];
  let COURSE_NAMES = [];

  function loadClassNames() {
    try {
      const r = db.exec("SELECT DISTINCT class_name FROM students WHERE class_name IS NOT NULL AND class_name!='' ORDER BY class_name")[0];
      CLASS_NAMES = r ? r.values.map(v => v[0]) : [];
    } catch (e) { CLASS_NAMES = []; }
  }

  function resolveClassName(raw) {
    if (!raw) return '';
    const trimmed = raw.trim();
    if (CLASS_NAMES.includes(trimmed)) return trimmed;
    const CN_NUM = { '一': '1', '二': '2', '三': '3', '四': '4', '五': '5', '六': '6', '七': '7', '八': '8', '九': '9', '十': '10' };
    const m = trimmed.match(/^([\u4e00-\u9fa5]+?)([一二三四五六七八九十\d]{1,2})$/);
    if (m) {
      const major = m[1];
      const num = CN_NUM[m[2]] || m[2];
      const candidates = CLASS_NAMES.filter(c => c.startsWith(major) && c.includes(num));
      if (candidates.length === 1) return candidates[0];
      if (candidates.length > 1) {
        const exact = candidates.find(c => new RegExp(major + '\\d*' + num + '($|[^0-9])').test(c));
        if (exact) return exact;
        return candidates[0];
      }
    }
    const likeCandidates = CLASS_NAMES.filter(c => c.includes(trimmed));
    return likeCandidates.length === 1 ? likeCandidates[0] : (likeCandidates[0] || trimmed);
  }

  function loadCourseNames() {
    try {
      const r = db.exec("SELECT DISTINCT course_name FROM records WHERE type='class' AND course_name IS NOT NULL AND course_name!='' ORDER BY course_name")[0];
      COURSE_NAMES = r ? r.values.map(v => v[0]) : [];
    } catch (e) { COURSE_NAMES = []; }
  }

  // 启动时加载
  loadClassNames();
  loadCourseNames();

  // ===== 会话管理（内存 + 文件持久化） =====
  const sessionMemory = new Map();
  const MAX_SESSION_TURNS = 10;
  const SESSION_TTL_MS = 30 * 60 * 1000;
  const SESSIONS_FILE = path.join(ROOT_DIR, 'data', 'ai_sessions.json');

  function loadSessions() {
    try {
      if (!fsDep.existsSync(SESSIONS_FILE)) return;
      const obj = JSON.parse(fsDep.readFileSync(SESSIONS_FILE, 'utf8'));
      if (obj && typeof obj === 'object') {
        const now = Date.now();
        for (const [sid, sess] of Object.entries(obj)) {
          const hist = sess.messages || [];
          if (hist.length > 0 && now - (hist[hist.length - 1].ts || 0) > SESSION_TTL_MS) continue;
          sessionMemory.set(sid, sess);
        }
      }
    } catch (e) {
      console.error('[AI Sessions] 加载失败:', e.message);
    }
  }

  function persistSessions() {
    try {
      const now = Date.now();
      const obj = {};
      for (const [sid, sess] of sessionMemory.entries()) {
        const hist = sess.messages || [];
        if (hist.length > 0 && now - (hist[hist.length - 1].ts || 0) > SESSION_TTL_MS) continue;
        try { JSON.stringify(sess); obj[sid] = sess; }
        catch (_) {}
      }
      const dir = path.dirname(SESSIONS_FILE);
      if (!fsDep.existsSync(dir)) fsDep.mkdirSync(dir, { recursive: true });
      fsDep.writeFileSync(SESSIONS_FILE, JSON.stringify(obj), 'utf8');
    } catch (e) {
      console.error('[AI Sessions] 持久化失败:', e.message);
    }
  }

  function getSessionHistory(sessionId) {
    if (!sessionMemory.has(sessionId)) {
      sessionMemory.set(sessionId, { messages: [], lastIntent: null, lastClassFilter: '', lastQuestion: '', lastData: null });
    }
    return sessionMemory.get(sessionId);
  }

  function addMessage(sessionId, role, content) {
    const sess = getSessionHistory(sessionId);
    sess.messages.push({ role, content, ts: Date.now() });
    if (sess.messages.length > MAX_SESSION_TURNS * 2) {
      sess.messages.splice(0, sess.messages.length - MAX_SESSION_TURNS * 2);
    }
  }

  function updateSessionContext(sessionId, updates) {
    const sess = getSessionHistory(sessionId);
    Object.assign(sess, updates);
  }

  // 启动时恢复会话（定时清理在测试环境下禁用）
  if (typeof setInterval !== 'undefined') {
    loadSessions();
    setInterval(() => {
      const now = Date.now();
      for (const [sid, sess] of sessionMemory.entries()) {
        const hist = sess.messages || [];
        if (hist.length > 0 && now - (hist[hist.length - 1].ts || 0) > SESSION_TTL_MS) sessionMemory.delete(sid);
      }
      persistSessions();
    }, 5 * 60 * 1000);
    setInterval(() => { persistSessions(); }, 60 * 1000);
  } else {
    loadSessions();
  }

  // ===== AI 配置持久化 =====
  const AI_CONFIG_FILE = path.join(ROOT_DIR, 'data', 'ai_config.json');
  let runtimeConfig = { baseUrl: null, apiKey: null, modelName: null, enableLLM: true, piiMask: false, fastModel: null };

  try {
    if (fsDep.existsSync(AI_CONFIG_FILE)) {
      const saved = JSON.parse(fsDep.readFileSync(AI_CONFIG_FILE, 'utf8'));
      if (saved) Object.assign(runtimeConfig, saved);
    }
  } catch (e) { console.warn('[AI Config] 加载失败:', e.message); }

  function persistAiConfig() {
    try {
      const dir = path.dirname(AI_CONFIG_FILE);
      if (!fsDep.existsSync(dir)) fsDep.mkdirSync(dir, { recursive: true });
      fsDep.writeFileSync(AI_CONFIG_FILE, JSON.stringify({
        baseUrl: runtimeConfig.baseUrl,
        apiKey: runtimeConfig.apiKey,
        modelName: runtimeConfig.modelName,
        enableLLM: runtimeConfig.enableLLM,
        piiMask: runtimeConfig.piiMask,
        fastModel: runtimeConfig.fastModel
      }, null, 2));
    } catch (e) { console.warn('[AI Config] 持久化失败:', e.message); }
  }

  // ===== 路由注册 =====
  const router = express.Router();

  // GET /ai/smart - 主入口
  router.get('/ai/smart', authMiddleware, async (req, res) => {
    const { question, session_id: sid } = req.query;
    if (!question) return res.json({ code: 1, message: '请输入问题' });
    try {
      const result = await llmClient.handleAiQuestion(question, sid, {
        db, runtimeConfig, getSessionHistory, addMessage, updateSessionContext,
        routeIntent: promptBuilder.routeIntent, loadDataForIntent: dataAnalyzer.loadDataForIntent,
        formatLocalAnswer: promptBuilder.formatLocalAnswer, getSuggestions: promptBuilder.getSuggestions,
        broadcast, sendWebhook, scheduleSave, addLog, localDateStr,
        CLASS_NAMES, COURSE_NAMES, resolveClassName,
        analyzeTodayCheckin: dataAnalyzer.analyzeTodayCheckin,
        analyzeAbsentList: dataAnalyzer.analyzeAbsentList,
        analyzeHighRisk: dataAnalyzer.analyzeHighRisk,
        analyzeAbsentTrend: dataAnalyzer.analyzeAbsentTrend,
        analyzeAbsentRange: dataAnalyzer.analyzeAbsentRange,
        analyzePeriodOverview: dataAnalyzer.analyzePeriodOverview,
        analyzeClassCompare: dataAnalyzer.analyzeClassCompare,
        analyzeLeave: dataAnalyzer.analyzeLeave,
        analyzeDormAnomaly: dataAnalyzer.analyzeDormAnomaly,
        analyzeCourseAttendance: dataAnalyzer.analyzeCourseAttendance,
        searchStudent: dataAnalyzer.searchStudent,
        getStudentProfile: dataAnalyzer.getStudentProfile,
        getFullDataSnapshot: dataAnalyzer.getFullDataSnapshot,
        getRecentRecords: dataAnalyzer.getRecentRecords,
        getAlertSummary: dataAnalyzer.getAlertSummary
      });
      res.json(result);
    } catch (err) {
      console.error('[AI Smart] 错误:', err.message?.substring(0, 200));
      res.json({ code: 0, data: { answer: '抱歉，AI助手暂时无法连接到模型服务。请检查网络或稍后重试。', source: 'local_engine', suggestions: [] } });
    }
  });

  // GET /ai/chat - 兼容旧接口
  router.get('/ai/chat', async (req, res) => {
    const { question, session_id: sid } = req.query;
    if (!question) return res.json({ code: 1, message: '请输入问题' });
    // 转发到 smart 接口
    const result = await llmClient.handleAiQuestion(question, sid, {
      db, runtimeConfig, getSessionHistory, addMessage, updateSessionContext,
      routeIntent: promptBuilder.routeIntent, loadDataForIntent: dataAnalyzer.loadDataForIntent,
      formatLocalAnswer: promptBuilder.formatLocalAnswer, getSuggestions: promptBuilder.getSuggestions
    });
    res.json(result);
  });

  // GET /ai/capabilities - 能力列表
  router.get('/ai/capabilities', (req, res) => {
    res.json({
      code: 0,
      data: {
        capabilities: [
          { icon: '📊', label: '今日签到总览', example: '今天签到情况怎么样？' },
          { icon: '⚠️', label: '未归学生分析', example: '现在谁没回来？' },
          { icon: '🔴', label: '高风险学生', example: '哪些学生最近缺勤多？' },
          { icon: '📈', label: '趋势预测', example: '近30天缺勤趋势？' },
          { icon: '🏆', label: '班级对比', example: '各班签到率排名？' },
          { icon: '📝', label: '请假分析', example: '待审批的请假多吗？' },
          { icon: '🏠', label: '宿舍异常', example: '哪些宿舍有异常？' },
          { icon: '📚', label: '课堂到课', example: '最近到课率？' },
          { icon: '💡', label: '智能建议', example: '我该怎么管理？' },
          { icon: '🔍', label: '学生搜索', example: '查一下张三的情况' },
          { icon: '🔔', label: '异常告警', example: '有哪些待处理的告警？' }
        ]
      }
    });
  });

  // POST /api/ai/config - 保存配置
  router.post('/api/ai/config', authMiddleware, (req, res) => {
    try {
      const { baseUrl, apiKey, modelName, enableLLM, piiMask, fastModel } = req.body || {};
      if (baseUrl !== undefined) runtimeConfig.baseUrl = (baseUrl && baseUrl.trim()) ? baseUrl.trim() : null;
      if (apiKey !== undefined) runtimeConfig.apiKey = (apiKey && apiKey.trim()) ? apiKey.trim() : null;
      if (modelName !== undefined) runtimeConfig.modelName = (modelName && modelName.trim()) ? modelName.trim() : null;
      if (enableLLM !== undefined) runtimeConfig.enableLLM = !!enableLLM;
      if (piiMask !== undefined) runtimeConfig.piiMask = !!piiMask;
      if (fastModel !== undefined) runtimeConfig.fastModel = (fastModel && fastModel.trim()) ? fastModel.trim() : null;
      console.log(`[AI Config] 已更新: model=${runtimeConfig.modelName||'默认'} enableLLM=${runtimeConfig.enableLLM} piiMask=${runtimeConfig.piiMask} fastModel=${runtimeConfig.fastModel||'无'}`);
      persistAiConfig();
      res.json({ code: 0, message: '配置已保存', data: { modelName: runtimeConfig.modelName, enableLLM: runtimeConfig.enableLLM, piiMask: runtimeConfig.piiMask, fastModel: runtimeConfig.fastModel, hasKey: !!runtimeConfig.apiKey } });
    } catch (e) {
      res.json({ code: 1, message: e.message });
    }
  });

  // GET /api/ai/config - 获取配置
  router.get('/api/ai/config', authMiddleware, (req, res) => {
    res.json({
      code: 0,
      data: {
        baseUrl: runtimeConfig.baseUrl || process.env.ZHIPU_AI_BASE_URL || null,
        modelName: runtimeConfig.modelName || process.env.ZHIPU_AI_MODEL || 'glm-4-flash',
        enableLLM: runtimeConfig.enableLLM !== false,
        piiMask: !!runtimeConfig.piiMask,
        fastModel: runtimeConfig.fastModel || 'glm-4-flash',
        hasKey: !!runtimeConfig.apiKey
      }
    });
  });

  // GET /api/ai/test - 测试连接
  router.get('/api/ai/test', authMiddleware, async (req, res) => {
    if (!runtimeConfig.enableLLM) return res.json({ code: 1, message: '大模型功能已关闭' });
    const cfg = runtimeConfig;
    const apiKey = cfg.apiKey || process.env.ZHIPU_AI_API_KEY;
    if (!apiKey || apiKey.trim() === '' || apiKey === '你的_api_key_here') {
      return res.json({ code: 1, message: '未配置 API Key' });
    }
    try {
      const answer = await llmClient.callLLM('你好，请用一句话介绍自己', '', [], apiKey, cfg.baseUrl || 'https://open.bigmodel.cn/api/paas/v4', cfg.modelName || 'glm-4-flash', 30000, false);
      if (answer) {
        res.json({ code: 0, message: `连接成功！模型 ${cfg.modelName || 'glm-4-flash'} 已就绪。回复: ${(answer || '').substring(0, 80)}` });
      } else {
        res.json({ code: 1, message: '连接失败：未收到有效回复' });
      }
    } catch (err) {
      res.json({ code: 1, message: `连接失败: ${err.message?.substring(0, 100)}` });
    }
  });

  return router;
}

module.exports = { initChatSubRouter: initChatSubRouter };
