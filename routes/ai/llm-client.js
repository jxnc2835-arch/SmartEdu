/**
 * AI LLM 客户端模块 - 增强版
 * 包含 handleAiQuestion, callLLM, askZhipu 等核心函数
 */
const axios = require('axios');
const { resolveDateRef, dateRefDate, dateRefEnd, dateRefDays, dateRefRange, fmtDate } = require('./date-utils');

/**
 * 处理 AI 问答请求（主入口）
 */
async function handleAiQuestion(question, sid, ctx) {
  const { db, runtimeConfig, getSessionHistory, addMessage, updateSessionContext,
          routeIntent, loadDataForIntent, formatLocalAnswer, getSuggestions, broadcast } = ctx;

  const t0 = Date.now();
  const session = sid ? getSessionHistory(sid) : null;
  const intentResult = routeIntent(question, session || {});
  
  // 加载数据
  const data = loadDataForIntent(intentResult, session || {});
  
  // 更新会话上下文
  if (session) {
    updateSessionContext(sid, {
      lastIntent: intentResult.intent,
      lastClassFilter: intentResult.classFilter || '',
      lastQuestion: question,
      lastData: data
    });
  }
  
  // 记录用户消息
  if (sid) addMessage(sid, 'user', question);
  
  // 判断是否走 LLM
  const forceLocal = ['report', 'explain', 'clarify', 'self_intro', 'general'].includes(intentResult.intent);
  let llmResult = null;
  
  if (!forceLocal && runtimeConfig.enableLLM) {
    llmResult = await askZhipu(question, { intent: intentResult.intent, ...data }, 
      session ? session.messages : [], runtimeConfig);
  }
  
  let aiAnswer = llmResult?.answer || null;
  
  // 生成最终答案
  let finalAnswer;
  if (intentResult.intent === 'report') {
    // PDF 报告生成（简化版）
    finalAnswer = '报告生成功能开发中，请联系管理员。';
  } else {
    finalAnswer = aiAnswer || formatLocalAnswer(intentResult, data, question);
  }
  
  // 记录 AI 消息
  if (aiAnswer && sid) addMessage(sid, 'ai', aiAnswer);
  
  console.log(`[AI] 总耗时=${Date.now() - t0}ms source=${aiAnswer ? 'ai' : 'local'}`);
  
  return {
    code: 0,
    data: {
      answer: finalAnswer,
      intent: intentResult.intent,
      source: aiAnswer ? 'ai' : 'local_engine',
      modelInfo: aiAnswer ? { model: llmResult?.modelName || 'glm-4-flash', provider: 'zhipu' } : null,
      suggestions: getSuggestions(intentResult.intent)
    }
  };
}

/**
 * 调用智谱 LLM
 */
async function askZhipu(question, dataContext, history, runtimeConfig) {
  const cfg = runtimeConfig;
  const apiKey = cfg.apiKey || process.env.ZHIPU_AI_API_KEY;
  const baseUrl = cfg.baseUrl || process.env.ZHIPU_AI_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';
  const userModel = cfg.modelName || process.env.ZHIPU_AI_MODEL || 'glm-4-flash';
  
  if (!apiKey || apiKey.trim() === '' || apiKey === '你的_api_key_here') {
    return null;
  }
  
  const isGeneral = !!(dataContext && dataContext.intent === 'general');
  let contextText = isGeneral ? '' : JSON.stringify(dataContext).slice(0, 2000);
  
  const modelsToTry = [
    { model: userModel, timeout: 60000, retries: 0 },
    { model: 'glm-4-flash', timeout: 30000, retries: 1, fallback: true }
  ];
  
  for (const { model: modelName, timeout: timeoutMs, retries, fallback } of modelsToTry) {
    if (!modelName) continue;
    try {
      const answer = await callLLM(question, contextText, history, apiKey, baseUrl, modelName, timeoutMs, isGeneral);
      if (answer) {
        return { answer, modelName: fallback ? modelName + '（降级）' : modelName, degraded: !!fallback };
      }
    } catch (err) {
      if (retries > 0) continue;
      break;
    }
  }
  return null;
}

/**
 * 调用 LLM API
 */
async function callLLM(question, contextText, history, apiKey, baseUrl, modelName, timeoutMs = 30000, generalMode = false) {
  const systemPrompt = generalMode
    ? '你是学工小智，同时是通用知识助手。请自然回答用户问题。'
    : `你是一位经验丰富、说话接地气的高校辅导员AI助手"学工小智"。你的用户是**辅导员或老师**。

【核心铁律】
1. 所有数据必须来自下方的【系统实时数据】，绝对禁止编造姓名、班级、人数、比例。
2. 用户追问具体名单时，必须逐条列出完整姓名、班级、宿舍等关键信息。
3. 像真人对话：开头可以直接回应、感叹、提问，不要总以"根据数据显示..."开头。
4. 关键结论和数据用 **加粗** 标出。

当前系统业务日期：${fmtDate(new Date())}

【系统实时数据】
\`\`\`json
${contextText || '（暂无额外数据）'}
\`\`\``;

  const messages = [{ role: 'system', content: systemPrompt }];
  
  if (history && history.length > 0) {
    const recentHistory = history.slice(-4).map(m => ({
      role: m.role === 'ai' ? 'assistant' : m.role,
      content: m.content && m.content.length > 400 ? m.content.slice(0, 400) + '...' : m.content
    }));
    messages.push(...recentHistory);
  }
  
  messages.push({ role: 'user', content: question });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const response = await axios.post(
      `${baseUrl.replace(/\/$/, '')}/chat/completions`,
      { model: modelName, messages, temperature: 0.7, max_tokens: 2000 },
      { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, signal: controller.signal, timeout: timeoutMs }
    );
    clearTimeout(timer);
    return response.data.choices?.[0]?.message?.content || null;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

module.exports = {
  handleAiQuestion,
  askZhipu,
  callLLM
};
