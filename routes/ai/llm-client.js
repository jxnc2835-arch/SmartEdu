/**
 * AI LLM 客户端模块 - 增强版
 * 包含 handleAiQuestion, callLLM, askZhipu 等核心函数
 */
const axios = require('axios');
const { fmtDate } = require('./date-utils');

/**
 * 处理 AI 问答请求（主入口）
 */
async function handleAiQuestion(question, sid, ctx) {
  const { _db, runtimeConfig, getSessionHistory, addMessage, updateSessionContext,
          routeIntent, loadDataForIntent, formatLocalAnswer, getSuggestions, _broadcast,
          db, scheduleSave, localDateStr } = ctx;

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
  // 本地引擎优先：所有数据查询类意图（today/absent_list/high_risk/trend/class_compare/dorm/
  // search/leave/course/alerts/advice/report/explain/clarify/self_intro/写作）本地渲染已详尽，
  // 一律秒回且防大模型自由发挥；仅开放性 general 闲聊走 LLM 增强
  const forceLocal = intentResult.intent !== 'general';
  const ambiguousSearch = false;
  let llmResult = null;

  if (!forceLocal && !ambiguousSearch && runtimeConfig.enableLLM) {
    llmResult = await askZhipu(question, { intent: intentResult.intent, ...data }, 
      session ? session.messages : [], runtimeConfig);
  }
  
  const aiAnswer = llmResult?.answer || null;
  
  // P2·实用性：LLM 调用成功后落 ai_usage 表（记录 token 用量，供教师端"AI 用量"卡片与成本核算）
  if (llmResult && llmResult.answer) {
    try {
      const dbHandle = ctx.db; // ctx 实际注入的是 db 字段
      if (dbHandle && typeof dbHandle.run === 'function') {
        const usage = llmResult.usage || { prompt_tokens: 0, completion_tokens: 0 };
        const inputTok = usage.prompt_tokens || 0;
        const outputTok = usage.completion_tokens || 0;
        // cost 暂记 0（按模型单价估算需配置，先记 0 不影响展示）
        const uid = 'aiu_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
        dbHandle.run(
          "INSERT INTO ai_usage(id, date, model, input_tokens, output_tokens, cost, created_at) VALUES(?,?,?,?,?,?,?)",
          [uid, (localDateStr ? localDateStr() : fmtDate(new Date())), llmResult.modelName || 'glm-4-flash', inputTok, outputTok, 0, new Date().toISOString()]
        );
        if (typeof ctx.scheduleSave === 'function') ctx.scheduleSave();
      }
    } catch (e) {
      console.warn('[AI Usage] 落表失败（不影响问答）:', e.message);
    }
  }
  
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
  const dataEnd = (dataContext && dataContext.dataEnd) || '';
  const contextText = isGeneral ? '' : JSON.stringify(dataContext).slice(0, 2000);

  const modelsToTry = [
    { model: userModel, timeout: 60000, retries: 0 },
    { model: 'glm-4-flash', timeout: 30000, retries: 1, fallback: true }
  ];

  for (const { model: modelName, timeout: timeoutMs, retries, fallback } of modelsToTry) {
    if (!modelName) continue;
    try {
      const r = await callLLM(question, contextText, history, apiKey, baseUrl, modelName, timeoutMs, isGeneral, dataEnd);
      if (r?.answer) {
        return {
          answer: r.answer,
          modelName: fallback ? modelName + '（降级）' : modelName,
          degraded: !!fallback,
          usage: r.usage || null
        };
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
async function callLLM(question, contextText, history, apiKey, baseUrl, modelName, timeoutMs = 30000, generalMode = false, dataEnd = '') {
  const dataNote = dataEnd ? `查寝数据库的最新日期为 **${dataEnd}**` : '暂无数据日期信息';
  const systemPrompt = generalMode
    ? `你是高校学生查寝系统"学管 SmartEdu"的 AI 助手"学工小智"，用户是辅导员/老师。${dataNote}（系统真实数据库，**不是**模拟/示例数据）。
用户当前问的是通用或闲聊类问题，请自然、简洁地回答；若问题涉及系统内数据而你手上没有数据，请引导老师换具体问法（例如"今天签到率怎么样""查一下某同学的情况""近30天哪些学生缺勤多"）。
【铁律】绝不编造系统数据、姓名、日期或统计数字；绝不声称系统数据是模拟的、示例的或未接入的。`
    : `你是一位经验丰富、说话接地气的高校辅导员AI助手"学工小智"。你的用户是**辅导员或老师**。

【核心铁律】
1. 所有数据必须来自下方的【系统实时数据】，绝对禁止编造姓名、班级、人数、比例。
2. 【系统实时数据】是查寝系统**真实数据库**的查询结果，不是模拟/示例数据——绝不允许向用户声称数据是模拟的、示例的或"未接入真实数据"。
3. ${dataNote}；若用户问到的日期超出该范围，如实说明"数据只到该日"。
4. 若数据为空或不足以回答，直接说"暂查不到相关数据"并建议换具体问法，禁止编造任何数字或名单。
5. 用户追问具体名单时，必须逐条列出完整姓名、班级、宿舍等关键信息。
6. 像真人对话：开头可以直接回应、感叹、提问，不要总以"根据数据显示..."开头。
7. 关键结论和数据用 **加粗** 标出。

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
    const answer = response.data.choices?.[0]?.message?.content || null;
    // P2·实用性：返回 token 用量，供上层落 ai_usage 表
    const usage = response.data.usage || { prompt_tokens: 0, completion_tokens: 0 };
    return { answer, usage, modelName };
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
