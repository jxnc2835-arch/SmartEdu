/**
 * AI 提示词构建模块
 * 处理意图路由、本地答案生成、防幻觉校验
 */

function routeIntent(question, sessionCtx) {
  const q = (question || '').toLowerCase().trim();
  // 简化版：实际实现需包含完整意图路由逻辑
  return {
    intent: 'general',
    classFilter: '',
    courseFilter: '',
    dateRef: { kind: 'today', date: new Date().toISOString().slice(0, 10) },
    param: null
  };
}

function buildStructuredContext(data) {
  if (!data || typeof data !== 'object') return '';
  return JSON.stringify(data, null, 2);
}

function summarizeDataForLLM(data) {
  if (!data || typeof data !== 'object') return '';
  return JSON.stringify(data).slice(0, 2000);
}

function collectAllowed(obj) {
  const names = new Set(), classes = new Set(), dorms = new Set();
  const walk = (o) => {
    if (o == null || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    for (const k in o) {
      const v = o[k];
      if (k === 'name' || k === 'student_name') { if (v) names.add(String(v)); }
      else if (k === 'class_name') { if (v) classes.add(String(v)); }
      else if (k === 'dorm') { if (v) dorms.add(String(v)); }
      else if (typeof v === 'object') walk(v);
    }
  };
  walk(obj);
  return { names: [...names], classes: [...classes], dorms: [...dorms] };
}

function verifyGrounded(answer, allowed) {
  if (!answer) return true;
  // 简化版：实际实现需包含完整防幻觉逻辑
  return true;
}

function formatLocalAnswer(intentResult, data, _rawQuestion) {
  return '本地分析引擎暂不支持该问题，请联系管理员。';
}

function buildClarify(question, timeDesc) {
  return `💬 请明确您的问题，例如："今天签到率怎么样？"或"哪些学生是高风险？"`;
}

function getSuggestions(intent) {
  const map = {
    today: ['今天未归学生是谁？', '高风险学生有哪些？'],
    general: ['今天签到率怎么样？', '帮我写一条提醒短信']
  };
  return map[intent] || map.general;
}

module.exports = {
  routeIntent,
  buildStructuredContext,
  summarizeDataForLLM,
  collectAllowed,
  verifyGrounded,
  formatLocalAnswer,
  buildClarify,
  getSuggestions
};
